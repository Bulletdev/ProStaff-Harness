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

export class HarnessDb implements AnchorStore {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.run(SCHEMA);
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
