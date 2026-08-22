import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ExtractSpec } from "../../workflow/types.ts";
import { jsonPointer } from "../../util/json.ts";

export type ExtractFailure =
  | "report-missing"
  | "parse-failed"
  | "extractor-no-match"
  | "no-candidates"
  | "config-error";

export interface ExtractOutcome {
  value: number | null;
  /** R2.13: quantos registros o extrator examinou, nao so quantos casaram. */
  candidates_examined: number;
  failure: ExtractFailure | null;
  message: string | null;
  reportPath: string | null;
}

export interface ExtractContext {
  root: string;
  cwd: string;
  stdout: string;
}

const ok = (value: number, candidates: number, reportPath: string | null): ExtractOutcome => ({
  value,
  candidates_examined: candidates,
  failure: null,
  message: null,
  reportPath,
});

const fail = (
  failure: ExtractFailure,
  message: string,
  candidates = 0,
  reportPath: string | null = null,
): ExtractOutcome => ({ value: null, candidates_examined: candidates, failure, message, reportPath });

/**
 * R2.11: nenhum caminho aqui devolve zero por ausencia. Relatorio faltando,
 * parse quebrado e extrator sem match sao falha, e falha nao produz valor.
 */
export function extractValue(spec: ExtractSpec, ctx: ExtractContext): ExtractOutcome {
  if (spec.kind === "exit-code") {
    return { value: null, candidates_examined: 1, failure: null, message: null, reportPath: null };
  }

  if (spec.kind === "json") {
    const from = spec.from ?? "file";
    if (from === "stdout") {
      return extractJsonFromText(spec.pointer, ctx.stdout, "<stdout>");
    }
    if (spec.file === undefined) {
      return fail("config-error", "extract json com from=file exige o campo 'file'");
    }
    const path = resolveReport(ctx, spec.file);
    if (!existsSync(path)) return fail("report-missing", `relatorio ausente: ${spec.file}`, 0, path);
    return extractJsonFromText(spec.pointer, readFileSync(path, "utf8"), path);
  }

  const path = resolveReport(ctx, spec.file);
  if (!existsSync(path)) return fail("report-missing", `relatorio ausente: ${spec.file}`, 0, path);
  const text = readFileSync(path, "utf8");

  switch (spec.kind) {
    case "lcov":
      return extractLcov(text, spec.metric, path);
    case "cobertura":
      return extractCobertura(text, spec.metric, path);
    case "simplecov":
      return extractSimplecov(text, spec.metric, path);
    case "go-cover":
      return extractGoCover(text, spec.metric, path);
  }
}

/** O caminho do relatorio e resolvido por API de path, nunca interpolado em regex (R2.14). */
function resolveReport(ctx: ExtractContext, file: string): string {
  return isAbsolute(file) ? file : join(ctx.cwd, file);
}

function extractJsonFromText(pointer: string, text: string, reportPath: string): ExtractOutcome {
  if (text.trim() === "") return fail("report-missing", "relatorio JSON vazio", 0, reportPath);
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (cause) {
    return fail("parse-failed", `JSON invalido: ${(cause as Error).message}`, 0, reportPath);
  }
  const found = jsonPointer(doc, pointer);
  if (found === undefined) {
    return fail("extractor-no-match", `JSON Pointer ${pointer} nao resolveu`, 1, reportPath);
  }
  const value = Number(found);
  if (!Number.isFinite(value)) {
    return fail(
      "parse-failed",
      `valor em ${pointer} nao e numerico: ${JSON.stringify(found)}`,
      1,
      reportPath,
    );
  }
  return ok(value, 1, reportPath);
}

type Metric = "lines.pct" | "functions.pct" | "branches.pct" | "statements.pct";

export function extractLcov(text: string, metric: Metric, reportPath: string | null = null): ExtractOutcome {
  let records = 0;
  const totals = { LF: 0, LH: 0, FNF: 0, FNH: 0, BRF: 0, BRH: 0 };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line.startsWith("SF:")) {
      records += 1;
      continue;
    }
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const key = line.slice(0, sep);
    if (!Object.hasOwn(totals, key)) continue;
    const n = Number(line.slice(sep + 1));
    if (!Number.isFinite(n)) continue;
    totals[key as keyof typeof totals] += n;
  }

  if (records === 0) {
    return fail("no-candidates", "nenhum registro SF: no lcov (relatorio vazio ou de outro formato)", 0, reportPath);
  }

  const pair = lcovPair(metric, totals);
  if (pair === null) return fail("config-error", `metrica ${metric} nao existe em lcov`, records, reportPath);
  if (pair.found === 0) {
    return fail("extractor-no-match", `lcov sem denominador para ${metric}`, records, reportPath);
  }
  return ok((pair.hit / pair.found) * 100, records, reportPath);
}

function lcovPair(metric: Metric, t: Record<string, number>): { hit: number; found: number } | null {
  switch (metric) {
    case "lines.pct":
    case "statements.pct":
      return { hit: t.LH!, found: t.LF! };
    case "functions.pct":
      return { hit: t.FNH!, found: t.FNF! };
    case "branches.pct":
      return { hit: t.BRH!, found: t.BRF! };
    default:
      return null;
  }
}

/** Cobertura XML: le os atributos do elemento raiz, sem montar regex a partir de caminho. */
export function extractCobertura(
  text: string,
  metric: Metric,
  reportPath: string | null = null,
): ExtractOutcome {
  const openTag = text.indexOf("<coverage");
  if (openTag < 0) return fail("parse-failed", "elemento <coverage> ausente", 0, reportPath);
  const closeTag = text.indexOf(">", openTag);
  if (closeTag < 0) return fail("parse-failed", "elemento <coverage> nao fechado", 0, reportPath);
  const attrs = text.slice(openTag, closeTag);

  let classes = 0;
  let idx = text.indexOf("<class ");
  while (idx >= 0) {
    classes += 1;
    idx = text.indexOf("<class ", idx + 1);
  }
  if (classes === 0) {
    return fail("no-candidates", "nenhum elemento <class> no relatorio cobertura", 0, reportPath);
  }

  const attrName =
    metric === "branches.pct" ? "branch-rate" : metric === "functions.pct" ? null : "line-rate";
  if (attrName === null) {
    return fail("config-error", `cobertura nao expoe ${metric}`, classes, reportPath);
  }
  const rate = readXmlAttr(attrs, attrName);
  if (rate === null) {
    return fail("extractor-no-match", `atributo ${attrName} ausente em <coverage>`, classes, reportPath);
  }
  return ok(rate * 100, classes, reportPath);
}

function readXmlAttr(tag: string, name: string): number | null {
  const needle = `${name}="`;
  const at = tag.indexOf(needle);
  if (at < 0) return null;
  const start = at + needle.length;
  const end = tag.indexOf('"', start);
  if (end < 0) return null;
  const value = Number(tag.slice(start, end));
  return Number.isFinite(value) ? value : null;
}

export function extractSimplecov(
  text: string,
  metric: Metric,
  reportPath: string | null = null,
): ExtractOutcome {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (cause) {
    return fail("parse-failed", `.last_run.json invalido: ${(cause as Error).message}`, 0, reportPath);
  }
  if (metric === "branches.pct") {
    const branch = jsonPointer(doc, "/result/branch");
    return finishSimplecov(branch, "result.branch", reportPath);
  }
  if (metric === "functions.pct") {
    return fail("config-error", "simplecov nao expoe cobertura de funcao", 1, reportPath);
  }
  const line = jsonPointer(doc, "/result/line") ?? jsonPointer(doc, "/result/covered_percent");
  return finishSimplecov(line, "result.line", reportPath);
}

function finishSimplecov(found: unknown, label: string, reportPath: string | null): ExtractOutcome {
  if (found === undefined || found === null) {
    return fail("extractor-no-match", `${label} ausente no .last_run.json`, 1, reportPath);
  }
  const value = Number(found);
  if (!Number.isFinite(value)) {
    return fail("parse-failed", `${label} nao e numerico`, 1, reportPath);
  }
  return ok(value, 1, reportPath);
}

export function extractGoCover(
  text: string,
  metric: Metric,
  reportPath: string | null = null,
): ExtractOutcome {
  if (metric === "functions.pct" || metric === "branches.pct") {
    return fail("config-error", `perfil go cover nao expoe ${metric}`, 0, reportPath);
  }
  let blocks = 0;
  let total = 0;
  let covered = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("mode:")) continue;
    const parts = line.split(" ");
    if (parts.length < 3) continue;
    const stmts = Number(parts[parts.length - 2]);
    const count = Number(parts[parts.length - 1]);
    if (!Number.isFinite(stmts) || !Number.isFinite(count)) continue;
    blocks += 1;
    total += stmts;
    if (count > 0) covered += stmts;
  }
  if (blocks === 0) {
    return fail("no-candidates", "nenhum bloco no perfil de cobertura do Go", 0, reportPath);
  }
  if (total === 0) {
    return fail("extractor-no-match", "perfil do Go sem statements contabilizados", blocks, reportPath);
  }
  return ok((covered / total) * 100, blocks, reportPath);
}
