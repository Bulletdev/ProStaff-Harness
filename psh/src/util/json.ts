import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { ContractError } from "./errors.ts";

/**
 * Serializacao canonica: chaves ordenadas, sem espaco.
 * Toda hashagem de estrutura passa por aqui, senao a cadeia de auditoria
 * depende da ordem de insercao das chaves e quebra sem motivo.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) {
    if (src[key] === undefined) continue;
    out[key] = canonicalize(src[key]);
  }
  return out;
}

export function readJsonFile<T = unknown>(path: string): T {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new ContractError(`nao foi possivel ler ${path}: ${(cause as Error).message}`, { path });
  }
  try {
    return JSON.parse(raw) as T;
  } catch (cause) {
    throw new ContractError(`JSON invalido em ${path}: ${(cause as Error).message}`, { path });
  }
}

/** Escrita atomica: tmp no mesmo diretorio + rename. */
export function writeJsonAtomic(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
    renameSync(tmp, path);
  } catch (cause) {
    try {
      unlinkSync(tmp);
    } catch {
      /* tmp ja removido */
    }
    throw cause;
  }
}

/**
 * JSON Pointer (RFC 6901). Usado pelos extratores em vez de expressao regular
 * sobre o texto do relatorio (R2.14).
 * Retorna `undefined` quando o ponteiro nao resolve - o chamador trata como
 * "sem match", nunca como zero (R2.11).
 */
export function jsonPointer(doc: unknown, pointer: string): unknown {
  if (pointer === "") return doc;
  if (!pointer.startsWith("/")) {
    throw new ContractError(`JSON Pointer invalido: ${pointer}`, { pointer });
  }
  let cur: unknown = doc;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replaceAll("~1", "/").replaceAll("~0", "~");
    if (cur === null || typeof cur !== "object") return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(token);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else {
      const obj = cur as Record<string, unknown>;
      if (!Object.hasOwn(obj, token)) return undefined;
      cur = obj[token];
    }
  }
  return cur;
}
