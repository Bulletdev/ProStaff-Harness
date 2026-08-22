import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { advance } from "../src/workflow/advance.ts";
import { HarnessDb } from "../src/db/index.ts";
import { AuditChain } from "../src/audit/chain.ts";
import { loadWorkflow } from "../src/workflow/load.ts";
import { readState } from "../src/workflow/state.ts";
import { PshError } from "../src/util/errors.ts";
import type { WorkflowContract } from "../src/workflow/types.ts";
import { cleanupTempProjects, harnessWith, tempProject, writeFile } from "./helpers.ts";

afterAll(cleanupTempProjects);

/** Portao que sempre reprova: o arquivo exigido nunca e criado. */
function alwaysFailing(maxRetries: number): Partial<WorkflowContract> & { phases: WorkflowContract["phases"] } {
  return {
    profile: "lean",
    verifiers: [],
    phases: [
      {
        id: "build",
        name: "Build",
        terminal: false,
        next: ["fim"],
        gate: {
          type: "all-of",
          checks: [{ kind: "presence", file: "artefato-que-nao-existe.md", min_lines: 1 }],
          on_fail: { action: "rework", loopback_to: "build", message: "artefato ausente" },
        },
        on_failure: { class: "quality", max_auto_retries: maxRetries, loopback_to: "build" },
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

describe("protocolo de falha e contador de tentativa (R1.4, R1.5)", () => {
  test("teste obrigatorio: duas chamadas com portao reprovado produzem rework e depois escalate, com o contador em disco", () => {
    const layout = tempProject();
    const h = harnessWith(layout, alwaysFailing(1));

    const primeira = advance({ layout, workflow: h.workflow, db: h.db, chain: h.chain });
    expect(primeira.decision).toBe("rework");
    expect(primeira.retries_used).toBe(1);

    // O contador precisa estar em disco antes do retorno, senao o retry nunca
    // esgota e a escalacao nunca acontece.
    h.close();
    const dbEntreChamadas = new HarnessDb(layout.dbPath);
    expect(dbEntreChamadas.getAttempt("build")).toMatchObject({ retries_used: 1, attempt: 2 });
    dbEntreChamadas.close();
    expect(readState(layout).retries_used).toBe(1);

    const h2 = harnessWith2(layout);
    const segunda = advance({ layout, workflow: h2.workflow, db: h2.db, chain: h2.chain });
    expect(segunda.decision).toBe("escalated");
    expect(segunda.retries_used).toBe(2);
    h2.close();

    const db = new HarnessDb(layout.dbPath);
    expect(db.getAttempt("build")).toMatchObject({ retries_used: 2 });
    db.close();

    const state = readState(layout);
    expect(state.status).toBe("escalated");
    expect(state.retries_used).toBe(2);
    expect(state.history.map((h3) => h3.verdict)).toEqual(["failed", "escalated"]);
  });

  test("max_auto_retries 2 da dois reworks antes de escalar", () => {
    const layout = tempProject();
    const h = harnessWith(layout, alwaysFailing(2));
    const decisoes = [
      advance({ layout, workflow: h.workflow, db: h.db, chain: h.chain }).decision,
      advance({ layout, workflow: h.workflow, db: h.db, chain: h.chain }).decision,
      advance({ layout, workflow: h.workflow, db: h.db, chain: h.chain }).decision,
    ];
    expect(decisoes).toEqual(["rework", "rework", "escalated"]);
    expect(h.db.getAttempt("build")).toMatchObject({ retries_used: 3, attempt: 3 });
    h.close();
  });

  test("classe user-action bloqueia sem gastar retry", () => {
    const layout = tempProject();
    const contract = alwaysFailing(0);
    contract.phases[0]!.on_failure = { class: "user-action", max_auto_retries: 0 };
    contract.phases[0]!.gate.on_fail = { action: "block", message: "aguardando humano" };
    const h = harnessWith(layout, contract);

    const outcome = advance({ layout, workflow: h.workflow, db: h.db, chain: h.chain });
    expect(outcome.decision).toBe("blocked");
    expect(readState(layout).status).toBe("blocked");
    // Bloqueio nao gasta tentativa: a evidencia da tentativa corrente continua valendo.
    expect(h.db.getAttempt("build")).toMatchObject({ attempt: 1, retries_used: 1 });
    h.close();
  });

  test("R1.4: cada transicao gera evento com veredito e ponteiro para a evidencia", () => {
    const layout = tempProject();
    const h = harnessWith(layout, alwaysFailing(1));
    const outcome = advance({ layout, workflow: h.workflow, db: h.db, chain: h.chain });

    const events = h.db.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: outcome.event_id,
      kind: "phase.transition",
      from_phase: "build",
      verdict: "rework",
      failure_class: "quality",
    });
    expect(events[0]!.audit_seq).toBeGreaterThan(0);

    const trilha = h.chain.read();
    expect(trilha.at(-1)!.type).toBe("phase.transition");
    expect(trilha.at(-1)!.payload).toMatchObject({ event_id: outcome.event_id });
    h.close();
  });

  test("portao aprovado avanca de fase e conclui no terminal", () => {
    const layout = tempProject();
    const contract = alwaysFailing(1);
    contract.phases[0]!.gate.checks = [{ kind: "presence", file: "existe.md", min_lines: 1 }];
    writeFile(layout, "existe.md", "linha\n");
    const h = harnessWith(layout, contract);

    const primeiro = advance({ layout, workflow: h.workflow, db: h.db, chain: h.chain });
    expect(primeiro.decision).toBe("advanced");
    expect(primeiro.to).toBe("fim");
    expect(readState(layout).phase).toBe("fim");

    const segundo = advance({ layout, workflow: h.workflow, db: h.db, chain: h.chain });
    expect(segundo.decision).toBe("complete");
    expect(readState(layout).status).toBe("complete");
    h.close();
  });
});

describe("override humano (R1.6)", () => {
  test("--force sem confirmacao disponivel e recusado", () => {
    const layout = tempProject();
    const h = harnessWith(layout, alwaysFailing(1));
    expect(() => advance({ layout, workflow: h.workflow, db: h.db, chain: h.chain, force: true })).toThrow(
      PshError,
    );
    h.close();
  });

  test("confirmacao negada cancela e nao mexe no estado", () => {
    const layout = tempProject();
    const h = harnessWith(layout, alwaysFailing(1));
    const antes = readFileSync(layout.statePath, "utf8");
    expect(() =>
      advance({ layout, workflow: h.workflow, db: h.db, chain: h.chain, force: true, confirm: () => false }),
    ).toThrow(/cancelado/);
    expect(readFileSync(layout.statePath, "utf8")).toBe(antes);
    h.close();
  });

  test("override confirmado nunca vira 'passed' e fica permanente no historico", () => {
    const layout = tempProject();
    const h = harnessWith(layout, alwaysFailing(1));
    let perguntou = "";
    const outcome = advance({
      layout,
      workflow: h.workflow,
      db: h.db,
      chain: h.chain,
      force: true,
      forceReason: "prazo do marco",
      confirm: (q) => {
        perguntou = q;
        return true;
      },
    });

    expect(perguntou).toContain("passed-with-override");
    expect(outcome.decision).toBe("override");

    const state = readState(layout);
    expect(state.history.at(-1)!.verdict).toBe("passed-with-override");
    expect(state.history.some((h2) => h2.verdict === "passed")).toBe(false);

    const entrada = h.chain.read().at(-1)!;
    expect(entrada.type).toBe("human.override");
    expect(entrada.payload).toMatchObject({ reason: "prazo do marco", verdict: "passed-with-override" });
    h.close();
  });
});

/** Reabre o mesmo projeto sem reescrever contrato nem estado. */
function harnessWith2(layout: ReturnType<typeof tempProject>) {
  const db = new HarnessDb(layout.dbPath);
  return {
    workflow: loadWorkflow(layout.workflowPath),
    db,
    chain: new AuditChain(layout.chainPath, { anchor: db }),
    close: () => db.close(),
  };
}
