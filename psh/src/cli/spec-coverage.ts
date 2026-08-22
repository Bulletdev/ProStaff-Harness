import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { writeJsonAtomic } from "../util/json.ts";
import { PshError, EXIT } from "../util/errors.ts";

/**
 * R2.5: rastreabilidade de itens do SPEC para tasks, calculada por parse dos
 * artefatos - nunca perguntada ao modelo.
 *
 * A expressao regular abaixo casa *conteudo* de documento, nunca caminho de
 * arquivo (R2.14).
 */
const ID_TOKEN = /\b([A-Z][A-Z0-9]{1,9}-\d+(?:\.\d+)*)\b/g;

export interface SpecCoverageReport {
  _type: "psh-spec-coverage";
  version: 1;
  spec: string;
  tasks_glob: string;
  spec_items: string[];
  covered: string[];
  uncovered: string[];
  coverage_pct: number;
  /** R2.13: candidatos examinados, nao so os que casaram. */
  candidates_examined: { spec_lines: number; task_files: number };
}

export interface SpecCoverageOptions {
  root: string;
  spec: string;
  tasksGlob: string;
  out: string | null;
}

export function computeSpecCoverage(opts: SpecCoverageOptions): SpecCoverageReport {
  const specPath = resolveIn(opts.root, opts.spec);
  if (!existsSync(specPath)) {
    throw new PshError(`SPEC ausente: ${opts.spec}`, { exitCode: EXIT.CONTRACT_INVALID });
  }
  const specText = readFileSync(specPath, "utf8");
  const specLines = specText.split("\n");
  const specItems = [...new Set(collectIds(specText))].sort();

  if (specItems.length === 0) {
    throw new PshError(
      `nenhum item identificavel em ${opts.spec} (${specLines.length} linhas examinadas). ` +
        `Zero achados com candidatos examinados e falha de configuracao, nao cobertura limpa (R2.13). ` +
        `Itens do SPEC precisam de um id no formato PREFIXO-N, por exemplo SPEC-12 ou R2.4.`,
      { exitCode: EXIT.CONTRACT_INVALID },
    );
  }

  const taskFiles = scanTasks(opts.root, opts.tasksGlob);
  const referenced = new Set<string>();
  for (const rel of taskFiles) {
    const text = readFileSync(join(opts.root, rel), "utf8");
    for (const id of collectIds(text)) referenced.add(id);
  }

  const covered = specItems.filter((id) => referenced.has(id));
  const uncovered = specItems.filter((id) => !referenced.has(id));

  return {
    _type: "psh-spec-coverage",
    version: 1,
    spec: opts.spec,
    tasks_glob: opts.tasksGlob,
    spec_items: specItems,
    covered,
    uncovered,
    coverage_pct: (covered.length / specItems.length) * 100,
    candidates_examined: { spec_lines: specLines.length, task_files: taskFiles.length },
  };
}

export function runSpecCoverage(opts: SpecCoverageOptions): SpecCoverageReport {
  const report = computeSpecCoverage(opts);
  if (opts.out !== null) writeJsonAtomic(resolveIn(opts.root, opts.out), report);
  return report;
}

function collectIds(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(ID_TOKEN)) {
    if (match[1] !== undefined) out.push(match[1]);
  }
  return out;
}

function scanTasks(root: string, pattern: string): string[] {
  const glob = new Bun.Glob(pattern);
  const out: string[] = [];
  // `dot: true` porque os artefatos de fase moram em `.harness/`: sem isso a
  // varredura devolveria zero tarefa e a cobertura cairia a zero em silencio.
  for (const rel of glob.scanSync({ cwd: root, onlyFiles: true, dot: true })) {
    out.push(rel);
  }
  return out.sort();
}

function resolveIn(root: string, rel: string): string {
  return isAbsolute(rel) ? rel : join(root, rel);
}
