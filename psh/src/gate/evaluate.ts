import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { GateCheck, PhaseSpec, VerifierSpec, Workflow } from "../workflow/types.ts";
import type { Layout } from "../util/paths.ts";
import { sha256 } from "../util/hash.ts";
import { readJsonFile } from "../util/json.ts";
import { ForgedInputError } from "../util/errors.ts";
import { formatAjvErrors, validateReviewSchema } from "../workflow/load.ts";
import { evidenceSlot, readEvidenceIfPresent, readManifest } from "../evidence/store.ts";
import { diffManifests, hashWorkspace } from "../evidence/workspace.ts";
import { describeDiff } from "../evidence/runner.ts";

export interface CheckResult {
  kind: GateCheck["kind"];
  label: string;
  passed: boolean;
  /** Valor observado, sempre lido de evidencia ou do disco pelo nucleo. */
  observed: number | string | null;
  expected: string | null;
  reason: string | null;
  evidence_id: string | null;
}

export interface GateResult {
  phase: string;
  attempt: number;
  type: PhaseSpec["gate"]["type"];
  passed: boolean;
  checks: CheckResult[];
  /** R1.4: ponteiros para os registros de evidencia consumidos. */
  evidence_ids: string[];
}

/**
 * R2.1: nao existe parametro de metrica.
 * Chamador que tenta injetar valor e recusado antes de qualquer avaliacao, com
 * mensagem propria, para que o caminho apareca em teste em vez de virar "flag
 * desconhecida".
 */
export function assertNoForgedMetrics(supplied: Record<string, unknown> | null | undefined): void {
  if (supplied === null || supplied === undefined) return;
  const keys = Object.keys(supplied);
  if (keys.length === 0) return;
  throw new ForgedInputError(
    `portao nao aceita metrica vinda do chamador: [${keys.join(", ")}]. ` +
      `Valor de portao so vem de registro de evidencia produzido por 'psh verify' (R2.1).`,
    { supplied: keys },
  );
}

export interface EvaluateOptions {
  layout: Layout;
  workflow: Workflow;
  phase: PhaseSpec;
  attempt: number;
  /** Presente apenas para ser recusado: nenhum valor de portao vem daqui. */
  suppliedMetrics?: Record<string, unknown> | null;
}

export function evaluateGate(opts: EvaluateOptions): GateResult {
  assertNoForgedMetrics(opts.suppliedMetrics);

  const { layout, workflow, phase, attempt } = opts;
  const checks: CheckResult[] = [];
  const evidenceIds: string[] = [];

  for (const check of phase.gate.checks) {
    const result = runCheck(check, { layout, workflow, phase: phase.id, attempt });
    if (result.evidence_id !== null) evidenceIds.push(result.evidence_id);
    checks.push(result);
  }

  let passed: boolean;
  switch (phase.gate.type) {
    case "none":
      passed = true;
      break;
    case "any-of":
      passed = checks.some((c) => c.passed);
      break;
    case "all-of":
      passed = checks.every((c) => c.passed);
      break;
  }

  return { phase: phase.id, attempt, type: phase.gate.type, passed, checks, evidence_ids: evidenceIds };
}

interface CheckContext {
  layout: Layout;
  workflow: Workflow;
  phase: string;
  attempt: number;
}

function runCheck(check: GateCheck, ctx: CheckContext): CheckResult {
  switch (check.kind) {
    case "verifier":
      return checkVerifierValue(check, ctx);
    case "verifier-status":
      return checkVerifierStatus(check, ctx);
    case "review-score":
      return checkReviewScore(check, ctx);
    case "presence":
      return checkPresence(check, ctx);
    case "user-approval":
      return checkApproval(check, ctx);
  }
}

function loadEvidence(verifierId: string, ctx: CheckContext) {
  const spec = ctx.workflow.verifier(verifierId);
  const slot = evidenceSlot(ctx.layout, ctx.phase, ctx.attempt, verifierId);
  const record = readEvidenceIfPresent(slot.recordPath);
  return { spec, slot, record };
}

/**
 * R2.4: frescor. O portao recalcula o hash agora; divergencia significa
 * evidencia obsoleta, e a mensagem diz exatamente o que mudou depois da
 * verificacao.
 */
function stalenessReason(
  spec: VerifierSpec,
  ctx: CheckContext,
  record: { workspace_hash: string | null },
  manifestPath: string,
): string | null {
  if (record.workspace_hash === null) return null;
  const current = hashWorkspace(ctx.layout.root, { watch: spec.watch, exclude: spec.watch_exclude });
  if (current.hash === record.workspace_hash) return null;

  const stored = readManifest(manifestPath);
  if (stored === null) {
    return `evidencia obsoleta: a arvore observada mudou desde a verificacao (${record.workspace_hash} -> ${current.hash}), e o manifesto nao esta disponivel para detalhar`;
  }
  return describeDiff(
    "evidencia obsoleta: arquivo observado mudou depois da verificacao",
    diffManifests(stored.files, current.files),
  );
}

function checkVerifierValue(
  check: Extract<GateCheck, { kind: "verifier" }>,
  ctx: CheckContext,
): CheckResult {
  const label = `verifier:${check.verifier}`;
  const expected = [
    check.min !== undefined ? `min ${check.min}` : null,
    check.max !== undefined ? `max ${check.max}` : null,
  ]
    .filter((s) => s !== null)
    .join(", ");

  const { spec, slot, record } = loadEvidence(check.verifier, ctx);
  if (spec === undefined) {
    return base(check.kind, label, false, null, expected, `verificador '${check.verifier}' nao declarado`);
  }
  if (record === null) {
    // R2.12: nao verificado nunca passa por omissao.
    return base(check.kind, label, false, null, expected, "nao verificado: nenhum registro de evidencia para esta tentativa");
  }
  if (record.status === "skipped") {
    return base(
      check.kind,
      label,
      false,
      null,
      expected,
      `nao verificado: verificador marcado como skipped (${record.error?.message ?? "sem detalhe"})`,
      record.id,
    );
  }
  if (record.status === "error" || record.value === null) {
    return base(
      check.kind,
      label,
      false,
      null,
      expected,
      `verificador falhou: ${record.error?.reason ?? "sem valor"} - ${record.error?.message ?? "metrica ausente"}`,
      record.id,
    );
  }

  const stale = stalenessReason(spec, ctx, record, slot.manifestPath);
  if (stale !== null) return base(check.kind, label, false, record.value, expected, stale, record.id);

  if (check.min !== undefined && record.value < check.min) {
    return base(check.kind, label, false, record.value, expected, `${record.value} abaixo do minimo ${check.min}`, record.id);
  }
  if (check.max !== undefined && record.value > check.max) {
    return base(check.kind, label, false, record.value, expected, `${record.value} acima do maximo ${check.max}`, record.id);
  }
  return base(check.kind, label, true, record.value, expected, null, record.id);
}

function checkVerifierStatus(
  check: Extract<GateCheck, { kind: "verifier-status" }>,
  ctx: CheckContext,
): CheckResult {
  const label = `verifier-status:${check.verifier}`;
  const { spec, slot, record } = loadEvidence(check.verifier, ctx);
  const allowed = spec?.success_exit_codes ?? [0];
  const expected = `exit ${allowed.join(" ou ")}`;

  if (spec === undefined) {
    return base(check.kind, label, false, null, expected, `verificador '${check.verifier}' nao declarado`);
  }
  if (record === null) {
    return base(check.kind, label, false, null, expected, "nao verificado: nenhum registro de evidencia para esta tentativa");
  }
  if (record.status === "skipped") {
    return base(check.kind, label, false, null, expected, `nao verificado: skipped (${record.error?.message ?? "sem detalhe"})`, record.id);
  }
  if (record.status === "error") {
    return base(check.kind, label, false, record.exit_code, expected, `verificador falhou: ${record.error?.reason} - ${record.error?.message}`, record.id);
  }

  const stale = stalenessReason(spec, ctx, record, slot.manifestPath);
  if (stale !== null) return base(check.kind, label, false, record.exit_code, expected, stale, record.id);

  // R2.10b: existindo codigo de saida, ele e a autoridade.
  if (record.signal !== null) {
    return base(check.kind, label, false, record.signal, expected, `processo morto por ${record.signal}`, record.id);
  }
  if (record.exit_code === null || !allowed.includes(record.exit_code)) {
    return base(check.kind, label, false, record.exit_code, expected, `exit code ${record.exit_code} fora de [${allowed.join(", ")}]`, record.id);
  }
  return base(check.kind, label, true, record.exit_code, expected, null, record.id);
}

/** R2.6: score de review so vale se o hash declarado bate com o artefato atual. */
function checkReviewScore(
  check: Extract<GateCheck, { kind: "review-score" }>,
  ctx: CheckContext,
): CheckResult {
  const label = `review:${check.target}`;
  const expected = `score >= ${check.min}`;
  const reviewPath = resolveIn(ctx.layout.root, check.file);
  const targetPath = resolveIn(ctx.layout.root, check.target);

  if (!existsSync(reviewPath)) {
    return base(check.kind, label, false, null, expected, `arquivo de review ausente: ${check.file}`);
  }
  if (!existsSync(targetPath)) {
    return base(check.kind, label, false, null, expected, `artefato revisado ausente: ${check.target}`);
  }

  const raw = readJsonFile(reviewPath);
  if (!validateReviewSchema(raw)) {
    return base(
      check.kind,
      label,
      false,
      null,
      expected,
      `review invalido: ${formatAjvErrors(validateReviewSchema.errors).join("; ")}`,
    );
  }
  const review = raw as { target: string; target_sha256: string; score: number };

  if (review.target !== check.target) {
    return base(check.kind, label, false, review.score, expected, `review aponta para '${review.target}', o portao espera '${check.target}'`);
  }
  const currentHash = `sha256:${sha256(readFileSync(targetPath))}`;
  if (review.target_sha256 !== currentHash) {
    return base(
      check.kind,
      label,
      false,
      review.score,
      expected,
      `review de documento ja modificado: hash declarado ${review.target_sha256}, hash atual ${currentHash}`,
    );
  }
  if (review.score < check.min) {
    return base(check.kind, label, false, review.score, expected, `score ${review.score} abaixo de ${check.min}`);
  }
  return base(check.kind, label, true, review.score, expected, null);
}

function checkPresence(
  check: Extract<GateCheck, { kind: "presence" }>,
  ctx: CheckContext,
): CheckResult {
  const label = `presence:${check.file}`;
  const expected = [
    check.min_lines !== undefined ? `>= ${check.min_lines} linhas` : null,
    check.min_bytes !== undefined ? `>= ${check.min_bytes} bytes` : null,
  ]
    .filter((s) => s !== null)
    .join(", ");
  const path = resolveIn(ctx.layout.root, check.file);
  if (!existsSync(path)) {
    return base(check.kind, label, false, null, expected || "existir", `arquivo ausente: ${check.file}`);
  }
  const content = readFileSync(path, "utf8");
  const bytes = Buffer.byteLength(content);
  const lines = content === "" ? 0 : content.split("\n").filter((l) => l.trim() !== "").length;

  if (check.min_bytes !== undefined && bytes < check.min_bytes) {
    return base(check.kind, label, false, bytes, expected, `${bytes} bytes, minimo ${check.min_bytes}`);
  }
  if (check.min_lines !== undefined && lines < check.min_lines) {
    return base(check.kind, label, false, lines, expected, `${lines} linhas nao vazias, minimo ${check.min_lines}`);
  }
  return base(check.kind, label, true, check.min_lines !== undefined ? lines : bytes, expected || "existir", null);
}

export function approvalPath(layout: Layout, subject: string): string {
  return join(layout.approvalsDir, `${sha256(subject).slice(0, 32)}.json`);
}

export interface ApprovalRecord {
  _type: "psh-approval";
  version: 1;
  subject: string;
  subject_sha256: string | null;
  approver: string;
  approved_at: string;
}

function checkApproval(
  check: Extract<GateCheck, { kind: "user-approval" }>,
  ctx: CheckContext,
): CheckResult {
  const label = `approval:${check.subject}`;
  const path = approvalPath(ctx.layout, check.subject);
  if (!existsSync(path)) {
    return base(check.kind, label, false, null, "aprovacao humana", check.message ?? `aguardando aprovacao de '${check.subject}'`);
  }
  const approval = readJsonFile<ApprovalRecord>(path);

  // Aprovacao amarrada ao conteudo: aprovar um brief e depois reescrever o brief
  // nao vale como aprovacao do novo texto.
  const subjectFile = resolveIn(ctx.layout.root, check.subject);
  if (existsSync(subjectFile)) {
    const currentHash = `sha256:${sha256(readFileSync(subjectFile))}`;
    if (approval.subject_sha256 !== currentHash) {
      return base(
        check.kind,
        label,
        false,
        approval.approver,
        "aprovacao humana",
        `'${check.subject}' mudou depois da aprovacao (${approval.subject_sha256} -> ${currentHash})`,
      );
    }
  }
  return base(check.kind, label, true, approval.approver, "aprovacao humana", null);
}

function base(
  kind: GateCheck["kind"],
  label: string,
  passed: boolean,
  observed: number | string | null,
  expected: string | null,
  reason: string | null,
  evidenceId: string | null = null,
): CheckResult {
  return { kind, label, passed, observed, expected, reason, evidence_id: evidenceId };
}

function resolveIn(root: string, rel: string): string {
  return isAbsolute(rel) ? rel : join(root, rel);
}
