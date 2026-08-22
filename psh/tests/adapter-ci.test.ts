import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../src/util/errors.ts";
import type { WorkflowContract } from "../src/workflow/types.ts";
import { cleanupTempProjects, harnessWith, psh, tempProject, writeFile, LCOV_87, LCOV_50 } from "./helpers.ts";
import { renderCi, runCi } from "../src/adapters/ci.ts";
import { openProject } from "../src/cli/context.ts";

afterAll(cleanupTempProjects);

function contrato(min: number): Partial<WorkflowContract> & { phases: WorkflowContract["phases"] } {
  return {
    profile: "lean",
    verifiers: [
      {
        id: "coverage",
        run: ["sh", "-c", "mkdir -p coverage && cp fixture-lcov.info coverage/lcov.info"],
        extract: { kind: "lcov", file: "coverage/lcov.info", metric: "lines.pct" },
        watch: ["src/**"],
        timeout_s: 60,
      },
    ],
    phases: [
      {
        id: "build",
        name: "Build",
        terminal: false,
        next: ["fim"],
        gate: {
          type: "all-of",
          checks: [{ kind: "verifier", verifier: "coverage", min }],
          on_fail: { action: "rework", loopback_to: "build", message: "cobertura abaixo do minimo" },
        },
        on_failure: { class: "quality", max_auto_retries: 1, loopback_to: "build" },
      },
      {
        id: "fim",
        name: "Fim",
        terminal: true,
        next: [],
        gate: { type: "none", checks: [], on_fail: { action: "block", message: "-" } },
        on_failure: { class: "quality", max_auto_retries: 0 },
      },
    ],
  };
}

function projeto(lcov: string, min = 85) {
  const layout = tempProject();
  writeFile(layout, "src/a.ts", "export const a = 1;\n");
  writeFile(layout, "fixture-lcov.info", lcov);
  harnessWith(layout, contrato(min)).close();
  return layout;
}

describe("adapter ci: headless, sem interacao, sem regra de negocio propria", () => {
  test("verifica, avalia e avanca em uma chamada, com relatorio JSON", () => {
    const layout = projeto(LCOV_87);
    const r = psh(layout, ["adapter", "ci", "--json"]);
    expect(r.code).toBe(EXIT.OK);

    const report = JSON.parse(r.out) as {
      _type: string;
      verify: { ran: { verifier: string; value: number }[] };
      gate: { passed: boolean };
      advance: { decision: string; to: string };
      audit_ok: boolean;
      boundary_engine: string;
    };
    expect(report._type).toBe("psh-ci-report");
    expect(report.verify.ran[0]).toMatchObject({ verifier: "coverage" });
    expect(report.gate.passed).toBe(true);
    expect(report.advance).toMatchObject({ decision: "advanced", to: "fim" });
    expect(report.audit_ok).toBe(true);
    // O adapter declara que o motor de fronteira nao existe, em vez de calar.
    expect(report.boundary_engine).toBe("absent");
  });

  test("portao reprovado sai com codigo de portao e nao avanca de fase", () => {
    const layout = projeto(LCOV_50);
    const r = psh(layout, ["adapter", "ci", "--json"]);
    expect(r.code).toBe(EXIT.GATE_FAILED);
    const report = JSON.parse(r.out) as { advance: { decision: string }; gate: { passed: boolean } };
    expect(report.gate.passed).toBe(false);
    expect(report.advance.decision).toBe("rework");
    expect(JSON.parse(readFileSync(layout.statePath, "utf8")).phase).toBe("build");
  });

  test("--gate-only avalia sem mexer no estado", () => {
    const layout = projeto(LCOV_87);
    const antes = readFileSync(layout.statePath, "utf8");
    const r = psh(layout, ["adapter", "ci", "--gate-only", "--json"]);
    expect(r.code).toBe(EXIT.OK);
    const report = JSON.parse(r.out) as { advance: unknown; gate: { passed: boolean } };
    expect(report.advance).toBeNull();
    expect(report.gate.passed).toBe(true);
    expect(readFileSync(layout.statePath, "utf8")).toBe(antes);
  });

  test("--skip-verify reaproveita evidencia e nao inventa uma nova", () => {
    const layout = projeto(LCOV_87);
    const semEvidencia = psh(layout, ["adapter", "ci", "--skip-verify", "--gate-only", "--json"]);
    expect(semEvidencia.code).toBe(EXIT.GATE_FAILED);
    expect(JSON.parse(semEvidencia.out).verify).toBeNull();

    psh(layout, ["verify"]);
    const comEvidencia = psh(layout, ["adapter", "ci", "--skip-verify", "--gate-only", "--json"]);
    expect(comEvidencia.code).toBe(EXIT.OK);
  });

  test("trilha comprometida ganha de qualquer outro veredito", () => {
    const layout = projeto(LCOV_87);
    psh(layout, ["verify"]);
    psh(layout, ["advance"]);
    const linhas = readFileSync(layout.chainPath, "utf8").split("\n").filter((l) => l.trim() !== "");
    expect(linhas.length).toBeGreaterThanOrEqual(2);
    // Remove a primeira entrada: as seguintes continuam encadeadas entre si, e
    // e a ancora que denuncia o buraco.
    writeFileSync(layout.chainPath, `${linhas.slice(1).join("\n")}\n`);

    const r = psh(layout, ["adapter", "ci", "--gate-only", "--skip-verify", "--json"]);
    expect(r.code).toBe(EXIT.AUDIT_BROKEN);
    expect(JSON.parse(r.out).audit_ok).toBe(false);
  });

  test("o adapter nao oferece override: CI nao tem humano para confirmar", () => {
    const layout = projeto(LCOV_50);
    expect(psh(layout, ["adapter", "ci", "--force"]).code).toBe(EXIT.FAILURE);
    expect(psh(layout, ["adapter", "ci", "--force"]).err).toContain("flag desconhecida");
  });

  test("metrica forjada tambem e recusada pelo adapter", () => {
    const layout = projeto(LCOV_50);
    const r = psh(layout, ["adapter", "ci", "--coverage", "99"]);
    expect(r.code).toBe(EXIT.FORGED_INPUT);
  });

  test("adapter desconhecido e recusado", () => {
    const layout = projeto(LCOV_87);
    const r = psh(layout, ["adapter", "opencode"]);
    expect(r.code).toBe(EXIT.FAILURE);
    expect(r.err).toContain("adapter desconhecido");
    void join;
  });
});

describe("adapter ci em processo: perfil sem fase e saida em texto", () => {
  test("perfil gate-only nao tem portao: o veredito e o resultado dos verificadores", () => {
    const layout = tempProject();
    writeFile(layout, "src/a.ts", "export const a = 1;\n");
    writeFile(layout, "fixture-lcov.info", LCOV_87);
    harnessWith(layout, {
      profile: "gate-only",
      verifiers: [
        {
          id: "coverage",
          run: ["sh", "-c", "mkdir -p coverage && cp fixture-lcov.info coverage/lcov.info"],
          extract: { kind: "lcov", file: "coverage/lcov.info", metric: "lines.pct" },
          watch: ["src/**"],
          timeout_s: 60,
        },
      ],
      phases: [],
    }).close();

    const ctx = openProject(layout.root);
    try {
      const report = runCi({ ctx });
      expect(report.phase).toBeNull();
      expect(report.gate).toBeNull();
      expect(report.advance).toBeNull();
      expect(report.verify!.ran[0]).toMatchObject({ verifier: "coverage" });
      expect(report.exit_code).toBe(EXIT.OK);
    } finally {
      ctx.close();
    }
  });

  test("verificador com erro em gate-only reprova a corrida", () => {
    const layout = tempProject();
    writeFile(layout, "src/a.ts", "x\n");
    harnessWith(layout, {
      profile: "gate-only",
      verifiers: [
        {
          id: "coverage",
          run: ["sh", "-c", "exit 0"],
          extract: { kind: "lcov", file: "coverage/lcov.info", metric: "lines.pct" },
          watch: ["src/**"],
          timeout_s: 60,
        },
      ],
      phases: [],
    }).close();

    const ctx = openProject(layout.root);
    try {
      const report = runCi({ ctx });
      expect(report.verify!.ran[0]!.error).toContain("report-missing");
      expect(report.exit_code).toBe(EXIT.FAILURE);
    } finally {
      ctx.close();
    }
  });

  test("a saida em texto nomeia verificador, portao reprovado e decisao", () => {
    const layout = projeto(LCOV_50);
    const ctx = openProject(layout.root);
    try {
      const texto = renderCi(runCi({ ctx }));
      expect(texto).toContain("adapter ci");
      expect(texto).toContain("coverage");
      expect(texto).toContain("portao REPROVADO");
      expect(texto).toContain("verifier:coverage");
      expect(texto).toContain("decisao rework");
    } finally {
      ctx.close();
    }
  });

  test("a saida em texto de uma corrida verde nao inventa reprovacao", () => {
    const layout = projeto(LCOV_87);
    const ctx = openProject(layout.root);
    try {
      const texto = renderCi(runCi({ ctx }));
      expect(texto).toContain("portao APROVADO");
      expect(texto).toContain("decisao advanced");
      expect(texto).not.toContain("REPROVADO");
    } finally {
      ctx.close();
    }
  });
});
