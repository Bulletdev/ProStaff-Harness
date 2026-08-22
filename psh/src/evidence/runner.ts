import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { VerifierSpec } from "../workflow/types.ts";
import type { Layout } from "../util/paths.ts";
import { sha256 } from "../util/hash.ts";
import { PSH_TOKEN, selfArgv } from "../util/self.ts";
import { RUNNER_ID } from "../version.ts";
import { detectSandbox, runSandboxed, type SandboxStatus } from "./sandbox.ts";
import { extractValue } from "./extract/index.ts";
import { diffManifests, hashWorkspace, type Enumeration, type WorkspaceManifest } from "./workspace.ts";
import {
  evidenceSlot,
  relToProject,
  writeEvidence,
  type EvidenceErrorReason,
  type EvidenceRecord,
  type EvidenceSlot,
} from "./store.ts";

export interface RunVerifierOptions {
  layout: Layout;
  spec: VerifierSpec;
  phase: string | null;
  attempt: number;
  sandbox?: SandboxStatus;
  /** Argv de reinvocacao do proprio psh, substituido no token do contrato. */
  selfArgv?: string[];
  now?: () => Date;
}

export interface RunVerifierResult {
  record: EvidenceRecord;
  slot: EvidenceSlot;
  manifest: WorkspaceManifest | null;
}


/**
 * R2.3: o nucleo executa o verificador; o agente nunca executa.
 * R2.10 / R2.10b: o codigo de saida real e a autoridade sobre sucesso ou falha.
 * R2.11: falha de execucao nunca produz valor.
 */
export function runVerifier(opts: RunVerifierOptions): RunVerifierResult {
  const { layout, spec, phase, attempt } = opts;
  const now = opts.now ?? (() => new Date());
  const sandbox = opts.sandbox ?? detectSandbox();
  const slot = evidenceSlot(layout, phase, attempt, spec.id);
  const startedAt = now();

  const base = {
    _type: "psh-evidence" as const,
    version: 1 as const,
    verifier: spec.id,
    phase,
    attempt,
    watch: spec.watch,
    runner: RUNNER_ID,
    sandbox: { mode: sandbox.mode, network: spec.network === true, detail: sandbox.detail },
  };

  // R2.12: verificador que nao se aplica ao projeto e `skipped` explicito.
  const missing = notApplicableReason(layout.root, spec);
  if (missing !== null) {
    const record = finish({
      ...base,
      status: "skipped",
      value: null,
      exit_code: null,
      signal: null,
      startedAt,
      finishedAt: now(),
      workspace_hash: null,
      candidates_examined: 0,
      enumeration: "none",
      artifact: null,
      manifest: null,
      stdout: "",
      stderr: "",
      error: { reason: "not-applicable", message: missing },
      layout,
      slot,
    });
    return { record, slot, manifest: null };
  }

  const cwd = spec.cwd === undefined || spec.cwd === "" ? layout.root : resolveIn(layout.root, spec.cwd);

  // Frescor antes e depois: o registro guarda o estado pos-execucao, e uma
  // divergencia durante a propria corrida vira erro em vez de virar hash bonito.
  let before: WorkspaceManifest;
  try {
    before = hashWorkspace(layout.root, { watch: spec.watch, exclude: spec.watch_exclude });
  } catch (cause) {
    const record = finish({
      ...base,
      status: "error",
      value: null,
      exit_code: null,
      signal: null,
      startedAt,
      finishedAt: now(),
      workspace_hash: null,
      candidates_examined: 0,
      enumeration: "none",
      artifact: null,
      manifest: null,
      stdout: "",
      stderr: "",
      error: { reason: "config-error", message: (cause as Error).message },
      layout,
      slot,
    });
    return { record, slot, manifest: null };
  }

  // R2.13: zero candidato examinado e erro de configuracao, nao resultado limpo.
  const candidateProblem = candidateProblemFor(before);
  if (candidateProblem !== null) {
    const record = finish({
      ...base,
      status: "error",
      value: null,
      exit_code: null,
      signal: null,
      startedAt,
      finishedAt: now(),
      workspace_hash: null,
      candidates_examined: before.candidates_examined,
      enumeration: before.enumeration,
      artifact: null,
      manifest: null,
      stdout: "",
      stderr: "",
      error: { reason: "no-candidates", message: candidateProblem },
      layout,
      slot,
    });
    return { record, slot, manifest: before };
  }

  const self = opts.selfArgv ?? selfArgv();
  const argv = spec.run.flatMap((arg) => (arg === PSH_TOKEN ? self : [arg]));
  const run = runSandboxed(
    {
      argv,
      cwd,
      env: buildEnv(spec, layout),
      timeout_s: spec.timeout_s,
      network: spec.network === true,
    },
    sandbox,
  );

  const after = hashWorkspace(layout.root, { watch: spec.watch, exclude: spec.watch_exclude });
  const finishedAt = now();
  const commonTail = {
    ...base,
    startedAt,
    finishedAt,
    workspace_hash: after.hash,
    candidates_examined: after.candidates_examined,
    enumeration: after.enumeration,
    artifact: relToProject(layout, slot.stdoutPath),
    manifest: relToProject(layout, slot.manifestPath),
    stdout: run.stdout,
    stderr: run.stderr,
    manifestFiles: after.files,
    layout,
    slot,
  };

  const execError = executionError(run, spec);
  if (execError !== null) {
    const record = finish({
      ...commonTail,
      status: "error",
      value: null,
      exit_code: run.exit_code,
      signal: run.signal,
      error: execError,
    });
    return { record, slot, manifest: after };
  }

  if (before.hash !== after.hash) {
    const diff = diffManifests(before.files, after.files);
    const record = finish({
      ...commonTail,
      status: "error",
      value: null,
      exit_code: run.exit_code,
      signal: run.signal,
      error: {
        reason: "workspace-mutated-during-run",
        message: describeDiff(
          "arquivo observado mudou durante a execucao do verificador; use watch_exclude se a geracao for legitima",
          diff,
        ),
      },
    });
    return { record, slot, manifest: after };
  }

  // `exit-code` nao produz metrica: o veredito e o proprio codigo de saida.
  if (spec.extract.kind === "exit-code") {
    const record = finish({
      ...commonTail,
      status: "ok",
      value: null,
      exit_code: run.exit_code,
      signal: run.signal,
      error: null,
    });
    return { record, slot, manifest: after };
  }

  const outcome = extractValue(spec.extract, { root: layout.root, cwd, stdout: run.stdout });
  if (outcome.failure !== null) {
    const record = finish({
      ...commonTail,
      status: "error",
      value: null,
      exit_code: run.exit_code,
      signal: run.signal,
      candidates_examined: outcome.candidates_examined,
      error: { reason: outcome.failure, message: outcome.message ?? "extracao falhou" },
    });
    return { record, slot, manifest: after };
  }

  const record = finish({
    ...commonTail,
    status: "ok",
    value: outcome.value,
    exit_code: run.exit_code,
    signal: run.signal,
    error: null,
  });
  return { record, slot, manifest: after };
}

function executionError(
  run: { exit_code: number | null; signal: string | null; timed_out: boolean; spawn_error: string | null },
  spec: VerifierSpec,
): { reason: EvidenceErrorReason; message: string } | null {
  if (run.spawn_error !== null) {
    return { reason: "spawn-failed", message: `nao foi possivel executar ${spec.run.join(" ")}: ${run.spawn_error}` };
  }
  if (run.timed_out) {
    return { reason: "timeout", message: `verificador excedeu ${spec.timeout_s}s e foi morto` };
  }
  // R2.10b: processo morto por sinal e falha, nunca zero.
  if (run.signal !== null) {
    return { reason: "signal", message: `verificador terminado por ${run.signal}` };
  }
  if (run.exit_code === null) {
    return { reason: "spawn-failed", message: "verificador terminou sem codigo de saida" };
  }
  if (spec.extract.kind === "exit-code") return null;

  const allowed = spec.success_exit_codes ?? [0];
  if (!allowed.includes(run.exit_code)) {
    return {
      reason: "command-failed",
      message: `verificador saiu com ${run.exit_code} (esperado ${allowed.join(" ou ")}); a metrica do relatorio nao e confiavel`,
    };
  }
  return null;
}

function notApplicableReason(root: string, spec: VerifierSpec): string | null {
  const required = spec.applies_when_exists ?? [];
  if (required.length === 0) return null;
  const present = required.filter((rel) => existsSync(resolveIn(root, rel)));
  if (present.length > 0) return null;
  return `nenhum de [${required.join(", ")}] existe no projeto`;
}

function candidateProblemFor(manifest: WorkspaceManifest): string | null {
  if (manifest.candidates_examined === 0) {
    return "nenhum arquivo candidato examinado no projeto: configuracao de watch ou enumeracao quebrada";
  }
  if (manifest.matched === 0) {
    return `${manifest.candidates_examined} candidatos examinados e nenhum casou com watch [${manifest.empty_patterns.join(", ")}]`;
  }
  if (manifest.empty_patterns.length > 0) {
    return `padroes de watch sem nenhum arquivo: [${manifest.empty_patterns.join(", ")}] (${manifest.candidates_examined} candidatos examinados)`;
  }
  return null;
}

function describeDiff(
  headline: string,
  diff: { changed: string[]; added: string[]; removed: string[] },
): string {
  const parts: string[] = [];
  if (diff.changed.length > 0) parts.push(`modificados: ${diff.changed.join(", ")}`);
  if (diff.added.length > 0) parts.push(`criados: ${diff.added.join(", ")}`);
  if (diff.removed.length > 0) parts.push(`removidos: ${diff.removed.join(", ")}`);
  return `${headline}. ${parts.join("; ")}`;
}

export { describeDiff };

function resolveIn(root: string, rel: string): string {
  return isAbsolute(rel) ? rel : join(root, rel);
}

/** R3.4/R2.7: ambiente minimo e declarado, nao o ambiente do operador inteiro. */
function buildEnv(spec: VerifierSpec, layout: Layout): Record<string, string> {
  const passthrough = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TERM", "SHELL", "USER"];
  const env: Record<string, string> = {};
  for (const key of passthrough) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.CI = "1";
  env.PSH_PROJECT_ROOT = layout.root;
  env.PSH_VERIFIER = spec.id;
  for (const [key, value] of Object.entries(spec.env ?? {})) env[key] = value;
  return env;
}

interface FinishArgs {
  _type: "psh-evidence";
  version: 1;
  verifier: string;
  phase: string | null;
  attempt: number;
  watch: string[];
  runner: string;
  sandbox: { mode: "ai-jail" | "inherited" | "degraded"; network: boolean; detail?: string };
  status: EvidenceRecord["status"];
  value: number | null;
  exit_code: number | null;
  signal: string | null;
  startedAt: Date;
  finishedAt: Date;
  workspace_hash: string | null;
  candidates_examined: number;
  enumeration: Enumeration | "none";
  artifact: string | null;
  manifest: string | null;
  stdout: string;
  stderr: string;
  manifestFiles?: Record<string, string>;
  error: { reason: EvidenceErrorReason; message: string } | null;
  layout: Layout;
  slot: EvidenceSlot;
}

function finish(args: FinishArgs): EvidenceRecord {
  const record: EvidenceRecord = {
    _type: "psh-evidence",
    version: 1,
    id: `ev_${sha256(
      [args.verifier, args.phase ?? "-", args.attempt, args.finishedAt.toISOString()].join("|"),
    ).slice(0, 24)}`,
    verifier: args.verifier,
    phase: args.phase,
    attempt: args.attempt,
    status: args.status,
    value: args.value,
    exit_code: args.exit_code,
    signal: args.signal,
    started_at: args.startedAt.toISOString(),
    finished_at: args.finishedAt.toISOString(),
    duration_ms: Math.max(0, args.finishedAt.getTime() - args.startedAt.getTime()),
    workspace_hash: args.workspace_hash,
    watch: args.watch,
    candidates_examined: args.candidates_examined,
    enumeration: args.enumeration,
    artifact: args.artifact,
    manifest: args.manifestFiles === undefined ? null : args.manifest,
    stdout_sha256: `sha256:${sha256(args.stdout)}`,
    stderr_sha256: `sha256:${sha256(args.stderr)}`,
    sandbox: args.sandbox,
    runner: args.runner,
    error: args.error,
  };
  return writeEvidence(args.layout, args.slot, record, {
    stdout: args.stdout,
    stderr: args.stderr,
    manifestFiles: args.manifestFiles ?? null,
  });
}
