import { afterAll, describe, expect, test } from "bun:test";
import { buildPlan, detectStack } from "../src/cli/init.ts";
import { parseWorkflow } from "../src/workflow/load.ts";
import type { ProfileName } from "../src/workflow/types.ts";
import { cleanupTempProjects, tempProject, writeFile } from "./helpers.ts";

afterAll(cleanupTempProjects);

const PERFIS: ProfileName[] = ["strict", "lean", "gate-only"];
const STACKS = ["node", "bun", "ruby", "python", "go", "generic"];

/**
 * Todo perfil e todo stack pack que o `psh init` pode gerar passa pelo loader
 * real. Sem isto, um erro em `ruby.json` ou em `strict.json` so apareceria na
 * maquina de quem rodasse `psh init` com aquela combinacao - o contrato
 * embarcado nao teria teste nenhum.
 */
describe("todo perfil x stack embarcado gera contrato valido", () => {
  for (const profile of PERFIS) {
    for (const stack of STACKS) {
      test(`${profile} + ${stack}`, () => {
        const layout = tempProject({ git: false });
        const plan = buildPlan(layout.root, profile, stack);

        // buildPlan ja valida por dentro; reparsear garante que o que vai para
        // o disco e exatamente o que o loader aceita na proxima abertura.
        const wf = parseWorkflow(plan.contract, `${profile}+${stack}`);
        expect(wf.profile).toBe(profile);

        if (profile === "gate-only") {
          expect(wf.phases).toHaveLength(0);
          expect(wf.entryPhase).toBeNull();
        } else {
          expect(wf.phases.length).toBeGreaterThan(0);
          expect(wf.entryPhase).not.toBeNull();
          expect(wf.phases.some((p) => p.terminal)).toBe(true);
        }

        // Nenhum check pode referenciar verificador que nao ficou no contrato.
        const declarados = new Set(wf.verifiers.map((v) => v.id));
        for (const phase of wf.phases) {
          for (const check of phase.gate.checks) {
            if (check.kind === "verifier" || check.kind === "verifier-status") {
              expect(declarados.has(check.verifier)).toBe(true);
            }
          }
          // Portao vazio nunca sobrevive a poda.
          if (phase.gate.type !== "none") expect(phase.gate.checks.length).toBeGreaterThan(0);
        }
      });
    }
  }

  test("stack sem verificador automatico troca o portao por aprovacao humana e conta a poda", () => {
    const layout = tempProject({ git: false });
    const plan = buildPlan(layout.root, "strict", "generic");

    expect(plan.checks_examined).toBeGreaterThan(0);
    expect(plan.checks_pruned.length).toBeGreaterThan(0);
    expect(plan.phases_downgraded).toContain("phase.5.build");

    const build = plan.contract.phases.find((p) => p.id === "phase.5.build")!;
    expect(build.gate.checks).toEqual([
      expect.objectContaining({ kind: "user-approval", subject: "phase:phase.5.build" }),
    ]);
  });

  test("strict em node preserva os portoes de qualidade em vez de podar tudo", () => {
    const layout = tempProject({ git: false });
    const plan = buildPlan(layout.root, "strict", "node");
    const build = plan.contract.phases.find((p) => p.id === "phase.5.build")!;
    const ids = build.gate.checks.map((c) => ("verifier" in c ? c.verifier : c.kind));

    expect(ids).toContain("tests");
    expect(ids).toContain("coverage");
    expect(ids).toContain("security-critical");
    expect(plan.phases_downgraded).not.toContain("phase.5.build");
  });

  test("o perfil strict declara fase terminal, corrigindo o next orfao do contrato de referencia", () => {
    const layout = tempProject({ git: false });
    const wf = parseWorkflow(buildPlan(layout.root, "strict", "node").contract, "<t>");
    const terminais = wf.phases.filter((p) => p.terminal);

    expect(terminais.map((p) => p.id)).toEqual(["phase.6.ux-gate"]);
    for (const phase of wf.phases) {
      for (const alvo of phase.next) expect(wf.phase(alvo)).toBeDefined();
    }
  });

  test("gate-only mantem todos os verificadores da stack para 'psh verify --all'", () => {
    const layout = tempProject({ git: false });
    const plan = buildPlan(layout.root, "gate-only", "ruby");
    const ids = (plan.contract.verifiers ?? []).map((v) => v.id);

    expect(ids).toContain("tests");
    expect(ids).toContain("coverage");
    expect(ids).toContain("spec-coverage");
  });
});

describe("deteccao de stack", () => {
  test.each([
    ["package.json", "node"],
    ["Gemfile", "ruby"],
    ["go.mod", "go"],
    ["pyproject.toml", "python"],
  ])("%s indica %s", (arquivo, esperado) => {
    const layout = tempProject({ git: false });
    writeFile(layout, arquivo, "conteudo\n");
    expect(detectStack(layout.root)).toBe(esperado);
  });

  test("bun.lock ganha de package.json, porque os dois convivem", () => {
    const layout = tempProject({ git: false });
    writeFile(layout, "package.json", "{}\n");
    writeFile(layout, "bun.lock", "\n");
    expect(detectStack(layout.root)).toBe("bun");
  });

  test("projeto sem marca conhecida cai em generic, nao em node por chute", () => {
    const layout = tempProject({ git: false });
    writeFile(layout, "leiame.md", "nada\n");
    expect(detectStack(layout.root)).toBe("generic");
  });
});

describe("extract json: a condicao que o schema nao alcanca (validada no loader)", () => {
  function contratoCom(extract: unknown): unknown {
    return {
      _type: "psh-workflow",
      version: 1,
      profile: "lean",
      verifiers: [{ id: "v", run: ["true"], extract, watch: ["src/**"], timeout_s: 10 }],
      phases: [
        {
          id: "p",
          name: "P",
          terminal: true,
          next: [],
          gate: {
            type: "all-of",
            checks: [{ kind: "verifier", verifier: "v", min: 1 }],
            on_fail: { action: "block", message: "-" },
          },
          on_failure: { class: "quality", max_auto_retries: 0 },
        },
      ],
      failure_protocol: {
        classes: {
          transient: { max_auto_retries: 3, backoff: "exponential", delays_ms: [1000], on_exhaustion: "escalate" },
          quality: { max_auto_retries: 2, backoff: "none", delays_ms: [], on_exhaustion: "escalate" },
          "user-action": { max_auto_retries: 0, backoff: "none", delays_ms: [], on_exhaustion: "block" },
          fatal: { max_auto_retries: 0, backoff: "none", delays_ms: [], on_exhaustion: "halt" },
        },
      },
    };
  }

  test("from=file sem 'file' e recusado no carregamento, nao na extracao", () => {
    expect(() => parseWorkflow(contratoCom({ kind: "json", pointer: "/a" }), "<t>")).toThrow(/precisa declarar 'file'/);
  });

  test("from=stdout com 'file' e recusado: mesmo dado em dois lugares", () => {
    expect(() =>
      parseWorkflow(contratoCom({ kind: "json", from: "stdout", file: "x.json", pointer: "/a" }), "<t>"),
    ).toThrow(/nao pode declarar 'file'/);
  });

  test("as duas formas corretas carregam", () => {
    expect(() =>
      parseWorkflow(contratoCom({ kind: "json", from: "stdout", pointer: "/a" }), "<t>"),
    ).not.toThrow();
    expect(() =>
      parseWorkflow(contratoCom({ kind: "json", from: "file", file: "r.json", pointer: "/a" }), "<t>"),
    ).not.toThrow();
  });

  test("o verificador spec-coverage embarcado usa a forma valida", () => {
    const layout = tempProject({ git: false });
    const plan = buildPlan(layout.root, "lean", "node");
    const spec = (plan.contract.verifiers ?? []).find((v) => v.id === "spec-coverage")!;
    expect(spec.extract.kind).toBe("json");
    expect(typeof (spec.extract as { file?: unknown }).file).toBe("string");
  });

  test("o contrato devolvido nao compartilha objeto com os JSON embarcados", () => {
    const layout = tempProject({ git: false });
    const a = buildPlan(layout.root, "lean", "node");
    const alvo = (a.contract.verifiers ?? []).find((v) => v.id === "spec-coverage")!;

    // Mutacao a jusante nao pode contaminar o proximo init do mesmo processo.
    (alvo.extract as Record<string, unknown>).file = { corrompido: true };
    (a.contract.phases[0] as unknown as Record<string, unknown>).name = "mexido";
    (a.contract.failure_protocol.classes.quality as unknown as Record<string, unknown>).max_auto_retries = 99;

    const b = buildPlan(layout.root, "lean", "node");
    const limpo = (b.contract.verifiers ?? []).find((v) => v.id === "spec-coverage")!;
    expect(typeof (limpo.extract as { file?: unknown }).file).toBe("string");
    expect(b.contract.phases[0]!.name).not.toBe("mexido");
    expect(b.contract.failure_protocol.classes.quality.max_auto_retries).toBe(2);
  });
});
