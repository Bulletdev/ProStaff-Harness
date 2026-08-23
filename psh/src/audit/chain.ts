import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { AuditError } from "../util/errors.ts";
import { canonicalJson } from "../util/json.ts";
import { sha256 } from "../util/hash.ts";

export const GENESIS_HASH = `sha256:${"0".repeat(64)}`;

/** R4.3: o que a trilha registra. */
export type AuditEventType =
  | "harness.init"
  | "tool.call"
  | "command.exec"
  | "boundary.decision"
  | "verifier.run"
  | "phase.transition"
  | "maestro.call"
  | "human.override"
  | "human.approval"
  | "memory.write"
  | "memory.promote"
  | "audit.note";

export interface AuditEntry {
  seq: number;
  ts: string;
  type: AuditEventType;
  actor: string;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

export interface AuditAnchor {
  count: number;
  head_hash: string;
}

/** Onde o topo da cadeia e guardado fora do proprio arquivo da trilha. */
export interface AnchorStore {
  readAnchor(): AuditAnchor | null;
  writeAnchor(anchor: AuditAnchor): void;
}

export type VerifyProblem =
  | { kind: "malformed-line"; line: number; message: string }
  | { kind: "seq-mismatch"; line: number; expected: number; found: number }
  | { kind: "link-broken"; line: number; expected: string; found: string }
  | { kind: "hash-mismatch"; line: number; expected: string; found: string }
  | { kind: "anchor-count-mismatch"; expected: number; found: number }
  | { kind: "anchor-head-mismatch"; expected: string; found: string }
  | { kind: "anchor-missing"; message: string };

export interface VerifyResult {
  ok: boolean;
  /** R2.13: quantas linhas foram examinadas, nao so quantas casaram. */
  candidates_examined: number;
  entries: number;
  head_hash: string;
  problems: VerifyProblem[];
}

export function entryHash(entry: Omit<AuditEntry, "hash">): string {
  return `sha256:${sha256(
    canonicalJson({
      seq: entry.seq,
      ts: entry.ts,
      type: entry.type,
      actor: entry.actor,
      payload: entry.payload,
      prev_hash: entry.prev_hash,
    }),
  )}`;
}

export class AuditChain {
  readonly path: string;
  #anchor: AnchorStore | null;
  #now: () => Date;

  constructor(path: string, opts: { anchor?: AnchorStore; now?: () => Date } = {}) {
    this.path = path;
    this.#anchor = opts.anchor ?? null;
    this.#now = opts.now ?? (() => new Date());
  }

  /** R4.2: qualquer falha aqui e fatal. Trilha que falha em silencio nao e trilha. */
  append(type: AuditEventType, actor: string, payload: Record<string, unknown>): AuditEntry {
    const release = this.#lock();
    try {
      const head = this.#head();
      const base = {
        seq: head.seq + 1,
        ts: this.#now().toISOString(),
        type,
        actor,
        payload,
        prev_hash: head.hash,
      };
      const entry: AuditEntry = { ...base, hash: entryHash(base) };

      let fd: number;
      try {
        mkdirSync(dirname(this.path), { recursive: true });
        fd = openSync(this.path, "a", 0o644);
      } catch (cause) {
        throw new AuditError(
          `nao foi possivel abrir a trilha em ${this.path}: ${(cause as Error).message}`,
          { path: this.path },
        );
      }
      try {
        writeSync(fd, `${canonicalJson(entry)}\n`);
        fsyncSync(fd);
      } catch (cause) {
        throw new AuditError(`falha ao gravar na trilha: ${(cause as Error).message}`, {
          path: this.path,
          seq: entry.seq,
        });
      } finally {
        closeSync(fd);
      }

      this.#anchor?.writeAnchor({ count: entry.seq, head_hash: entry.hash });
      return entry;
    } finally {
      release();
    }
  }

  read(): AuditEntry[] {
    if (!existsSync(this.path)) return [];
    const raw = readFileSync(this.path, "utf8");
    const out: AuditEntry[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      out.push(JSON.parse(line) as AuditEntry);
    }
    return out;
  }

  /** R4.1: detecta remocao, edicao e reordenacao. */
  verify(): VerifyResult {
    const problems: VerifyProblem[] = [];
    let examined = 0;
    let expectedSeq = 1;
    let prevHash = GENESIS_HASH;
    let entries = 0;

    const raw = existsSync(this.path) ? readFileSync(this.path, "utf8") : "";
    const lines = raw.split("\n");

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (line.trim() === "") continue;
      examined += 1;
      const lineNo = i + 1;

      let entry: AuditEntry;
      try {
        entry = JSON.parse(line) as AuditEntry;
      } catch (cause) {
        problems.push({ kind: "malformed-line", line: lineNo, message: (cause as Error).message });
        continue;
      }

      if (entry.seq !== expectedSeq) {
        problems.push({ kind: "seq-mismatch", line: lineNo, expected: expectedSeq, found: entry.seq });
      }
      if (entry.prev_hash !== prevHash) {
        problems.push({ kind: "link-broken", line: lineNo, expected: prevHash, found: entry.prev_hash });
      }
      const recomputed = entryHash(entry);
      if (recomputed !== entry.hash) {
        problems.push({ kind: "hash-mismatch", line: lineNo, expected: recomputed, found: entry.hash });
      }

      entries += 1;
      expectedSeq = entry.seq + 1;
      prevHash = entry.hash;
    }

    // Reescrita coordenada: a cadeia relinkada e internamente consistente,
    // por isso o topo tambem e conferido contra a ancora fora do arquivo.
    if (this.#anchor) {
      const anchor = this.#anchor.readAnchor();
      if (anchor === null) {
        if (entries > 0) {
          problems.push({
            kind: "anchor-missing",
            message: "trilha tem entradas mas nao ha ancora registrada",
          });
        }
      } else {
        if (anchor.count !== entries) {
          problems.push({ kind: "anchor-count-mismatch", expected: anchor.count, found: entries });
        }
        if (anchor.head_hash !== prevHash) {
          problems.push({ kind: "anchor-head-mismatch", expected: anchor.head_hash, found: prevHash });
        }
      }
    }

    return {
      ok: problems.length === 0,
      candidates_examined: examined,
      entries,
      head_hash: prevHash,
      problems,
    };
  }

  #head(): { seq: number; hash: string } {
    if (!existsSync(this.path)) return { seq: 0, hash: GENESIS_HASH };
    const raw = readFileSync(this.path, "utf8");
    let last = "";
    for (const line of raw.split("\n")) {
      if (line.trim() !== "") last = line;
    }
    if (last === "") return { seq: 0, hash: GENESIS_HASH };
    let parsed: AuditEntry;
    try {
      parsed = JSON.parse(last) as AuditEntry;
    } catch (cause) {
      throw new AuditError(
        `ultima linha da trilha esta corrompida, recusando a encadear em cima: ${(cause as Error).message}`,
        { path: this.path },
      );
    }
    if (typeof parsed.seq !== "number" || typeof parsed.hash !== "string") {
      throw new AuditError("ultima linha da trilha nao tem seq/hash validos", { path: this.path });
    }
    return { seq: parsed.seq, hash: parsed.hash };
  }

  #lock(): () => void {
    const lockPath = `${this.path}.lock`;
    // Preparar o lock tambem e parte de gravar na trilha: se falhar aqui, o
    // erro precisa sair como fatal de auditoria, e nao como excecao crua que
    // vira "falha generica" no codigo de saida.
    try {
      mkdirSync(dirname(this.path), { recursive: true });
    } catch (cause) {
      throw new AuditError(
        `nao foi possivel preparar o diretorio da trilha em ${dirname(this.path)}: ${(cause as Error).message}`,
        { path: this.path },
      );
    }
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        const fd = openSync(lockPath, "wx");
        writeSync(fd, String(process.pid));
        closeSync(fd);
        break;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new AuditError(`nao foi possivel travar a trilha: ${(cause as Error).message}`, {
            path: lockPath,
          });
        }
        if (Date.now() > deadline) {
          throw new AuditError(
            `timeout esperando o lock da trilha (${lockPath}). Remova o arquivo se nenhum psh estiver rodando.`,
            { path: lockPath },
          );
        }
        Bun.sleepSync(10);
      }
    }
    return () => {
      try {
        rmSync(lockPath, { force: true });
      } catch {
        /* lock ja removido */
      }
    };
  }
}
