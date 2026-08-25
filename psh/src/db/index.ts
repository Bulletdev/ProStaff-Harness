import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AnchorStore, AuditAnchor } from "../audit/chain.ts";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- R1.4: uma linha por transicao, com ponteiro para a evidencia consumida.
CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,
  ts            TEXT NOT NULL,
  kind          TEXT NOT NULL,
  from_phase    TEXT,
  to_phase      TEXT,
  attempt       INTEGER NOT NULL DEFAULT 1,
  verdict       TEXT,
  failure_class TEXT,
  evidence_ids  TEXT NOT NULL DEFAULT '[]',
  audit_seq     INTEGER,
  detail        TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);

-- Indice dos registros de evidencia. O registro canonico continua em disco.
CREATE TABLE IF NOT EXISTS evidence (
  id                  TEXT PRIMARY KEY,
  verifier            TEXT NOT NULL,
  phase               TEXT,
  attempt             INTEGER NOT NULL DEFAULT 1,
  status              TEXT NOT NULL,
  value               REAL,
  exit_code           INTEGER,
  signal              TEXT,
  workspace_hash      TEXT,
  candidates_examined INTEGER NOT NULL DEFAULT 0,
  started_at          TEXT NOT NULL,
  finished_at         TEXT NOT NULL,
  artifact            TEXT,
  sandbox_mode        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_verifier ON evidence(verifier, finished_at DESC);

-- R1.5: o contador de tentativa vive em disco, nao em memoria de processo.
CREATE TABLE IF NOT EXISTS phase_attempts (
  phase        TEXT PRIMARY KEY,
  attempt      INTEGER NOT NULL,
  retries_used INTEGER NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Ancora da cadeia de auditoria, fora do arquivo da trilha.
CREATE TABLE IF NOT EXISTS audit_anchor (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  count     INTEGER NOT NULL,
  head_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- R5.3: indice das paginas de memoria. O registro canonico e o arquivo em
-- .harness/memory/pages/, e content_sha256 e o que decide se a linha ainda
-- vale. Este indice pode ser apagado e reconstruido sem perda.
CREATE TABLE IF NOT EXISTS memory_pages (
  slug           TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  kind           TEXT NOT NULL,
  pinned         INTEGER NOT NULL DEFAULT 0,
  phase          TEXT,
  tags           TEXT NOT NULL DEFAULT '[]',
  source         TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  promoted_to    TEXT,
  content_sha256 TEXT NOT NULL,
  body           TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS memory_pages_updated ON memory_pages(pinned DESC, updated_at DESC);
`;

/**
 * R5.3: a busca e FTS5.
 *
 * Fica fora do SCHEMA principal porque FTS5 e modulo de compilacao do SQLite e
 * pode nao existir no binario em uso. Ausencia vira modo degradado declarado
 * (`mode: "scan"` na resposta da busca e um aviso no `psh doctor`), nunca um
 * comando que morre no meio nem uma busca que responde menos sem avisar.
 */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  slug UNINDEXED,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

export interface EventRow {
  id: string;
  ts: string;
  kind: string;
  from_phase: string | null;
  to_phase: string | null;
  attempt: number;
  verdict: string | null;
  failure_class: string | null;
  evidence_ids: string;
  audit_seq: number | null;
  detail: string;
}

export interface EvidenceRow {
  id: string;
  verifier: string;
  phase: string | null;
  attempt: number;
  status: string;
  value: number | null;
  exit_code: number | null;
  signal: string | null;
  workspace_hash: string | null;
  candidates_examined: number;
  started_at: string;
  finished_at: string;
  artifact: string | null;
  sandbox_mode: string;
}

export interface AttemptRow {
  phase: string;
  attempt: number;
  retries_used: number;
  updated_at: string;
}

export interface MemoryPageRow {
  slug: string;
  title: string;
  kind: string;
  pinned: number;
  phase: string | null;
  tags: string;
  source: string;
  created_at: string;
  updated_at: string;
  promoted_to: string | null;
  content_sha256: string;
  body: string;
}

export class HarnessDb implements AnchorStore {
  readonly db: Database;
  /** Falso quando o SQLite em uso nao traz FTS5. Vira modo `scan` na busca. */
  readonly ftsAvailable: boolean;
  readonly ftsUnavailableReason: string | null;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.run(SCHEMA);
    try {
      this.db.run(FTS_SCHEMA);
      this.ftsAvailable = true;
      this.ftsUnavailableReason = null;
    } catch (cause) {
      this.ftsAvailable = false;
      this.ftsUnavailableReason = (cause as Error).message;
    }
  }

  close(): void {
    this.db.close();
  }

  // --- eventos -----------------------------------------------------------

  insertEvent(row: EventRow): void {
    this.db
      .query(
        `INSERT INTO events (id, ts, kind, from_phase, to_phase, attempt, verdict, failure_class, evidence_ids, audit_seq, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.ts,
        row.kind,
        row.from_phase,
        row.to_phase,
        row.attempt,
        row.verdict,
        row.failure_class,
        row.evidence_ids,
        row.audit_seq,
        row.detail,
      );
  }

  listEvents(limit = 50): EventRow[] {
    return this.db.query(`SELECT * FROM events ORDER BY ts DESC, rowid DESC LIMIT ?`).all(limit) as EventRow[];
  }

  // --- evidencia ---------------------------------------------------------

  insertEvidence(row: EvidenceRow): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO evidence
         (id, verifier, phase, attempt, status, value, exit_code, signal, workspace_hash,
          candidates_examined, started_at, finished_at, artifact, sandbox_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.verifier,
        row.phase,
        row.attempt,
        row.status,
        row.value,
        row.exit_code,
        row.signal,
        row.workspace_hash,
        row.candidates_examined,
        row.started_at,
        row.finished_at,
        row.artifact,
        row.sandbox_mode,
      );
  }

  latestEvidence(verifier: string): EvidenceRow | null {
    return (
      (this.db
        .query(`SELECT * FROM evidence WHERE verifier = ? ORDER BY finished_at DESC, rowid DESC LIMIT 1`)
        .get(verifier) as EvidenceRow | null) ?? null
    );
  }

  // --- tentativas --------------------------------------------------------

  getAttempt(phase: string): AttemptRow | null {
    return (
      (this.db.query(`SELECT * FROM phase_attempts WHERE phase = ?`).get(phase) as AttemptRow | null) ?? null
    );
  }

  putAttempt(row: AttemptRow): void {
    this.db
      .query(
        `INSERT INTO phase_attempts (phase, attempt, retries_used, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(phase) DO UPDATE SET
           attempt = excluded.attempt,
           retries_used = excluded.retries_used,
           updated_at = excluded.updated_at`,
      )
      .run(row.phase, row.attempt, row.retries_used, row.updated_at);
  }

  // --- memoria (R5.3) ----------------------------------------------------

  /** Slug -> hash do arquivo indexado. E a base da decisao de frescor. */
  memoryHashes(): Map<string, string> {
    const rows = this.db.query(`SELECT slug, content_sha256 FROM memory_pages`).all() as {
      slug: string;
      content_sha256: string;
    }[];
    return new Map(rows.map((r) => [r.slug, r.content_sha256]));
  }

  /**
   * `row.body` e o corpo da pagina, usado no trecho da resposta; `ftsText` e o
   * texto indexavel (titulo, tags e corpo). Sao coisas diferentes: quem guarda
   * o texto indexavel na coluna de corpo devolve o titulo duplicado no trecho.
   */
  upsertMemoryPage(row: MemoryPageRow, ftsText: string): void {
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO memory_pages
             (slug, title, kind, pinned, phase, tags, source, created_at, updated_at, promoted_to, content_sha256, body)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(slug) DO UPDATE SET
             title = excluded.title, kind = excluded.kind, pinned = excluded.pinned,
             phase = excluded.phase, tags = excluded.tags, source = excluded.source,
             created_at = excluded.created_at, updated_at = excluded.updated_at,
             promoted_to = excluded.promoted_to, content_sha256 = excluded.content_sha256,
             body = excluded.body`,
        )
        .run(
          row.slug,
          row.title,
          row.kind,
          row.pinned,
          row.phase,
          row.tags,
          row.source,
          row.created_at,
          row.updated_at,
          row.promoted_to,
          row.content_sha256,
          row.body,
        );
      if (this.ftsAvailable) {
        this.db.query(`DELETE FROM memory_fts WHERE slug = ?`).run(row.slug);
        this.db.query(`INSERT INTO memory_fts (slug, text) VALUES (?, ?)`).run(row.slug, ftsText);
      }
    })();
  }

  deleteMemoryPage(slug: string): void {
    this.db.transaction(() => {
      this.db.query(`DELETE FROM memory_pages WHERE slug = ?`).run(slug);
      if (this.ftsAvailable) this.db.query(`DELETE FROM memory_fts WHERE slug = ?`).run(slug);
    })();
  }

  countMemoryPages(opts: { pinnedOnly?: boolean } = {}): number {
    const where = opts.pinnedOnly === true ? `WHERE pinned = 1` : ``;
    return (this.db.query(`SELECT count(*) AS n FROM memory_pages ${where}`).get() as { n: number }).n;
  }

  listMemoryPages(opts: { pinnedOnly?: boolean; limit?: number } = {}): MemoryPageRow[] {
    const limit = opts.limit ?? 100;
    const where = opts.pinnedOnly === true ? `WHERE pinned = 1` : ``;
    return this.db
      .query(`SELECT * FROM memory_pages ${where} ORDER BY pinned DESC, updated_at DESC LIMIT ?`)
      .all(limit) as MemoryPageRow[];
  }

  /**
   * Fixada primeiro, relevancia depois: R5.5 diz que a pagina fixada nao pode
   * ser perdida, e ser empurrada para fora do limite da busca e uma forma de
   * perder.
   */
  searchMemoryFts(matchExpression: string, limit: number): MemoryPageRow[] {
    return this.db
      .query(
        `SELECT p.* FROM memory_fts f
         JOIN memory_pages p ON p.slug = f.slug
         WHERE memory_fts MATCH ?
         ORDER BY p.pinned DESC, bm25(memory_fts)
         LIMIT ?`,
      )
      .all(matchExpression, limit) as MemoryPageRow[];
  }

  /** Modo degradado: varredura por substring, sem stemming e sem ranking. */
  searchMemoryScan(query: string, limit: number): MemoryPageRow[] {
    const termos = query
      .split(/\s+/)
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t !== "");
    if (termos.length === 0) return [];
    const condicoes = termos.map(() => `instr(lower(p.title || ' ' || p.tags || ' ' || p.body), ?) > 0`);
    return this.db
      .query(
        `SELECT p.* FROM memory_pages p
         WHERE ${condicoes.join(" AND ")}
         ORDER BY p.pinned DESC, p.updated_at DESC
         LIMIT ?`,
      )
      .all(...termos, limit) as MemoryPageRow[];
  }

  // --- ancora da trilha --------------------------------------------------

  readAnchor(): AuditAnchor | null {
    const row = this.db.query(`SELECT count, head_hash FROM audit_anchor WHERE id = 1`).get() as
      | { count: number; head_hash: string }
      | null;
    return row ? { count: row.count, head_hash: row.head_hash } : null;
  }

  writeAnchor(anchor: AuditAnchor): void {
    this.db
      .query(
        `INSERT INTO audit_anchor (id, count, head_hash, updated_at) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET count = excluded.count, head_hash = excluded.head_hash, updated_at = excluded.updated_at`,
      )
      .run(anchor.count, anchor.head_hash, new Date().toISOString());
  }
}
