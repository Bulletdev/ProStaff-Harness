import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "../util/paths.ts";
import { toRel } from "../util/paths.ts";
import { readJsonFile, writeJsonAtomic } from "../util/json.ts";
import { ContractError } from "../util/errors.ts";
import { formatAjvErrors, validateEvidenceSchema } from "../workflow/load.ts";
import type { WorkspaceManifest } from "./workspace.ts";

export const ADHOC_PHASE = "_adhoc";

export type EvidenceStatus = "ok" | "error" | "skipped";

export type EvidenceErrorReason =
  | "spawn-failed"
  | "timeout"
  | "signal"
  | "command-failed"
  | "report-missing"
  | "parse-failed"
  | "extractor-no-match"
  | "no-candidates"
  | "contradicts-exit-code"
  | "workspace-mutated-during-run"
  | "not-applicable"
  | "config-error";

export interface EvidenceRecord {
  _type: "psh-evidence";
  version: 1;
  id: string;
  verifier: string;
  phase: string | null;
  attempt: number;
  status: EvidenceStatus;
  value: number | null;
  exit_code: number | null;
  signal: string | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  workspace_hash: string | null;
  watch: string[];
  candidates_examined: number;
  enumeration: "git" | "walk" | "walk-fallback" | "none";
  artifact: string | null;
  manifest: string | null;
  stdout_sha256: string | null;
  stderr_sha256: string | null;
  sandbox: { mode: "ai-jail" | "inherited" | "degraded"; network: boolean; detail?: string };
  runner: string;
  error: { reason: EvidenceErrorReason; message: string } | null;
}

export interface EvidenceSlot {
  dir: string;
  recordPath: string;
  manifestPath: string;
  stdoutPath: string;
  stderrPath: string;
}

export function evidenceSlot(
  layout: Layout,
  phase: string | null,
  attempt: number,
  verifier: string,
): EvidenceSlot {
  const dir = join(layout.evidenceDir, phase ?? ADHOC_PHASE, String(attempt));
  return {
    dir,
    recordPath: join(dir, `${verifier}.json`),
    manifestPath: join(dir, `${verifier}.manifest.json`),
    stdoutPath: join(dir, `${verifier}.stdout.log`),
    stderrPath: join(dir, `${verifier}.stderr.log`),
  };
}

/** R2.6b: escrita de evidencia e exclusiva do nucleo. Esta e a unica porta. */
export function writeEvidence(
  layout: Layout,
  slot: EvidenceSlot,
  record: EvidenceRecord,
  extras: { stdout: string; stderr: string; workspace: WorkspaceManifest | null },
): EvidenceRecord {
  if (!validateEvidenceSchema(record as unknown)) {
    throw new ContractError(
      `registro de evidencia invalido:\n  - ${formatAjvErrors(validateEvidenceSchema.errors).join("\n  - ")}`,
      { verifier: record.verifier },
    );
  }
  mkdirSync(slot.dir, { recursive: true });
  writeFileSync(slot.stdoutPath, extras.stdout, { mode: 0o644 });
  writeFileSync(slot.stderrPath, extras.stderr, { mode: 0o644 });
  if (extras.workspace !== null) {
    // `harness_artifacts` fica gravado junto dos arquivos medidos porque a
    // exclusao do artefato do proprio harness e decisao de medicao, e decisao de
    // medicao que nao aparece no registro nao pode ser auditada depois.
    writeJsonAtomic(slot.manifestPath, {
      _type: "psh-workspace-manifest",
      version: 1,
      verifier: record.verifier,
      workspace_hash: record.workspace_hash,
      harness_artifacts: {
        skipped: extras.workspace.harness_artifacts_skipped,
        excluded: extras.workspace.harness_artifacts_excluded,
      },
      files: extras.workspace.files,
    });
  }
  writeJsonAtomic(slot.recordPath, record);
  void layout;
  return record;
}

export function readEvidence(path: string): EvidenceRecord {
  const raw = readJsonFile(path);
  if (!validateEvidenceSchema(raw)) {
    throw new ContractError(
      `registro de evidencia corrompido em ${path}:\n  - ${formatAjvErrors(validateEvidenceSchema.errors).join("\n  - ")}`,
      { path },
    );
  }
  return raw as EvidenceRecord;
}

export function readEvidenceIfPresent(path: string): EvidenceRecord | null {
  return existsSync(path) ? readEvidence(path) : null;
}

export interface StoredManifest {
  _type: "psh-workspace-manifest";
  version: 1;
  verifier: string;
  workspace_hash: string | null;
  /** Ausente nos manifestos gravados antes da v0.3.1. */
  harness_artifacts?: { skipped: number; excluded: readonly string[] };
  files: Record<string, string>;
}

export function readManifest(path: string): StoredManifest | null {
  if (!existsSync(path)) return null;
  return readJsonFile<StoredManifest>(path);
}

export function relToProject(layout: Layout, absPath: string): string {
  return toRel(layout.root, absPath);
}
