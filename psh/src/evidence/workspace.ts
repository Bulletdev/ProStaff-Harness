import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { sha256 } from "../util/hash.ts";
import { compileGlobs, normalizeRel } from "../util/globs.ts";

/** Separador de `git ls-files -z`. */
const NUL = String.fromCharCode(0);

/**
 * `git`: enumeracao por `git ls-files`, respeitando `.gitignore`.
 * `walk`: projeto fora do Git, caminhada com lista de exclusao fixa.
 * `walk-fallback`: existe `.git/`, mas o `git` nao respondeu. O `.gitignore`
 *   deixa de ser respeitado, e por isso o modo e declarado em vez de inferido:
 *   um hash calculado sobre arquivos ignorados muda sozinho e transforma toda
 *   evidencia em obsoleta sem que ninguem entenda por que.
 */
export type Enumeration = "git" | "walk" | "walk-fallback";

export interface WorkspaceManifest {
  /** R2.13: quantos arquivos o mecanismo examinou, nao so quantos casaram. */
  candidates_examined: number;
  matched: number;
  /** Padroes que nao casaram nenhum candidato. */
  empty_patterns: string[];
  enumeration: Enumeration;
  files: Record<string, string>;
  hash: string;
}

export interface GitProbe {
  available: boolean;
  detail: string;
}

/** Probe explicito, usado pelo `psh doctor` para nao esconder o fallback. */
export function probeGit(root: string): GitProbe {
  if (!isGitRepo(root)) {
    return { available: false, detail: "projeto nao e repositorio Git: enumeracao por caminhada" };
  }
  const res = spawnSync("git", ["ls-files", "-z", "--", "."], { cwd: root, encoding: "buffer" });
  if (res.error) {
    return {
      available: false,
      detail: `'.git/' existe mas o comando git nao respondeu (${(res.error as Error).message}). ` +
        "A enumeracao cai para caminhada e o .gitignore deixa de ser respeitado.",
    };
  }
  if (res.status !== 0) {
    return { available: false, detail: `git ls-files saiu com ${res.status}` };
  }
  return { available: true, detail: "enumeracao por git ls-files, respeitando .gitignore" };
}

export interface HashOptions {
  watch: readonly string[];
  exclude?: readonly string[];
}

const WALK_SKIP_DIRS = new Set([".git", "node_modules", ".venv", "target", "dist", "coverage"]);

/** Caminhos internos do harness que nunca entram no calculo de frescor. */
const ALWAYS_EXCLUDED_PREFIXES = [
  ".harness/evidence/",
  ".harness/audit/",
  ".harness/harness.db",
  ".harness/state.json",
];

/**
 * R2.4: hash da arvore dos paths observados.
 * Arquivos rastreados e nao rastreados, respeitando `.gitignore` quando o
 * projeto e um repositorio Git. Fora do Git a enumeracao e por caminhada, e o
 * modo fica declarado no manifesto - nunca inferido pelo leitor.
 */
export function hashWorkspace(root: string, opts: HashOptions): WorkspaceManifest {
  let enumeration: Enumeration = "walk";
  let candidates: string[];
  if (isGitRepo(root)) {
    const listed = listGitFiles(root);
    if (listed === null) {
      enumeration = "walk-fallback";
      candidates = walkFiles(root);
    } else {
      enumeration = "git";
      candidates = listed;
    }
  } else {
    candidates = walkFiles(root);
  }

  const include = compileGlobs(opts.watch);
  const exclude = opts.exclude && opts.exclude.length > 0 ? compileGlobs(opts.exclude) : null;

  const perPattern = new Map<string, number>(include.patterns.map((p) => [p, 0]));
  const files: Record<string, string> = {};
  let matched = 0;

  for (const rel of candidates) {
    if (isAlwaysExcluded(rel)) continue;
    const pattern = include.matchedBy(rel);
    if (pattern === null) continue;
    if (exclude?.matches(rel)) continue;

    let digest: string;
    try {
      digest = sha256(readFileSync(join(root, rel)));
    } catch {
      // Sumiu entre a enumeracao e a leitura: entra marcado, para que a
      // divergencia apareca em vez de desaparecer do hash.
      digest = "missing";
    }
    files[rel] = digest;
    matched += 1;
    perPattern.set(pattern, (perPattern.get(pattern) ?? 0) + 1);
  }

  const empty_patterns = [...perPattern.entries()].filter(([, n]) => n === 0).map(([p]) => p);

  const lines = Object.keys(files)
    .sort()
    .map((rel) => `${rel} ${files[rel]}`)
    .join("\n");

  return {
    candidates_examined: candidates.length,
    matched,
    empty_patterns,
    enumeration,
    files,
    hash: `sha256:${sha256(lines)}`,
  };
}

export interface WorkspaceDiff {
  changed: string[];
  added: string[];
  removed: string[];
}

/** Diferenca exata entre o estado gravado na evidencia e o estado atual. */
export function diffManifests(
  before: Record<string, string>,
  after: Record<string, string>,
): WorkspaceDiff {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [path, digest] of Object.entries(before)) {
    const now = after[path];
    if (now === undefined) removed.push(path);
    else if (now !== digest) changed.push(path);
  }
  for (const path of Object.keys(after)) {
    if (before[path] === undefined) added.push(path);
  }
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort() };
}

function isAlwaysExcluded(rel: string): boolean {
  for (const prefix of ALWAYS_EXCLUDED_PREFIXES) {
    if (rel === prefix || rel.startsWith(prefix)) return true;
  }
  return false;
}

export function isGitRepo(root: string): boolean {
  return existsSync(join(root, ".git"));
}

/** `null` quando o git nao respondeu: quem chama decide e declara o fallback. */
function listGitFiles(root: string): string[] | null {
  const res = spawnSync("git", ["ls-files", "-c", "-o", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) return null;

  const seen = new Set<string>();
  for (const entry of res.stdout.toString("utf8").split(NUL)) {
    if (entry === "") continue;
    seen.add(normalizeRel(entry));
  }
  return [...seen].sort();
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [""];
  while (stack.length > 0) {
    const relDir = stack.pop()!;
    const absDir = relDir === "" ? root : join(root, relDir);
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (WALK_SKIP_DIRS.has(entry.name)) continue;
        stack.push(rel);
        continue;
      }
      try {
        if (!statSync(join(root, rel)).isFile()) continue;
      } catch {
        continue;
      }
      out.push(rel);
    }
  }
  return out.sort();
}
