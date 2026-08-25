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
  | "adapter.event"
  | "prompt.submit"
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
      this.#assertAncoraBate(head);
      return this.#grava(type, actor, payload, head);
    } finally {
      release();
    }
  }

  /**
   * O caminho de volta para trilha e ancora divergentes.
   *
   * A protecao de `#assertAncoraBate` esta certa em travar o projeto: uma trilha
   * que nao bate com a propria ancora perdeu a garantia que ela existe para dar.
   * Mas travar sem saida deixava uma unica alternativa real, que era apagar o
   * `.harness` na mao, e apagar no susto e exatamente como a evidencia de
   * adulteracao desaparece.
   *
   * Reancorar nao conserta nada nem finge que o estranho nao aconteceu: ele
   * grava na propria trilha o que a ancora dizia, o que o arquivo diz, quem
   * decidiu e por que, e so entao passa a ancora a apontar para o topo real. A
   * divergencia vira cicatriz permanente e legivel, em vez de virar diretorio
   * apagado.
   *
   * Recusa quando o problema esta DENTRO do arquivo (linha corrompida, seq fora
   * de ordem, elo quebrado, hash que nao fecha): ai a ancora nao e o defeito, e
   * mover a ancora so trocaria um relatorio vermelho por outro. Prometer conserto
   * nesse caso seria pior que nao ter o comando.
   */
  reanchor(reason: string, actor: string): { entry: AuditEntry; anchorBefore: AuditAnchor | null } {
    if (reason.trim() === "") {
      throw new AuditError("reancorar exige um motivo escrito: a decisao fica na trilha, nao na memoria de quem rodou", {
        path: this.path,
      });
    }
    if (this.#anchor === null) {
      throw new AuditError("este projeto nao tem ancora externa, entao nao ha o que reancorar", {
        path: this.path,
      });
    }

    const release = this.#lock();
    try {
      const interno = this.verify().problems.filter((p) => !p.kind.startsWith("anchor-"));
      if (interno.length > 0) {
        throw new AuditError(
          `a trilha tem ${interno.length} problema(s) dentro do proprio arquivo, e reancorar nao conserta isso: ` +
            `${interno.map((p) => `${p.kind}${"line" in p ? ` na linha ${p.line}` : ""}`).join(", ")}. ` +
            "A ancora nao e o defeito aqui. Rode 'psh audit verify' e trate a cadeia antes.",
          { path: this.path, problems: interno.length },
        );
      }

      const anchorBefore = this.#anchor.readAnchor();
      const head = this.#head();
      const linhas = this.#contarLinhas();
      const entry = this.#grava(
        "audit.note",
        actor,
        {
          note: "reancoragem da trilha por decisao humana",
          reason,
          anchor_before: anchorBefore === null ? null : { count: anchorBefore.count, head_hash: anchorBefore.head_hash },
          file_at_reanchor: { count: linhas, head_hash: head.hash },
        },
        head,
      );
      return { entry, anchorBefore };
    } finally {
      release();
    }
  }

  /** Grava e reancora. Fora do `append` porque `reanchor` entra sem a assercao. */
  #grava(
    type: AuditEventType,
    actor: string,
    payload: Record<string, unknown>,
    head: { seq: number; hash: string },
  ): AuditEntry {
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

  /**
   * Nao se escreve em cima de trilha que nao bate com a propria ancora.
   *
   * A ancora existe para pegar reescrita coordenada (R4.1), mas quem so a
   * conferia era o `verify`. Como todo `append` regrava a ancora com o topo
   * novo, bastava uma escrita qualquer depois da adulteracao - `psh remember`,
   * o hook de fim de sessao, qualquer coisa - para a cadeia voltar a fechar e o
   * estrago sumir do relatorio.
   *
   * A conferencia e por contagem de linha e hash do topo, sem re-hashear a
   * cadeia inteira: remocao no meio muda a contagem, e edicao ou religamento
   * mudam o hash do topo. E o mesmo alcance do que a ancora ja prometia, agora
   * cobrado antes da escrita e nao so depois.
   */
  #assertAncoraBate(head: { seq: number; hash: string }): void {
    const ancora = this.#anchor?.readAnchor() ?? null;
    if (ancora === null) return;

    const linhas = this.#contarLinhas();

    if (ancora.count === linhas && ancora.head_hash === head.hash) return;

    throw new AuditError(
      `recusando escrever numa trilha que nao bate com a ancora: ancora diz ${ancora.count} entrada(s) com topo ${ancora.head_hash}, ` +
        `o arquivo tem ${linhas} entrada(s) com topo ${head.hash}. ` +
        "Rode 'psh audit verify' para o diagnostico, e 'psh audit reanchor --reason \"...\"' " +
        "para registrar a decisao de seguir a partir do arquivo atual.",
      { path: this.path, anchor_count: ancora.count, file_count: linhas },
    );
  }

  #contarLinhas(): number {
    if (!existsSync(this.path)) return 0;
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "").length;
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
