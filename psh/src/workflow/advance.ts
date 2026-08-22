import type { Layout } from "../util/paths.ts";
import type { HarnessDb } from "../db/index.ts";
import type { AuditChain } from "../audit/chain.ts";
import { PshError, EXIT } from "../util/errors.ts";
import { sha256 } from "../util/hash.ts";
import { evaluateGate, type GateResult } from "../gate/evaluate.ts";
import type { PhaseSpec, Workflow } from "./types.ts";
import { appendHistory, readState, writeState, type State } from "./state.ts";

export type AdvanceDecision =
  | "advanced"
  | "complete"
  | "rework"
  | "restart"
  | "blocked"
  | "escalated"
  | "halted"
  | "override";

export interface AdvanceOutcome {
  decision: AdvanceDecision;
  from: string;
  to: string | null;
  attempt: number;
  retries_used: number;
  gate: GateResult;
  event_id: string;
  message: string;
  state: State;
}

export interface AdvanceOptions {
  layout: Layout;
  workflow: Workflow;
  db: HarnessDb;
  chain: AuditChain;
  actor?: string;
  force?: boolean;
  /** R1.6: `--force` exige confirmacao interativa. */
  confirm?: (question: string) => boolean;
  forceReason?: string;
  /** Presente so para ser recusado (R2.1). */
  suppliedMetrics?: Record<string, unknown> | null;
  now?: () => Date;
}

export function advance(opts: AdvanceOptions): AdvanceOutcome {
  const { layout, workflow, db, chain } = opts;
  const now = opts.now ?? (() => new Date());
  const actor = opts.actor ?? "human:cli";
  const state = readState(layout);

  if (state.phase === null) {
    throw new PshError("perfil sem fases: nao ha o que avancar. Use 'psh verify --all'.", {
      exitCode: EXIT.FAILURE,
    });
  }
  const phase = workflow.phase(state.phase);
  if (phase === undefined) {
    throw new PshError(`fase corrente '${state.phase}' nao existe no contrato carregado`, {
      exitCode: EXIT.CONTRACT_INVALID,
    });
  }

  const counters = db.getAttempt(phase.id) ?? {
    phase: phase.id,
    attempt: state.attempt,
    retries_used: state.retries_used,
    updated_at: now().toISOString(),
  };

  const gate = evaluateGate({
    layout,
    workflow,
    phase,
    attempt: counters.attempt,
    suppliedMetrics: opts.suppliedMetrics ?? null,
  });

  if (opts.force === true) {
    return applyOverride({ ...opts, actor, now }, state, phase, gate, counters.attempt);
  }
  if (gate.passed) {
    return applyPass({ ...opts, actor, now }, state, phase, gate, counters.attempt);
  }
  return applyFailure({ ...opts, actor, now }, state, phase, gate, counters);
}

type Resolved = AdvanceOptions & { actor: string; now: () => Date };

function applyPass(
  opts: Resolved,
  state: State,
  phase: PhaseSpec,
  gate: GateResult,
  attempt: number,
): AdvanceOutcome {
  const { layout, db, chain } = opts;
  const at = opts.now().toISOString();
  const target = phase.terminal ? null : (phase.next[0] ?? null);
  const decision: AdvanceDecision = phase.terminal ? "complete" : "advanced";

  const targetCounters = target === null ? null : (db.getAttempt(target) ?? null);
  const nextAttempt = target === null ? attempt : (targetCounters?.attempt ?? 1);

  let next = appendHistory(state, { phase: phase.id, attempt, verdict: "passed", at });
  next = {
    ...next,
    phase: target,
    attempt: nextAttempt,
    retries_used: target === null ? state.retries_used : (targetCounters?.retries_used ?? 0),
    status: target === null ? "complete" : "in-progress",
    updated_at: at,
  };

  const eventId = record(opts, {
    kind: "phase.transition",
    from: phase.id,
    to: target,
    attempt,
    verdict: decision === "complete" ? "complete" : "passed",
    failureClass: null,
    gate,
    detail: { gate_type: gate.type },
  });

  next = { ...next, history: withEventId(next.history, eventId) };
  const written = writeState(layout, next);
  void chain;

  return {
    decision,
    from: phase.id,
    to: target,
    attempt,
    retries_used: state.retries_used,
    gate,
    event_id: eventId,
    message:
      decision === "complete"
        ? `fase terminal '${phase.id}' concluida: fluxo completo`
        : `portao de '${phase.id}' aprovado; avancando para '${target}'`,
    state: written,
  };
}

function applyFailure(
  opts: Resolved,
  state: State,
  phase: PhaseSpec,
  gate: GateResult,
  counters: { attempt: number; retries_used: number },
): AdvanceOutcome {
  const { layout, workflow, db } = opts;
  const at = opts.now().toISOString();

  // R1.5: o contador e persistido NO CAMINHO DE FALHA, antes de retornar.
  // Sem isso o retry nunca esgota e a escalacao nunca acontece.
  const retriesUsed = counters.retries_used + 1;
  db.putAttempt({
    phase: phase.id,
    attempt: counters.attempt,
    retries_used: retriesUsed,
    updated_at: at,
  });

  const maxRetries = phase.on_failure.max_auto_retries;
  const failureClass = phase.on_failure.class;
  const classSpec = workflow.failureClass(failureClass);

  let decision: AdvanceDecision;
  let target: string | null;

  if (retriesUsed <= maxRetries) {
    switch (phase.gate.on_fail.action) {
      case "rework":
        decision = "rework";
        target = phase.gate.on_fail.loopback_to ?? phase.id;
        break;
      case "restart":
        decision = "restart";
        target = workflow.entryPhase;
        break;
      case "block":
        decision = "blocked";
        target = phase.id;
        break;
    }
  } else {
    switch (classSpec.on_exhaustion) {
      case "escalate":
        decision = "escalated";
        break;
      case "block":
        decision = "blocked";
        break;
      case "halt":
        decision = "halted";
        break;
    }
    target = phase.id;
  }

  // A tentativa so avanca quando ha rework de verdade: bloqueio e escalacao
  // param no lugar, senao a evidencia da tentativa corrente ficaria orfã.
  let nextAttempt = counters.attempt;
  if (decision === "rework" || decision === "restart") {
    const targetPhase = target ?? phase.id;
    const targetCounters = db.getAttempt(targetPhase);
    nextAttempt = targetPhase === phase.id ? counters.attempt + 1 : (targetCounters?.attempt ?? 1) + 1;
    db.putAttempt({
      phase: targetPhase,
      attempt: nextAttempt,
      retries_used: targetPhase === phase.id ? retriesUsed : (targetCounters?.retries_used ?? 0),
      updated_at: at,
    });
  }

  const verdict = decision === "escalated" ? "escalated" : decision === "blocked" || decision === "halted" ? "blocked" : "failed";

  const eventId = record(opts, {
    kind: "phase.transition",
    from: phase.id,
    to: target,
    attempt: counters.attempt,
    verdict: decision,
    failureClass,
    gate,
    detail: {
      retries_used: retriesUsed,
      max_auto_retries: maxRetries,
      on_exhaustion: classSpec.on_exhaustion,
      failed_checks: gate.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.reason}`),
    },
  });

  let next = appendHistory(state, { phase: phase.id, attempt: counters.attempt, verdict, at, event_id: eventId });
  next = {
    ...next,
    phase: target ?? phase.id,
    attempt: nextAttempt,
    retries_used: retriesUsed,
    status: decision === "escalated" ? "escalated" : decision === "rework" || decision === "restart" ? "in-progress" : "blocked",
    updated_at: at,
  };
  const written = writeState(layout, next);

  const failed = gate.checks.filter((c) => !c.passed);
  return {
    decision,
    from: phase.id,
    to: target,
    attempt: nextAttempt,
    retries_used: retriesUsed,
    gate,
    event_id: eventId,
    message: `${phase.gate.on_fail.message} [${decision}, tentativa ${counters.attempt}, retries ${retriesUsed}/${maxRetries}]\n${failed
      .map((c) => `  - ${c.label}: ${c.reason}`)
      .join("\n")}`,
    state: written,
  };
}

/** R1.6: override nunca vira `passed`, e fica permanente no historico. */
function applyOverride(
  opts: Resolved,
  state: State,
  phase: PhaseSpec,
  gate: GateResult,
  attempt: number,
): AdvanceOutcome {
  const { layout, db } = opts;
  const at = opts.now().toISOString();
  const confirm = opts.confirm;

  if (confirm === undefined) {
    throw new PshError(
      "'--force' exige confirmacao interativa e nao ha terminal disponivel. Rode 'psh advance --force' num TTY.",
      { exitCode: EXIT.FAILURE },
    );
  }
  const failed = gate.checks.filter((c) => !c.passed);
  const question = [
    `OVERRIDE de portao em '${phase.id}' (tentativa ${attempt}).`,
    ...failed.map((c) => `  reprovado: ${c.label} - ${c.reason}`),
    "Isto fica permanente no historico como 'passed-with-override' e nunca vira 'passed'.",
    "Confirma?",
  ].join("\n");

  if (!confirm(question)) {
    throw new PshError("override cancelado pelo operador", { exitCode: EXIT.FAILURE });
  }

  const target = phase.terminal ? null : (phase.next[0] ?? null);
  const targetCounters = target === null ? null : db.getAttempt(target);

  const eventId = record(opts, {
    kind: "human.override",
    from: phase.id,
    to: target,
    attempt,
    verdict: "passed-with-override",
    failureClass: null,
    gate,
    detail: {
      reason: opts.forceReason ?? null,
      failed_checks: failed.map((c) => `${c.label}: ${c.reason}`),
    },
  });

  let next = appendHistory(state, {
    phase: phase.id,
    attempt,
    verdict: "passed-with-override",
    at,
    event_id: eventId,
  });
  next = {
    ...next,
    phase: target,
    attempt: target === null ? attempt : (targetCounters?.attempt ?? 1),
    retries_used: target === null ? state.retries_used : (targetCounters?.retries_used ?? 0),
    status: target === null ? "passed-with-override" : "in-progress",
    updated_at: at,
  };
  const written = writeState(layout, next);

  return {
    decision: "override",
    from: phase.id,
    to: target,
    attempt,
    retries_used: state.retries_used,
    gate,
    event_id: eventId,
    message: `portao de '${phase.id}' ultrapassado por override humano; registrado como passed-with-override`,
    state: written,
  };
}

interface RecordArgs {
  kind: "phase.transition" | "human.override";
  from: string;
  to: string | null;
  attempt: number;
  verdict: string;
  failureClass: string | null;
  gate: GateResult;
  detail: Record<string, unknown>;
}

/** R1.4 + R4.3: um evento por transicao, encadeado na trilha. */
function record(opts: Resolved, args: RecordArgs): string {
  const { db, chain, actor } = opts;
  const ts = opts.now().toISOString();
  const eventId = `ev_${sha256([args.from, args.to ?? "-", args.attempt, args.verdict, ts].join("|")).slice(0, 24)}`;

  const auditEntry = chain.append(args.kind, actor, {
    event_id: eventId,
    from_phase: args.from,
    to_phase: args.to,
    attempt: args.attempt,
    verdict: args.verdict,
    gate: {
      type: args.gate.type,
      passed: args.gate.passed,
      checks: args.gate.checks.map((c) => ({
        label: c.label,
        passed: c.passed,
        observed: c.observed,
        expected: c.expected,
        reason: c.reason,
        evidence_id: c.evidence_id,
      })),
    },
    evidence_ids: args.gate.evidence_ids,
    ...args.detail,
  });

  db.insertEvent({
    id: eventId,
    ts,
    kind: args.kind,
    from_phase: args.from,
    to_phase: args.to,
    attempt: args.attempt,
    verdict: args.verdict,
    failure_class: args.failureClass,
    evidence_ids: JSON.stringify(args.gate.evidence_ids),
    audit_seq: auditEntry.seq,
    detail: JSON.stringify(args.detail),
  });

  return eventId;
}

function withEventId(history: State["history"], eventId: string): State["history"] {
  if (history.length === 0) return history;
  const last = history[history.length - 1]!;
  return [...history.slice(0, -1), { ...last, event_id: eventId }];
}
