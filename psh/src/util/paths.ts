import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";
import { EXIT, PshError } from "./errors.ts";
import { normalizeRel } from "./globs.ts";

export const HARNESS_DIR = ".harness";

export interface Layout {
  root: string;
  harness: string;
  statePath: string;
  workflowPath: string;
  boundaryPath: string;
  dbPath: string;
  evidenceDir: string;
  auditDir: string;
  chainPath: string;
  reviewsDir: string;
  memoryDir: string;
  memoryPagesDir: string;
  approvalsDir: string;
}

export function layoutFor(root: string): Layout {
  const harness = join(root, HARNESS_DIR);
  return {
    root,
    harness,
    statePath: join(harness, "state.json"),
    workflowPath: join(harness, "workflow.json"),
    boundaryPath: join(harness, "boundary.json"),
    dbPath: join(harness, "harness.db"),
    evidenceDir: join(harness, "evidence"),
    auditDir: join(harness, "audit"),
    chainPath: join(harness, "audit", "chain.jsonl"),
    reviewsDir: join(harness, "reviews"),
    memoryDir: join(harness, "memory"),
    memoryPagesDir: join(harness, "memory", "pages"),
    approvalsDir: join(harness, "approvals"),
  };
}

/** Sobe a arvore procurando `.harness/`. */
export function findProjectRoot(start: string = process.cwd()): string {
  let cur = resolve(start);
  for (;;) {
    const candidate = join(cur, HARNESS_DIR);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return cur;
    const parent = dirname(cur);
    if (parent === cur) {
      throw new PshError(
        `nenhum ${HARNESS_DIR}/ encontrado a partir de ${resolve(start)}. Rode 'psh init'.`,
        { exitCode: EXIT.NOT_INITIALIZED },
      );
    }
    cur = parent;
  }
}

export function requireLayout(start?: string): Layout {
  return layoutFor(findProjectRoot(start));
}

/** Caminho relativo a raiz, sempre com `/`, para casar com globs do contrato. */
export function toRel(root: string, absPath: string): string {
  return normalizeRel(relative(root, absPath));
}

/**
 * Comparacao de contencao por segmento de path, sem regex e sem `startsWith`
 * ingenuo (`/a/bc` nao esta dentro de `/a/b`).
 */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === "") return true;
  if (rel.startsWith(`..${sep}`) || rel === "..") return false;
  return !resolve(child).startsWith("..");
}
