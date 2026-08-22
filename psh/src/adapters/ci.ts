import type { ProjectContext } from "../cli/context.ts";
import { EXIT, type ExitCode } from "../util/errors.ts";
import { runVerify, type VerifyOutcome } from "../cli/verify.ts";
import { advance, type AdvanceOutcome } from "../workflow/advance.ts";
import { evaluateGate, type GateResult } from "../gate/evaluate.ts";
import { currentAttempt } from "../cli/context.ts";
import { selfArgv } from "../util/self.ts";
import { PSH_VERSION } from "../version.ts";

/**
 * Adapter `ci`: headless, sem TTY e sem interacao.
 *
 * O adapter e fino de proposito (secao 6.1): ele nao decide nada. Roda os
 * verificadores pelo nucleo, pede o veredito ao motor de portao e traduz o
 * resultado em codigo de saida e JSON. Nenhuma regra de negocio mora aqui.
 */
export interface CiOptions {
  ctx: ProjectContext;
  /** Somente verificar e avaliar, sem mexer no estado. */
  gateOnly?: boolean;
  /** Reaproveitar evidencia existente em vez de reverificar. */
  skipVerify?: boolean;
}

export interface CiReport {
  _type: "psh-ci-report";
  version: 1;
  psh: string;
  phase: string | null;
  attempt: number;
  sandbox_mode: string;
  boundary_engine: "absent";
  verify: {
    ran: { verifier: string; status: string; value: number | null; exit_code: number | null; error: string | null }[];
    considered: number;
  } | null;
  gate: GateResult | null;
  advance: Pick<AdvanceOutcome, "decision" | "from" | "to" | "event_id" | "retries_used"> | null;
  audit_ok: boolean;
  exit_code: ExitCode;
}

export function runCi(opts: CiOptions): CiReport {
  const { ctx } = opts;
  const phaseId = ctx.state.phase;

  let verify: VerifyOutcome | null = null;
  if (opts.skipVerify !== true) {
    verify = runVerify({ ctx, only: [], all: phaseId === null, selfArgv: selfArgv() });
  }

  const audit = ctx.chain.verify();
  const phase = phaseId === null ? undefined : ctx.workflow.phase(phaseId);

  let gate: GateResult | null = null;
  let advanceResult: AdvanceOutcome | null = null;
  let exit: ExitCode = EXIT.OK;

  if (phase === undefined) {
    // Perfil gate-only: o veredito e o resultado dos verificadores.
    const houveErro = verify?.records.some((r) => r.status === "error") ?? false;
    exit = houveErro ? EXIT.FAILURE : EXIT.OK;
  } else if (opts.gateOnly === true) {
    gate = evaluateGate({
      layout: ctx.layout,
      workflow: ctx.workflow,
      phase,
      attempt: currentAttempt(ctx, phaseId),
    });
    exit = gate.passed ? EXIT.OK : EXIT.GATE_FAILED;
  } else {
    // `force` nunca e oferecido aqui: override e ato humano com confirmacao
    // interativa (R1.6), e CI nao tem humano para confirmar.
    advanceResult = advance({
      layout: ctx.layout,
      workflow: ctx.workflow,
      db: ctx.db,
      chain: ctx.chain,
      actor: "adapter:ci",
    });
    gate = advanceResult.gate;
    exit =
      advanceResult.decision === "advanced" ||
      advanceResult.decision === "complete" ||
      advanceResult.decision === "override"
        ? EXIT.OK
        : EXIT.GATE_FAILED;
  }

  // R4.2: trilha comprometida ganha de qualquer outro veredito.
  if (!audit.ok) exit = EXIT.AUDIT_BROKEN;

  return {
    _type: "psh-ci-report",
    version: 1,
    psh: PSH_VERSION,
    phase: phaseId,
    attempt: verify?.attempt ?? currentAttempt(ctx, phaseId),
    sandbox_mode: verify?.sandbox_mode ?? "degraded",
    boundary_engine: "absent",
    verify:
      verify === null
        ? null
        : {
            considered: verify.considered,
            ran: verify.records.map((r) => ({
              verifier: r.verifier,
              status: r.status,
              value: r.value,
              exit_code: r.exit_code,
              error: r.error === null ? null : `${r.error.reason}: ${r.error.message}`,
            })),
          },
    gate,
    advance:
      advanceResult === null
        ? null
        : {
            decision: advanceResult.decision,
            from: advanceResult.from,
            to: advanceResult.to,
            event_id: advanceResult.event_id,
            retries_used: advanceResult.retries_used,
          },
    audit_ok: audit.ok,
    exit_code: exit,
  };
}

export function renderCi(report: CiReport): string {
  const lines: string[] = [];
  lines.push(`psh ${report.psh} | adapter ci | fase ${report.phase ?? "(sem fase)"} tentativa ${report.attempt}`);
  lines.push(`sandbox ${report.sandbox_mode} | fronteira ${report.boundary_engine} | trilha ${report.audit_ok ? "integra" : "COMPROMETIDA"}`);
  if (report.verify !== null) {
    for (const r of report.verify.ran) {
      lines.push(`  ${r.status === "ok" ? "ok " : "NAO"} ${r.verifier}: ${r.error ?? (r.value ?? `exit ${r.exit_code}`)}`);
    }
  }
  if (report.gate !== null) {
    lines.push(`  portao ${report.gate.passed ? "APROVADO" : "REPROVADO"}`);
    for (const c of report.gate.checks.filter((c) => !c.passed)) {
      lines.push(`    - ${c.label}: ${c.reason}`);
    }
  }
  if (report.advance !== null) {
    lines.push(`  decisao ${report.advance.decision} (${report.advance.from} -> ${report.advance.to ?? "-"})`);
  }
  return lines.join("\n");
}
