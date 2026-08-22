import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateGate, assertNoForgedMetrics } from "../src/gate/evaluate.ts";
import { runVerifier } from "../src/evidence/runner.ts";
import type { SandboxStatus } from "../src/evidence/sandbox.ts";
import { ForgedInputError } from "../src/util/errors.ts";
import { sha256 } from "../src/util/hash.ts";
import type { VerifierSpec, WorkflowContract } from "../src/workflow/types.ts";
import { cleanupTempProjects, harnessWith, tempProject, writeFile, LCOV_87, LCOV_50 } from "./helpers.ts";

afterAll(cleanupTempProjects);

const DEGRADED: SandboxStatus = { mode: "degraded", detail: "teste", jail_bin: null, jail_version: null };

const COVERAGE_CONTRACT: Partial<WorkflowContract> & { phases: WorkflowContract["phases"] } = {
  profile: "lean",
  verifiers: [
    {
      id: "coverage",
      run: ["sh", "-c", "exit 0"],
      extract: { kind: "lcov", file: "coverage/lcov.info", metric: "lines.pct" },
      watch: ["src/**"],
      timeout_s: 30,
    },
  ],
  phases: [
    {
      id: "build",
      name: "Build",
      terminal: true,
      next: [],
      gate: {
        type: "all-of",
        checks: [{ kind: "verifier", verifier: "coverage", min: 85 }],
        on_fail: { action: "block", message: "cobertura abaixo do minimo" },
      },
      on_failure: { class: "quality", max_auto_retries: 1 },
    },
  ],
};

function setupCoverage(lcov: string) {
  const layout = tempProject();
  writeFile(layout, "src/a.ts", "export const a = 1;\n");
  writeFile(layout, "coverage/lcov.info", lcov);
  const h = harnessWith(layout, COVERAGE_CONTRACT);
  runVerifier({ layout, spec: h.workflow.verifier("coverage")!, phase: "build", attempt: 1, sandbox: DEGRADED });
  return h;
}

describe("portao consome apenas evidencia (R2.1, R2.4, R2.6, R2.11, R2.12)", () => {
  test("evidencia real acima do minimo aprova o portao", () => {
    const h = setupCoverage(LCOV_87);
    const gate = evaluateGate({ layout: h.layout, workflow: h.workflow, phase: h.workflow.phase("build")!, attempt: 1 });
    expect(gate.passed).toBe(true);
    expect(gate.checks[0]!.observed).toBeCloseTo(87, 5);
    expect(gate.evidence_ids).toHaveLength(1);
    h.close();
  });

  test("evidencia real abaixo do minimo reprova, dizendo o numero", () => {
    const h = setupCoverage(LCOV_50);
    const gate = evaluateGate({ layout: h.layout, workflow: h.workflow, phase: h.workflow.phase("build")!, attempt: 1 });
    expect(gate.passed).toBe(false);
    expect(gate.checks[0]!.reason).toContain("abaixo do minimo 85");
    h.close();
  });

  test("R2.1: metrica vinda do chamador e recusada antes de qualquer avaliacao", () => {
    const h = setupCoverage(LCOV_50);
    expect(() =>
      evaluateGate({
        layout: h.layout,
        workflow: h.workflow,
        phase: h.workflow.phase("build")!,
        attempt: 1,
        suppliedMetrics: { coverage: 99 },
      }),
    ).toThrow(ForgedInputError);
    h.close();
  });

  test("R2.1: assertNoForgedMetrics recusa qualquer chave e aceita vazio", () => {
    expect(() => assertNoForgedMetrics({ coverage: 99 })).toThrow(ForgedInputError);
    expect(() => assertNoForgedMetrics({})).not.toThrow();
    expect(() => assertNoForgedMetrics(null)).not.toThrow();
  });

  test("R2.12: sem registro de evidencia o portao reprova por 'nao verificado', nunca passa por omissao", () => {
    const layout = tempProject();
    writeFile(layout, "src/a.ts", "x\n");
    writeFile(layout, "coverage/lcov.info", LCOV_87);
    const h = harnessWith(layout, COVERAGE_CONTRACT);
    const gate = evaluateGate({ layout, workflow: h.workflow, phase: h.workflow.phase("build")!, attempt: 1 });
    expect(gate.passed).toBe(false);
    expect(gate.checks[0]!.reason).toContain("nao verificado");
    h.close();
  });

  test("R2.11: verificador que falhou reprova o portao e nao entrega valor", () => {
    const layout = tempProject();
    writeFile(layout, "src/a.ts", "x\n");
    const h = harnessWith(layout, COVERAGE_CONTRACT);
    runVerifier({ layout, spec: h.workflow.verifier("coverage")!, phase: "build", attempt: 1, sandbox: DEGRADED });
    const gate = evaluateGate({ layout, workflow: h.workflow, phase: h.workflow.phase("build")!, attempt: 1 });
    expect(gate.passed).toBe(false);
    expect(gate.checks[0]!.reason).toContain("report-missing");
    expect(gate.checks[0]!.observed).toBeNull();
    h.close();
  });

  test("R2.4: editar arquivo observado depois da verificacao reprova por evidencia obsoleta, nomeando o arquivo", () => {
    const h = setupCoverage(LCOV_87);
    const antes = evaluateGate({ layout: h.layout, workflow: h.workflow, phase: h.workflow.phase("build")!, attempt: 1 });
    expect(antes.passed).toBe(true);

    writeFileSync(join(h.layout.root, "src", "a.ts"), "export const a = 2; // editado depois\n");

    const depois = evaluateGate({ layout: h.layout, workflow: h.workflow, phase: h.workflow.phase("build")!, attempt: 1 });
    expect(depois.passed).toBe(false);
    expect(depois.checks[0]!.reason).toContain("evidencia obsoleta");
    expect(depois.checks[0]!.reason).toContain("src/a.ts");
    h.close();
  });

  test("R2.4: criar arquivo novo dentro do watch tambem invalida a evidencia", () => {
    const h = setupCoverage(LCOV_87);
    writeFile(h.layout, "src/b.ts", "novo\n");
    const gate = evaluateGate({ layout: h.layout, workflow: h.workflow, phase: h.workflow.phase("build")!, attempt: 1 });
    expect(gate.passed).toBe(false);
    expect(gate.checks[0]!.reason).toContain("src/b.ts");
    h.close();
  });

  test("R2.4: mexer fora do watch nao invalida a evidencia", () => {
    const h = setupCoverage(LCOV_87);
    writeFile(h.layout, "docs/leiame.md", "nada a ver\n");
    const gate = evaluateGate({ layout: h.layout, workflow: h.workflow, phase: h.workflow.phase("build")!, attempt: 1 });
    expect(gate.passed).toBe(true);
    h.close();
  });

  test("evidencia de outra tentativa nao vale para a tentativa corrente", () => {
    const h = setupCoverage(LCOV_87);
    const gate = evaluateGate({ layout: h.layout, workflow: h.workflow, phase: h.workflow.phase("build")!, attempt: 2 });
    expect(gate.passed).toBe(false);
    expect(gate.checks[0]!.reason).toContain("nao verificado");
    h.close();
  });
});

const REVIEW_CONTRACT: Partial<WorkflowContract> & { phases: WorkflowContract["phases"] } = {
  profile: "lean",
  verifiers: [],
  phases: [
    {
      id: "requisitos",
      name: "Requisitos",
      terminal: true,
      next: [],
      gate: {
        type: "all-of",
        checks: [
          { kind: "review-score", file: ".harness/reviews/prd.review.json", target: ".harness/PRD.md", min: 80 },
        ],
        on_fail: { action: "block", message: "PRD abaixo do score" },
      },
      on_failure: { class: "quality", max_auto_retries: 1 },
    },
  ],
};

function writeReview(layout: ReturnType<typeof tempProject>, body: string, score: number, hash?: string) {
  writeFile(layout, ".harness/PRD.md", body);
  writeFile(
    layout,
    ".harness/reviews/prd.review.json",
    JSON.stringify({
      _type: "psh-review",
      version: 1,
      target: ".harness/PRD.md",
      target_sha256: hash ?? `sha256:${sha256(body)}`,
      score,
      reviewer: "prd-reviewer",
      reviewed_at: new Date().toISOString(),
    }),
  );
}

describe("portao de score por LLM (R2.6)", () => {
  test("score alto com hash batendo aprova", () => {
    const layout = tempProject();
    writeReview(layout, "# PRD\nconteudo\n", 90);
    const h = harnessWith(layout, REVIEW_CONTRACT);
    const gate = evaluateGate({ layout, workflow: h.workflow, phase: h.workflow.phase("requisitos")!, attempt: 1 });
    expect(gate.passed).toBe(true);
    h.close();
  });

  test("review de documento ja modificado nao vale", () => {
    const layout = tempProject();
    writeReview(layout, "# PRD\nconteudo\n", 90);
    writeFile(layout, ".harness/PRD.md", "# PRD\nconteudo reescrito depois da review\n");
    const h = harnessWith(layout, REVIEW_CONTRACT);
    const gate = evaluateGate({ layout, workflow: h.workflow, phase: h.workflow.phase("requisitos")!, attempt: 1 });
    expect(gate.passed).toBe(false);
    expect(gate.checks[0]!.reason).toContain("ja modificado");
    h.close();
  });

  test("review sem hash valido e recusada pelo schema, nao aceita por descuido", () => {
    const layout = tempProject();
    writeReview(layout, "# PRD\n", 90, "nao-e-hash");
    const h = harnessWith(layout, REVIEW_CONTRACT);
    const gate = evaluateGate({ layout, workflow: h.workflow, phase: h.workflow.phase("requisitos")!, attempt: 1 });
    expect(gate.passed).toBe(false);
    expect(gate.checks[0]!.reason).toContain("review invalido");
    h.close();
  });

  test("score abaixo do minimo reprova mesmo com hash correto", () => {
    const layout = tempProject();
    writeReview(layout, "# PRD\n", 60);
    const h = harnessWith(layout, REVIEW_CONTRACT);
    const gate = evaluateGate({ layout, workflow: h.workflow, phase: h.workflow.phase("requisitos")!, attempt: 1 });
    expect(gate.passed).toBe(false);
    expect(gate.checks[0]!.reason).toContain("60");
    h.close();
  });

  test("arquivo de review ausente reprova", () => {
    const layout = tempProject();
    writeFile(layout, ".harness/PRD.md", "# PRD\n");
    const h = harnessWith(layout, REVIEW_CONTRACT);
    const gate = evaluateGate({ layout, workflow: h.workflow, phase: h.workflow.phase("requisitos")!, attempt: 1 });
    expect(gate.passed).toBe(false);
    expect(gate.checks[0]!.reason).toContain("ausente");
    h.close();
  });
});

describe("aprovacao humana amarrada ao conteudo", () => {
  const APPROVAL_CONTRACT: Partial<WorkflowContract> & { phases: WorkflowContract["phases"] } = {
    profile: "lean",
    verifiers: [],
    phases: [
      {
        id: "briefing",
        name: "Briefing",
        terminal: true,
        next: [],
        gate: {
          type: "all-of",
          checks: [{ kind: "user-approval", subject: "brief.md" }],
          on_fail: { action: "block", message: "aguardando aprovacao" },
        },
        on_failure: { class: "user-action", max_auto_retries: 0 },
      },
    ],
  };

  test("sem aprovacao o portao bloqueia; com aprovacao passa; reescrever invalida", () => {
    const layout = tempProject();
    writeFile(layout, "brief.md", "texto original\n");
    const h = harnessWith(layout, APPROVAL_CONTRACT);
    const phase = h.workflow.phase("briefing")!;

    expect(evaluateGate({ layout, workflow: h.workflow, phase, attempt: 1 }).passed).toBe(false);

    const approvalDir = layout.approvalsDir;
    writeFileSync(
      join(approvalDir, `${sha256("brief.md").slice(0, 32)}.json`),
      JSON.stringify({
        _type: "psh-approval",
        version: 1,
        subject: "brief.md",
        subject_sha256: `sha256:${sha256("texto original\n")}`,
        approver: "humano",
        approved_at: new Date().toISOString(),
      }),
    );
    expect(evaluateGate({ layout, workflow: h.workflow, phase, attempt: 1 }).passed).toBe(true);

    writeFileSync(join(layout.root, "brief.md"), "texto trocado depois da aprovacao\n");
    const depois = evaluateGate({ layout, workflow: h.workflow, phase, attempt: 1 });
    expect(depois.passed).toBe(false);
    expect(depois.checks[0]!.reason).toContain("mudou depois da aprovacao");
    h.close();
  });
});

const STATUS_CONTRACT: Partial<WorkflowContract> & { phases: WorkflowContract["phases"] } = {
  profile: "lean",
  verifiers: [
    {
      id: "tests",
      run: ["sh", "-c", "exit 0"],
      extract: { kind: "exit-code" },
      watch: ["src/**"],
      timeout_s: 30,
    },
  ],
  phases: [
    {
      id: "build",
      name: "Build",
      terminal: true,
      next: [],
      gate: {
        type: "all-of",
        checks: [{ kind: "verifier-status", verifier: "tests" }],
        on_fail: { action: "block", message: "suite reprovou" },
      },
      on_failure: { class: "quality", max_auto_retries: 1 },
    },
  ],
};

function comStatus(run: string[], over: Partial<VerifierSpec> = {}) {
  const layout = tempProject();
  writeFile(layout, "src/a.ts", "x\n");
  const contract = structuredClone(STATUS_CONTRACT);
  contract.verifiers![0] = { ...contract.verifiers![0]!, run, ...over };
  const h = harnessWith(layout, contract);
  runVerifier({ layout, spec: h.workflow.verifier("tests")!, phase: "build", attempt: 1, sandbox: DEGRADED });
  return h;
}

describe("portao por codigo de saida (R2.10b, R2.12)", () => {
  test("suite verde aprova", () => {
    const h = comStatus(["sh", "-c", "exit 0"]);
    expect(evaluateGate({ layout: h.layout, workflow: h.workflow, phase: h.workflow.phase("build")!, attempt: 1 }).passed).toBe(true);
    h.close();
  });

  test("suite vermelha reprova, e o codigo de saida aparece na razao", () => {
    const h = comStatus(["sh", "-c", "exit 3"]);
    const gate = evaluateGate({ layout: h.layout, workflow: h.workflow, phase: h.workflow.phase("build")!, attempt: 1 });
    expect(gate.passed).toBe(false);
    expect(gate.checks[0]!.reason).toContain("3");
    h.close();
  });

  test("processo morto por sinal reprova, nunca vira sucesso", () => {
    const h = comStatus(["sh", "-c", "kill -TERM $$"]);
    const gate = evaluateGate({ layout: h.layout, workflow: h.workflow, phase: h.workflow.phase("build")!, attempt: 1 });
    expect(gate.passed).toBe(false);
    expect(gate.checks[0]!.reason).toContain("signal");
    h.close();
  });

  test("verificador nao aplicavel deixa o portao reprovar por 'nao verificado'", () => {
    const h = comStatus(["sh", "-c", "exit 0"], { applies_when_exists: ["Gemfile"] });
    const gate = evaluateGate({ layout: h.layout, workflow: h.workflow, phase: h.workflow.phase("build")!, attempt: 1 });
    expect(gate.passed).toBe(false);
    expect(gate.checks[0]!.reason).toContain("skipped");
    h.close();
  });

  test("editar arquivo observado depois invalida tambem o portao por codigo de saida", () => {
    const h = comStatus(["sh", "-c", "exit 0"]);
    writeFile(h.layout, "src/a.ts", "editado\n");
    const gate = evaluateGate({ layout: h.layout, workflow: h.workflow, phase: h.workflow.phase("build")!, attempt: 1 });
    expect(gate.passed).toBe(false);
    expect(gate.checks[0]!.reason).toContain("evidencia obsoleta");
    h.close();
  });

  test("sem evidencia nenhuma, portao por codigo de saida tambem reprova", () => {
    const layout = tempProject();
    writeFile(layout, "src/a.ts", "x\n");
    const h = harnessWith(layout, STATUS_CONTRACT);
    const gate = evaluateGate({ layout, workflow: h.workflow, phase: h.workflow.phase("build")!, attempt: 1 });
    expect(gate.passed).toBe(false);
    expect(gate.checks[0]!.reason).toContain("nao verificado");
    h.close();
  });
});

describe("composicao de portao e checks de presenca", () => {
  test("any-of aprova com um check verde; all-of nao", () => {
    const layout = tempProject();
    writeFile(layout, "existe.md", "linha unica\n");
    const base: Partial<WorkflowContract> & { phases: WorkflowContract["phases"] } = {
      profile: "lean",
      verifiers: [],
      phases: [
        {
          id: "p",
          name: "P",
          terminal: true,
          next: [],
          gate: {
            type: "any-of",
            checks: [
              { kind: "presence", file: "existe.md", min_lines: 1 },
              { kind: "presence", file: "nao-existe.md", min_lines: 1 },
            ],
            on_fail: { action: "block", message: "nenhum artefato presente" },
          },
          on_failure: { class: "quality", max_auto_retries: 0 },
        },
      ],
    };
    const h = harnessWith(layout, base);
    expect(evaluateGate({ layout, workflow: h.workflow, phase: h.workflow.phase("p")!, attempt: 1 }).passed).toBe(true);
    h.close();

    const layout2 = tempProject();
    writeFile(layout2, "existe.md", "linha unica\n");
    const estrito = structuredClone(base);
    estrito.phases[0]!.gate.type = "all-of";
    const h2 = harnessWith(layout2, estrito);
    expect(evaluateGate({ layout: layout2, workflow: h2.workflow, phase: h2.workflow.phase("p")!, attempt: 1 }).passed).toBe(false);
    h2.close();
  });

  test("presence por bytes reprova arquivo curto demais", () => {
    const layout = tempProject();
    writeFile(layout, "curto.md", "oi");
    const h = harnessWith(layout, {
      profile: "lean",
      verifiers: [],
      phases: [
        {
          id: "p",
          name: "P",
          terminal: true,
          next: [],
          gate: {
            type: "all-of",
            checks: [{ kind: "presence", file: "curto.md", min_bytes: 100 }],
            on_fail: { action: "block", message: "curto" },
          },
          on_failure: { class: "quality", max_auto_retries: 0 },
        },
      ],
    });
    const gate = evaluateGate({ layout, workflow: h.workflow, phase: h.workflow.phase("p")!, attempt: 1 });
    expect(gate.passed).toBe(false);
    expect(gate.checks[0]!.reason).toContain("bytes");
    h.close();
  });

  test("gate 'none' aprova sem check nenhum", () => {
    const layout = tempProject();
    const h = harnessWith(layout, {
      profile: "lean",
      verifiers: [],
      phases: [
        {
          id: "p",
          name: "P",
          terminal: true,
          next: [],
          gate: { type: "none", checks: [], on_fail: { action: "block", message: "-" } },
          on_failure: { class: "quality", max_auto_retries: 0 },
        },
      ],
    });
    expect(evaluateGate({ layout, workflow: h.workflow, phase: h.workflow.phase("p")!, attempt: 1 }).passed).toBe(true);
    h.close();
  });
});
