import type { ProjectContext } from "./context.ts";
import { currentAttempt } from "./context.ts";
import { detectSandbox } from "../evidence/sandbox.ts";
import { evaluateGate, type GateResult } from "../gate/evaluate.ts";
import { loadBoundary } from "../boundary/policy.ts";

export interface StatusReport {
  profile: string;
  phase: string | null;
  phase_name: string | null;
  attempt: number;
  retries_used: number;
  max_auto_retries: number | null;
  status: string;
  sandbox: { mode: string; detail: string };
  boundary: { mode: "mount" | "degradado" | "indisponivel"; agents: number; detail: string };
  gate: GateResult | null;
  audit: { ok: boolean; entries: number; problems: number };
  history: { phase: string; attempt: number; verdict: string; at: string }[];
}

function descreverFronteira(ctx: ProjectContext, modo: string): StatusReport["boundary"] {
  try {
    const policy = loadBoundary(ctx.layout);
    return modo === "ai-jail"
      ? { mode: "mount", agents: policy.agentIds.length, detail: "escrita restrita pelo kernel via ai-jail" }
      : {
          mode: "degradado",
          agents: policy.agentIds.length,
          detail: "escrita fora da fronteira e revertida por snapshot, nao impedida",
        };
  } catch (cause) {
    return { mode: "indisponivel", agents: 0, detail: (cause as Error).message };
  }
}

export function buildStatus(ctx: ProjectContext): StatusReport {
  const sandbox = detectSandbox();
  const phaseId = ctx.state.phase;
  const phase = phaseId === null ? undefined : ctx.workflow.phase(phaseId);
  const attempt = currentAttempt(ctx, phaseId);
  const counters = phaseId === null ? null : ctx.db.getAttempt(phaseId);
  const audit = ctx.chain.verify();

  return {
    profile: ctx.state.profile,
    phase: phaseId,
    phase_name: phase?.name ?? null,
    attempt,
    retries_used: counters?.retries_used ?? ctx.state.retries_used,
    max_auto_retries: phase?.on_failure.max_auto_retries ?? null,
    status: ctx.state.status,
    sandbox: { mode: sandbox.mode, detail: sandbox.detail },
    boundary: descreverFronteira(ctx, sandbox.mode),
    gate:
      phase === undefined
        ? null
        : evaluateGate({ layout: ctx.layout, workflow: ctx.workflow, phase, attempt }),
    audit: { ok: audit.ok, entries: audit.entries, problems: audit.problems.length },
    history: ctx.state.history.slice(-8),
  };
}

export function renderStatus(report: StatusReport): string {
  const lines: string[] = [];
  lines.push(`perfil        ${report.profile}`);
  lines.push(`fase          ${report.phase ?? "(nenhuma)"}${report.phase_name ? ` - ${report.phase_name}` : ""}`);
  lines.push(
    `tentativa     ${report.attempt} (retries ${report.retries_used}/${report.max_auto_retries ?? "-"})`,
  );
  lines.push(`status        ${report.status}`);
  lines.push(
    `sandbox       ${report.sandbox.mode}${report.sandbox.mode === "degraded" ? "  <-- MODO DEGRADADO" : ""}`,
  );
  lines.push(`              ${report.sandbox.detail}`);
  lines.push(`fronteira     ${report.boundary.mode} (${report.boundary.agents} agente(s))`);
  lines.push(`              ${report.boundary.detail}`);
  lines.push(
    `trilha        ${report.audit.ok ? "integra" : "COMPROMETIDA"} (${report.audit.entries} entradas, ${report.audit.problems} problemas)`,
  );

  if (report.gate !== null) {
    lines.push("");
    lines.push(`portao ${report.gate.type}: ${report.gate.passed ? "APROVADO" : "REPROVADO"}`);
    for (const check of report.gate.checks) {
      const mark = check.passed ? "ok " : "NAO";
      const observed = check.observed === null ? "-" : String(check.observed);
      lines.push(`  ${mark} ${check.label.padEnd(30)} observado ${observed}  esperado ${check.expected ?? "-"}`);
      if (!check.passed && check.reason !== null) lines.push(`      ${check.reason}`);
    }
  }

  if (report.history.length > 0) {
    lines.push("");
    lines.push("historico recente");
    for (const h of report.history) {
      lines.push(`  ${h.at}  ${h.phase} #${h.attempt}  ${h.verdict}`);
    }
  }
  return lines.join("\n");
}
