import type { ProjectContext } from "./context.ts";
import { currentAttempt } from "./context.ts";
import { runVerifier } from "../evidence/runner.ts";
import { detectSandbox } from "../evidence/sandbox.ts";
import type { EvidenceRecord } from "../evidence/store.ts";
import type { VerifierSpec } from "../workflow/types.ts";
import { PshError, EXIT } from "../util/errors.ts";

export interface VerifyOptions {
  ctx: ProjectContext;
  /** Ids explicitos; vazio usa os verificadores do portao da fase corrente. */
  only: string[];
  all: boolean;
  selfArgv?: string[];
}

export interface VerifyOutcome {
  phase: string | null;
  attempt: number;
  sandbox_mode: string;
  records: EvidenceRecord[];
  /** R2.13: quantos verificadores foram considerados, nao so quantos rodaram. */
  considered: number;
}

export function runVerify(opts: VerifyOptions): VerifyOutcome {
  const { ctx } = opts;
  const phase = ctx.state.phase;
  const attempt = currentAttempt(ctx, phase);
  const sandbox = detectSandbox();

  const specs = selectVerifiers(opts);
  if (specs.length === 0) {
    throw new PshError(
      opts.all
        ? "nenhum verificador declarado no contrato"
        : `nenhum verificador ligado ao portao de '${phase ?? "(sem fase)"}'. Use 'psh verify --all' ou nomeie um verificador.`,
      { exitCode: EXIT.FAILURE },
    );
  }

  const records: EvidenceRecord[] = [];
  for (const spec of specs) {
    const { record } = runVerifier({
      layout: ctx.layout,
      spec,
      phase,
      attempt,
      sandbox,
      selfArgv: opts.selfArgv,
    });

    // R4.3: execucao de verificador entra na trilha, sempre.
    ctx.chain.append("verifier.run", "core:psh", {
      verifier: spec.id,
      phase,
      attempt,
      status: record.status,
      value: record.value,
      exit_code: record.exit_code,
      signal: record.signal,
      workspace_hash: record.workspace_hash,
      candidates_examined: record.candidates_examined,
      sandbox_mode: record.sandbox.mode,
      evidence_id: record.id,
      error: record.error,
    });

    ctx.db.insertEvidence({
      id: record.id,
      verifier: record.verifier,
      phase: record.phase,
      attempt: record.attempt,
      status: record.status,
      value: record.value,
      exit_code: record.exit_code,
      signal: record.signal,
      workspace_hash: record.workspace_hash,
      candidates_examined: record.candidates_examined,
      started_at: record.started_at,
      finished_at: record.finished_at,
      artifact: record.artifact,
      sandbox_mode: record.sandbox.mode,
    });

    records.push(record);
  }

  return {
    phase,
    attempt,
    sandbox_mode: sandbox.mode,
    records,
    considered: ctx.workflow.verifiers.length,
  };
}

function selectVerifiers(opts: VerifyOptions): VerifierSpec[] {
  const { ctx } = opts;
  if (opts.all) return ctx.workflow.verifiers;

  if (opts.only.length > 0) {
    return opts.only.map((id) => {
      const spec = ctx.workflow.verifier(id);
      if (spec === undefined) {
        throw new PshError(
          `verificador '${id}' nao esta declarado. Disponiveis: ${ctx.workflow.verifiers.map((v) => v.id).join(", ") || "(nenhum)"}`,
          { exitCode: EXIT.CONTRACT_INVALID },
        );
      }
      return spec;
    });
  }

  const phase = ctx.state.phase === null ? undefined : ctx.workflow.phase(ctx.state.phase);
  if (phase === undefined) return [];
  const ids: string[] = [];
  for (const check of phase.gate.checks) {
    if (check.kind === "verifier" || check.kind === "verifier-status") ids.push(check.verifier);
  }
  const unique = [...new Set(ids)];
  return unique.map((id) => ctx.workflow.verifier(id)!).filter((s) => s !== undefined);
}

export function renderVerify(outcome: VerifyOutcome): string {
  const lines: string[] = [];
  lines.push(
    `fase ${outcome.phase ?? "(sem fase)"} tentativa ${outcome.attempt} | sandbox: ${outcome.sandbox_mode}` +
      (outcome.sandbox_mode === "degraded" ? "  <-- MODO DEGRADADO, declarado" : ""),
  );
  for (const record of outcome.records) {
    const head = `  ${symbol(record.status)} ${record.verifier}`;
    const body =
      record.status === "ok"
        ? record.value === null
          ? `exit ${record.exit_code}`
          : `valor ${round(record.value)} (exit ${record.exit_code})`
        : `${record.error?.reason}: ${record.error?.message}`;
    lines.push(`${head.padEnd(28)} ${body}`);
    lines.push(
      `${" ".repeat(30)}candidatos examinados: ${record.candidates_examined}, workspace ${record.workspace_hash ?? "-"}`,
    );
  }
  lines.push(`  ${outcome.records.length} de ${outcome.considered} verificadores declarados foram executados`);
  return lines.join("\n");
}

function symbol(status: EvidenceRecord["status"]): string {
  if (status === "ok") return "[ok]";
  if (status === "skipped") return "[skip]";
  return "[err]";
}

function round(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}
