import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";
import { EXIT, PshError } from "./errors.ts";
import { normalizeRel } from "./globs.ts";

export const HARNESS_DIR = ".harness";

/**
 * O que dentro de `.harness/` e escrito pelo proprio nucleo enquanto ele opera.
 *
 * Nada disso entra no calculo de frescor, porque a infraestrutura que observa um
 * workspace nao pode ser contada como quem o modificou. Sem essa regra um
 * verificador que observa `**` reprova sozinho: basta um `psh memory
 * consolidate` entre a medicao e o portao para a evidencia cair citando um
 * arquivo que nenhum verificador escreveu.
 *
 * A lista e nomeada em vez de ser "tudo dentro de `.harness/`" porque contrato e
 * documento de fase moram no mesmo diretorio e precisam continuar observaveis.
 * Esconder um deles abriria a classe dos arquivos invisiveis ao observador, que
 * e exatamente o que um harness que alega frescor nao pode ter.
 */
export const HARNESS_RUNTIME_PATHS: readonly string[] = [
  `${HARNESS_DIR}/evidence/`,
  `${HARNESS_DIR}/audit/`,
  `${HARNESS_DIR}/memory/`,
  `${HARNESS_DIR}/approvals/`,
  `${HARNESS_DIR}/reviews/`,
  `${HARNESS_DIR}/tmp/`,
  `${HARNESS_DIR}/harness.db`,
  `${HARNESS_DIR}/state.json`,
];

/**
 * O outro lado da mesma classificacao: o que mora em `.harness/` e continua
 * valendo como material de portao, entao e observavel.
 *
 * As duas listas juntas precisam cobrir o `Layout` inteiro, e `paths-and-globs`
 * cobra isso. E o teste que impede a lista de runtime de envelhecer calada, que
 * foi como `memory/`, `approvals/` e `reviews/` ficaram de fora dela.
 */
export const HARNESS_OBSERVABLE_PATHS: readonly string[] = [
  `${HARNESS_DIR}/workflow.json`,
  `${HARNESS_DIR}/boundary.json`,
  `${HARNESS_DIR}/SPEC.md`,
  `${HARNESS_DIR}/brief.md`,
  `${HARNESS_DIR}/sprints/`,
];

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
  /** Rascunho de execucao, por exemplo o snapshot que a fronteira usa. */
  tmpDir: string;
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
    tmpDir: join(harness, "tmp"),
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
