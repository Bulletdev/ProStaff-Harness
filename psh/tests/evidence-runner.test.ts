import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runVerifier } from "../src/evidence/runner.ts";
import type { SandboxStatus } from "../src/evidence/sandbox.ts";
import type { VerifierSpec } from "../src/workflow/types.ts";
import { cleanupTempProjects, shellVerifier, tempProject, writeFile, LCOV_87 } from "./helpers.ts";

afterAll(cleanupTempProjects);

const DEGRADED: SandboxStatus = {
  mode: "degraded",
  detail: "teste: sem ai-jail",
  jail_bin: null,
  jail_version: null,
};
const INHERITED: SandboxStatus = {
  mode: "inherited",
  detail: "teste: sessao ja enjaulada",
  jail_bin: null,
  jail_version: null,
};

function fakeJail(root: string): SandboxStatus {
  const path = join(root, "bin", "fake-ai-jail");
  writeFileSync(
    path,
    ['#!/bin/sh', 'while [ "$1" != "--" ]; do shift; done', "shift", 'exec "$@"', ""].join("\n"),
    { mode: 0o755 },
  );
  return { mode: "ai-jail", detail: "teste: wrapper falso", jail_bin: path, jail_version: "fake-1.0" };
}

function spec(over: Partial<VerifierSpec> = {}): VerifierSpec {
  return {
    id: "probe",
    run: ["sh", "-c", "exit 0"],
    extract: { kind: "exit-code" },
    watch: ["src/**"],
    timeout_s: 30,
    ...over,
  };
}

describe("runner de verificador (R2.3, R2.10, R2.10b, R2.11)", () => {
  test("R2.10: exit code 7 chega ao nucleo como 7 nos tres modos de sandbox", () => {
    const layout = tempProject();
    writeFile(layout, "src/a.ts", "export const a = 1;\n");
    shellVerifier(layout, "noop", "true");
    const modes: SandboxStatus[] = [DEGRADED, INHERITED, fakeJail(layout.root)];

    for (const sandbox of modes) {
      const { record } = runVerifier({
        layout,
        spec: spec({ id: `probe-${sandbox.mode}`, run: ["sh", "-c", "exit 7"] }),
        phase: "p",
        attempt: 1,
        sandbox,
      });
      expect(record.exit_code).toBe(7);
      expect(record.signal).toBeNull();
      expect(record.sandbox.mode).toBe(sandbox.mode);
      expect(record.status).toBe("ok");
    }
  });

  test("R2.10b: processo morto por sinal e falha, nunca zero", () => {
    const layout = tempProject();
    writeFile(layout, "src/a.ts", "x\n");
    const { record } = runVerifier({
      layout,
      spec: spec({ run: ["sh", "-c", "kill -TERM $$"] }),
      phase: "p",
      attempt: 1,
      sandbox: DEGRADED,
    });
    expect(record.status).toBe("error");
    expect(record.error?.reason).toBe("signal");
    expect(record.exit_code).not.toBe(0);
    expect(record.value).toBeNull();
  });

  test("timeout vira erro com o processo morto, e nao produz valor", () => {
    const layout = tempProject();
    writeFile(layout, "src/a.ts", "x\n");
    const { record } = runVerifier({
      layout,
      spec: spec({ run: ["sh", "-c", "sleep 5"], timeout_s: 1 }),
      phase: "p",
      attempt: 1,
      sandbox: DEGRADED,
    });
    expect(record.status).toBe("error");
    expect(["timeout", "signal"]).toContain(record.error!.reason);
    expect(record.value).toBeNull();
  });

  test("comando que nao existe vira spawn-failed, nao valor zero", () => {
    const layout = tempProject();
    writeFile(layout, "src/a.ts", "x\n");
    const { record } = runVerifier({
      layout,
      spec: spec({ run: ["binario-que-nao-existe-psh"] }),
      phase: "p",
      attempt: 1,
      sandbox: DEGRADED,
    });
    expect(record.status).toBe("error");
    expect(record.error?.reason).toBe("spawn-failed");
    expect(record.value).toBeNull();
  });

  test("R2.11: relatorio ausente e ausencia, nunca zero", () => {
    const layout = tempProject();
    writeFile(layout, "src/a.ts", "x\n");
    const { record } = runVerifier({
      layout,
      spec: spec({
        run: ["sh", "-c", "exit 0"],
        extract: { kind: "lcov", file: "coverage/lcov.info", metric: "lines.pct" },
      }),
      phase: "p",
      attempt: 1,
      sandbox: DEGRADED,
    });
    expect(record.status).toBe("error");
    expect(record.error?.reason).toBe("report-missing");
    expect(record.value).toBeNull();
  });

  test("relatorio presente e valido produz o valor extraido", () => {
    const layout = tempProject();
    writeFile(layout, "src/a.ts", "x\n");
    writeFile(layout, "coverage/lcov.info", LCOV_87);
    const { record } = runVerifier({
      layout,
      spec: spec({
        run: ["sh", "-c", "exit 0"],
        extract: { kind: "lcov", file: "coverage/lcov.info", metric: "lines.pct" },
        watch: ["src/**"],
      }),
      phase: "p",
      attempt: 1,
      sandbox: DEGRADED,
    });
    expect(record.status).toBe("ok");
    expect(record.value).toBeCloseTo(87, 5);
    expect(record.workspace_hash).toStartWith("sha256:");
  });

  test("R2.10b: comando falhou, entao a metrica do relatorio nao e aproveitada", () => {
    const layout = tempProject();
    writeFile(layout, "src/a.ts", "x\n");
    writeFile(layout, "coverage/lcov.info", LCOV_87);
    const { record } = runVerifier({
      layout,
      spec: spec({
        run: ["sh", "-c", "exit 1"],
        extract: { kind: "lcov", file: "coverage/lcov.info", metric: "lines.pct" },
      }),
      phase: "p",
      attempt: 1,
      sandbox: DEGRADED,
    });
    expect(record.status).toBe("error");
    expect(record.error?.reason).toBe("command-failed");
    expect(record.value).toBeNull();
  });

  test("success_exit_codes declarado no contrato deixa o codigo nao-zero ser resultado", () => {
    const layout = tempProject();
    writeFile(layout, "src/a.ts", "x\n");
    const { record } = runVerifier({
      layout,
      spec: spec({
        run: ["sh", "-c", 'echo \'{"metadata":{"vulnerabilities":{"critical":2}}}\'; exit 1'],
        extract: { kind: "json", from: "stdout", pointer: "/metadata/vulnerabilities/critical" },
        success_exit_codes: [0, 1],
      }),
      phase: "p",
      attempt: 1,
      sandbox: DEGRADED,
    });
    expect(record.status).toBe("ok");
    expect(record.value).toBe(2);
  });

  test("R2.12: verificador que nao se aplica ao projeto e skipped explicito", () => {
    const layout = tempProject();
    writeFile(layout, "src/a.ts", "x\n");
    const { record } = runVerifier({
      layout,
      spec: spec({ applies_when_exists: ["Gemfile", "go.mod"] }),
      phase: "p",
      attempt: 1,
      sandbox: DEGRADED,
    });
    expect(record.status).toBe("skipped");
    expect(record.error?.reason).toBe("not-applicable");
    expect(record.value).toBeNull();
  });

  test("R2.13: watch sem nenhum candidato e falha de configuracao, nao resultado limpo", () => {
    const layout = tempProject();
    writeFile(layout, "src/a.ts", "x\n");
    const { record } = runVerifier({
      layout,
      spec: spec({ watch: ["nao/existe/**"] }),
      phase: "p",
      attempt: 1,
      sandbox: DEGRADED,
    });
    expect(record.status).toBe("error");
    expect(record.error?.reason).toBe("no-candidates");
    expect(record.candidates_examined).toBeGreaterThan(0);
  });

  test("arquivo observado alterado durante a corrida vira erro nomeando o arquivo", () => {
    const layout = tempProject();
    writeFile(layout, "src/a.ts", "antes\n");
    const { record } = runVerifier({
      layout,
      spec: spec({ run: ["sh", "-c", "echo depois > src/a.ts"] }),
      phase: "p",
      attempt: 1,
      sandbox: DEGRADED,
    });
    expect(record.status).toBe("error");
    expect(record.error?.reason).toBe("workspace-mutated-during-run");
    expect(record.error?.message).toContain("src/a.ts");
  });

  test("o registro grava stdout, stderr e manifesto em disco", () => {
    const layout = tempProject();
    writeFile(layout, "src/a.ts", "x\n");
    const { record, slot } = runVerifier({
      layout,
      spec: spec({ run: ["sh", "-c", "echo ola; echo erro >&2"] }),
      phase: "p",
      attempt: 3,
      sandbox: DEGRADED,
    });
    expect(readFileSync(slot.stdoutPath, "utf8")).toContain("ola");
    expect(readFileSync(slot.stderrPath, "utf8")).toContain("erro");
    const manifest = JSON.parse(readFileSync(slot.manifestPath, "utf8")) as { files: Record<string, string> };
    expect(Object.keys(manifest.files)).toContain("src/a.ts");
    expect(record.attempt).toBe(3);
    expect(slot.recordPath).toContain(join("p", "3"));
  });
});
