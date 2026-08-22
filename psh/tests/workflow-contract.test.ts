import { describe, expect, test } from "bun:test";
import { parseWorkflow } from "../src/workflow/load.ts";
import { ContractError } from "../src/util/errors.ts";
import failureProtocol from "../src/workflow/profiles/failure-protocol.json" with { type: "json" };
import type { WorkflowContract } from "../src/workflow/types.ts";

function contract(overrides: Partial<WorkflowContract> = {}): unknown {
  return {
    _type: "psh-workflow",
    version: 1,
    profile: "lean",
    verifiers: [
      {
        id: "tests",
        run: ["true"],
        extract: { kind: "exit-code" },
        watch: ["src/**"],
        timeout_s: 60,
      },
    ],
    phases: [
      {
        id: "a",
        name: "A",
        terminal: false,
        next: ["b"],
        gate: {
          type: "all-of",
          checks: [{ kind: "verifier-status", verifier: "tests" }],
          on_fail: { action: "rework", loopback_to: "a", message: "falhou" },
        },
        on_failure: { class: "quality", max_auto_retries: 1 },
      },
      {
        id: "b",
        name: "B",
        terminal: true,
        next: [],
        gate: { type: "none", checks: [], on_fail: { action: "block", message: "-" } },
        on_failure: { class: "quality", max_auto_retries: 0 },
      },
    ],
    failure_protocol: failureProtocol,
    ...overrides,
  };
}

describe("contrato de workflow (R1.1, R1.5b)", () => {
  test("contrato integro carrega e indexa fases e verificadores", () => {
    const wf = parseWorkflow(contract(), "<t>");
    expect(wf.phase("a")?.name).toBe("A");
    expect(wf.verifier("tests")?.timeout_s).toBe(60);
    expect(wf.entryPhase).toBe("a");
  });

  test("next apontando para fase inexistente falha no carregamento, nao em runtime", () => {
    const broken = contract() as { phases: { id: string; next: string[] }[] };
    broken.phases[0]!.next = ["phase.5.complete"];
    expect(() => parseWorkflow(broken, "<t>")).toThrow(ContractError);
    try {
      parseWorkflow(broken, "<t>");
    } catch (error) {
      expect((error as Error).message).toContain("phase.5.complete");
    }
  });

  test("gate.type fora do enum falha no schema", () => {
    const broken = contract() as { phases: { gate: { type: string } }[] };
    broken.phases[0]!.gate.type = "vibes";
    expect(() => parseWorkflow(broken, "<t>")).toThrow(ContractError);
  });

  test("fase sem next e sem terminal:true e recusada; terminal e declarado", () => {
    const broken = contract() as { phases: { id: string; next: string[]; terminal: boolean }[] };
    broken.phases[0]!.next = [];
    broken.phases[0]!.terminal = false;
    expect(() => parseWorkflow(broken, "<t>")).toThrow(/terminal/);
  });

  test("terminal com next tambem e recusado", () => {
    const broken = contract() as { phases: { terminal: boolean; next: string[] }[] };
    broken.phases[1]!.terminal = true;
    broken.phases[1]!.next = ["a"];
    expect(() => parseWorkflow(broken, "<t>")).toThrow(/terminal/);
  });

  test("verificador referenciado que nao existe falha no carregamento", () => {
    const broken = contract() as { phases: { gate: { checks: { verifier: string }[] } }[] };
    broken.phases[0]!.gate.checks[0]!.verifier = "fantasma";
    expect(() => parseWorkflow(broken, "<t>")).toThrow(/fantasma/);
  });

  test("check de valor sobre verificador exit-code e recusado", () => {
    const broken = contract() as { phases: { gate: { checks: unknown[] } }[] };
    broken.phases[0]!.gate.checks = [{ kind: "verifier", verifier: "tests", min: 85 }];
    expect(() => parseWorkflow(broken, "<t>")).toThrow(/exit-code/);
  });

  test("fase duplicada e verificador duplicado sao recusados", () => {
    const dupPhase = contract() as { phases: unknown[] };
    dupPhase.phases.push({ ...(dupPhase.phases[1] as object) });
    expect(() => parseWorkflow(dupPhase, "<t>")).toThrow(/duplicada/);

    const dupVerifier = contract() as { verifiers: unknown[] };
    dupVerifier.verifiers.push({ ...(dupVerifier.verifiers[0] as object) });
    expect(() => parseWorkflow(dupVerifier, "<t>")).toThrow(/duplicado/);
  });

  test("rework sem loopback_to e recusado", () => {
    const broken = contract() as { phases: { gate: { on_fail: Record<string, unknown> } }[] };
    delete broken.phases[0]!.gate.on_fail.loopback_to;
    expect(() => parseWorkflow(broken, "<t>")).toThrow(/loopback_to/);
  });

  test("loopback para fase inexistente e recusado", () => {
    const broken = contract() as { phases: { gate: { on_fail: Record<string, unknown> } }[] };
    broken.phases[0]!.gate.on_fail.loopback_to = "z";
    expect(() => parseWorkflow(broken, "<t>")).toThrow(/loopback_to/);
  });

  test("gate all-of sem check e gate none com check sao recusados", () => {
    const empty = contract() as { phases: { gate: { checks: unknown[] } }[] };
    empty.phases[0]!.gate.checks = [];
    expect(() => parseWorkflow(empty, "<t>")).toThrow(/sem nenhum check/);

    const noneWithChecks = contract() as { phases: { gate: { type: string; checks: unknown[] } }[] };
    noneWithChecks.phases[1]!.gate.type = "none";
    noneWithChecks.phases[1]!.gate.checks = [{ kind: "verifier-status", verifier: "tests" }];
    expect(() => parseWorkflow(noneWithChecks, "<t>")).toThrow(/nao pode declarar checks/);
  });

  test("perfil gate-only nao pode declarar fases, e os outros precisam de fase", () => {
    expect(() => parseWorkflow(contract({ profile: "gate-only" }), "<t>")).toThrow(/gate-only/);
    expect(() => parseWorkflow(contract({ profile: "lean", phases: [] }), "<t>")).toThrow(/ao menos uma fase/);
  });

  test("glob de watch invalido derruba o carregamento em vez de casar nada em silencio", () => {
    const broken = contract() as { verifiers: { watch: string[] }[] };
    broken.verifiers[0]!.watch = ["src/[unclosed"];
    expect(() => parseWorkflow(broken, "<t>")).toThrow(ContractError);
  });

  test("campo desconhecido no contrato e recusado, nao ignorado", () => {
    const broken = contract() as Record<string, unknown>;
    broken.thresholdDuplicado = 85;
    expect(() => parseWorkflow(broken, "<t>")).toThrow(ContractError);
  });
});
