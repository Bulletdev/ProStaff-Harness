import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../src/util/errors.ts";
import type { WorkflowContract } from "../src/workflow/types.ts";
import { cleanupTempProjects, harnessWith, psh, tempProject, writeFile, LCOV_87 } from "./helpers.ts";

afterAll(cleanupTempProjects);

/**
 * Contrato de aceite da v0.1: um portao de cobertura alimentado por um
 * verificador que o proprio nucleo executa.
 */
const CONTRATO: Partial<WorkflowContract> & { phases: WorkflowContract["phases"] } = {
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
        checks: [{ kind: "verifier", verifier: "coverage", min: 85 }],
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

function projetoDeAceite() {
  const layout = tempProject();
  writeFile(layout, "src/a.ts", "export const a = 1;\n");
  writeFile(layout, "fixture-lcov.info", LCOV_87);
  const h = harnessWith(layout, CONTRATO);
  h.close();
  return layout;
}

describe("aceite da v0.1 pela CLI", () => {
  test("1. chamada de portao com metrica forjada falha, dizendo que metrica nao vem do chamador", () => {
    const layout = projetoDeAceite();
    const r = psh(layout, ["advance", "--coverage", "99"]);
    expect(r.code).toBe(EXIT.FORGED_INPUT);
    expect(r.err).toContain("nao aceita metrica vinda do chamador");

    for (const flag of ["--metric", "--set", "--score", "--value"]) {
      expect(psh(layout, ["advance", flag, "99"]).code).toBe(EXIT.FORGED_INPUT);
    }
    // A recusa vale para qualquer comando, nao so para advance.
    expect(psh(layout, ["status", "--coverage", "99"]).code).toBe(EXIT.FORGED_INPUT);
  });

  test("2. portao com evidencia real passa", () => {
    const layout = projetoDeAceite();

    const semEvidencia = psh(layout, ["advance"]);
    expect(semEvidencia.code).toBe(EXIT.GATE_FAILED);
    expect(semEvidencia.out).toContain("nao verificado");

    const verify = psh(layout, ["verify"]);
    expect(verify.code).toBe(EXIT.OK);
    expect(verify.out).toContain("coverage");

    const advance = psh(layout, ["advance"]);
    expect(advance.code).toBe(EXIT.OK);
    expect(advance.out).toContain("ADVANCED");

    expect(psh(layout, ["status", "--json"]).out).toContain('"phase": "fim"');
  });

  test("3. editar arquivo observado depois da verificacao faz o portao falhar por evidencia obsoleta", () => {
    const layout = projetoDeAceite();
    expect(psh(layout, ["verify"]).code).toBe(EXIT.OK);

    writeFileSync(join(layout.root, "src", "a.ts"), "export const a = 2; // editado apos verificar\n");

    const advance = psh(layout, ["advance"]);
    expect(advance.code).toBe(EXIT.GATE_FAILED);
    expect(advance.out).toContain("evidencia obsoleta");
    expect(advance.out).toContain("src/a.ts");

    // Reverificar com a arvore nova volta a valer.
    expect(psh(layout, ["verify"]).code).toBe(EXIT.OK);
    expect(psh(layout, ["advance"]).code).toBe(EXIT.OK);
  });

  test("4. remover uma linha da trilha e detectado por 'psh audit verify'", () => {
    const layout = projetoDeAceite();
    psh(layout, ["verify"]);
    psh(layout, ["advance"]);

    const antes = psh(layout, ["audit", "verify"]);
    expect(antes.code).toBe(EXIT.OK);
    expect(antes.out).toContain("cadeia integra");

    const linhas = readFileSync(layout.chainPath, "utf8").split("\n").filter((l) => l.trim() !== "");
    expect(linhas.length).toBeGreaterThanOrEqual(2);
    writeFileSync(layout.chainPath, `${linhas.slice(1).join("\n")}\n`);

    const depois = psh(layout, ["audit", "verify"]);
    expect(depois.code).toBe(EXIT.AUDIT_BROKEN);
    expect(depois.out).toContain("CADEIA COMPROMETIDA");

    // O estado tambem passa a denunciar a trilha.
    expect(psh(layout, ["status"]).out).toContain("COMPROMETIDA");
  });
});

describe("CLI: init, doctor e recusa de flag desconhecida", () => {
  test("init detecta a stack, gera contrato valido e a trilha nasce com o evento de init", () => {
    const layout = tempProject();
    writeFile(layout, "package.json", '{"name":"demo","version":"1.0.0"}\n');
    writeFile(layout, "package-lock.json", '{"lockfileVersion":3}\n');
    writeFile(layout, "src/a.js", "module.exports = 1;\n");

    const dry = psh(layout, ["init", "--profile", "lean", "--dry-run"]);
    expect(dry.code).toBe(EXIT.OK);
    expect(dry.out).toContain("stack:   node");
    expect(dry.out).toContain("--dry-run: nada foi escrito");

    const r = psh(layout, ["init", "--profile", "lean", "--yes"]);
    expect(r.code).toBe(EXIT.OK);

    const contrato = JSON.parse(readFileSync(layout.workflowPath, "utf8")) as WorkflowContract;
    expect(contrato._type).toBe("psh-workflow");
    expect(contrato.profile).toBe("lean");
    expect((contrato.verifiers ?? []).map((v) => v.id)).toContain("tests");

    const trilha = readFileSync(layout.chainPath, "utf8");
    expect(trilha).toContain("harness.init");

    const status = psh(layout, ["status"]);
    expect(status.out).toContain("perfil        lean");
    expect(status.out).toContain("fronteira     degradado");
    expect(status.out).toContain("revertida por snapshot");
  });

  test("init em stack sem verificador automatico troca o portao por aprovacao humana, e diz isso", () => {
    const layout = tempProject();
    writeFile(layout, "leiame.txt", "projeto sem stack conhecida\n");
    const r = psh(layout, ["init", "--profile", "lean", "--yes"]);
    expect(r.out).toContain("podados");
    const contrato = JSON.parse(readFileSync(layout.workflowPath, "utf8")) as WorkflowContract;
    const kinds = contrato.phases.flatMap((p) => p.gate.checks.map((c) => c.kind));
    expect(kinds).toContain("user-approval");
  });

  test("doctor declara que a fronteira existe mas esta em modo degradado", () => {
    const layout = projetoDeAceite();
    const r = psh(layout, ["doctor"]);
    expect(r.out).toContain("boundary");
    expect(r.out).toContain("modo degradado");
    expect(r.out).toContain("revertida");
    expect(r.out).toContain("audit");
  });

  test("flag desconhecida e recusada em vez de ignorada", () => {
    const layout = projetoDeAceite();
    const r = psh(layout, ["verify", "--turbo"]);
    expect(r.code).toBe(EXIT.FAILURE);
    expect(r.err).toContain("flag desconhecida");
  });

  test("comando fora de projeto inicializado orienta em vez de estourar", () => {
    const layout = tempProject({ git: false });
    const r = psh(layout, ["status"]);
    expect(r.code).toBe(EXIT.CONTRACT_INVALID);
    expect(r.err).toContain("psh init");
  });
});
