/**
 * Module 2: Storage — SQLite + Temporal Knowledge Graph
 *
 * Uses better-sqlite3 (native). Functions stay async-typed for caller compatibility.
 */

import Database from "better-sqlite3";
type DB = Database.Database;
import * as sqliteVec from "sqlite-vec";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "../data/context.db");

export type SourceType = "decision" | "fact" | "correction" | "opinion" | "question" | "summary";
export type Confidence = "low" | "medium" | "high";
export type RelationType = "contradicts" | "supports" | "supersedes" | "related";

export interface Fact {
  id?: number;
  content: string;
  source: string;
  source_type: SourceType;
  confidence: Confidence;
  valid_from: string;
  valid_to: string | null;
  created_at: string;
  updated_at: string;
  superseded_by: number | null;
  tags: string[];
  raw_message: string | null;
  message_id: string | null;
  source_url: string | null;
  source_file: string | null;
  document_id?: number | null;
}

export interface FactRow {
  id: number;
  content: string;
  source: string;
  source_type: SourceType;
  confidence: Confidence;
  valid_from: string;
  valid_to: string | null;
  created_at: string;
  updated_at: string;
  superseded_by: number | null;
  tags: string; // JSON string in DB
  raw_message: string | null;
  message_id: string | null;
  source_url: string | null;
  source_file: string | null;
  document_id: number | null;
}

export interface Document {
  id?: number;
  source: string;
  source_file: string | null;
  source_url: string | null;
  message_id: string | null;
  content: string;
  tags: string[];
  created_at: string;
}

export interface DocumentRow {
  id: number;
  source: string;
  source_file: string | null;
  source_url: string | null;
  message_id: string | null;
  content: string;
  tags: string; // JSON string in DB
  created_at: string;
}

export interface FactRelation {
  fact_id: number;
  related_fact_id: number;
  relation_type: RelationType;
}

export interface ConsolidationLogEntry {
  run_at: string;
  phase: string;
  facts_processed: number;
  facts_merged: number;
  facts_invalidated: number;
  contradictions_found: number;
  duration_ms: number;
  notes: string | null;
}

// ── DB connection (singleton) ─────────────────────────────────────────────────

let _db: DB | null = null;
let _vecLoaded = false;

export function hasVecSupport(): boolean {
  return _vecLoaded;
}

export async function getDb(): Promise<DB> {
  if (!_db) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    try {
      sqliteVec.load(_db);
      _vecLoaded = true;
    } catch (e: unknown) {
      console.error("[context-agent] sqlite-vec not loaded:", (e as Error).message);
    }
    migrate(_db);
  }
  return _db;
}

/** Replace the singleton with a fresh in-memory DB (for tests). */
export async function _setDbForTest(db?: DB): Promise<DB> {
  if (_db) {
    try { _db.close(); } catch {}
  }
  _db = db ?? new Database(":memory:");
  _db.pragma("foreign_keys = ON");
  try {
    sqliteVec.load(_db);
    _vecLoaded = true;
  } catch {
    _vecLoaded = false;
  }
  migrate(_db);
  return _db;
}

// ── Migrations ────────────────────────────────────────────────────────────────

function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source          TEXT    NOT NULL,
      source_file     TEXT,
      source_url      TEXT,
      message_id      TEXT,
      content         TEXT    NOT NULL,
      tags            TEXT,
      created_at      TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_documents_source  ON documents(source);
    CREATE INDEX IF NOT EXISTS idx_documents_message ON documents(message_id);
    CREATE INDEX IF NOT EXISTS idx_documents_file    ON documents(source_file);

    CREATE TABLE IF NOT EXISTS facts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      content         TEXT    NOT NULL,
      source          TEXT    NOT NULL,
      source_type     TEXT    NOT NULL,
      confidence      TEXT    DEFAULT 'medium',
      valid_from      TEXT    NOT NULL,
      valid_to        TEXT,
      created_at      TEXT    NOT NULL,
      updated_at      TEXT    NOT NULL,
      superseded_by   INTEGER,
      tags            TEXT,
      raw_message     TEXT,
      message_id      TEXT,
      source_url      TEXT,
      source_file     TEXT,
      document_id     INTEGER,
      FOREIGN KEY (superseded_by) REFERENCES facts(id),
      FOREIGN KEY (document_id)   REFERENCES documents(id)
    );
    CREATE INDEX IF NOT EXISTS idx_facts_valid    ON facts(valid_from, valid_to);
    CREATE INDEX IF NOT EXISTS idx_facts_source   ON facts(source_type);
    CREATE INDEX IF NOT EXISTS idx_facts_tags     ON facts(tags);
    CREATE INDEX IF NOT EXISTS idx_facts_message  ON facts(message_id);
    CREATE INDEX IF NOT EXISTS idx_facts_document ON facts(document_id);

    CREATE TABLE IF NOT EXISTS fact_relations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      fact_id         INTEGER NOT NULL,
      related_fact_id INTEGER NOT NULL,
      relation_type   TEXT    NOT NULL,
      created_at      TEXT    NOT NULL,
      FOREIGN KEY (fact_id)         REFERENCES facts(id),
      FOREIGN KEY (related_fact_id) REFERENCES facts(id)
    );

    CREATE TABLE IF NOT EXISTS consolidation_log (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at               TEXT    NOT NULL,
      phase                TEXT    NOT NULL,
      facts_processed      INTEGER,
      facts_merged         INTEGER,
      facts_invalidated    INTEGER,
      contradictions_found INTEGER,
      duration_ms          INTEGER,
      notes                TEXT
    );

    CREATE TABLE IF NOT EXISTS drift_findings (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at          TEXT    NOT NULL,
      fact_id         INTEGER NOT NULL,
      consistent      INTEGER NOT NULL DEFAULT 0,
      evidence        TEXT,
      question        TEXT,
      addressed       INTEGER NOT NULL DEFAULT 0,
      addressed_at    TEXT,
      FOREIGN KEY (fact_id) REFERENCES facts(id)
    );
    CREATE INDEX IF NOT EXISTS idx_drift_run ON drift_findings(run_at);
    CREATE INDEX IF NOT EXISTS idx_drift_unanswered ON drift_findings(addressed, question);
  `);

  migrateFts5(db);
  migrateDocumentsFts5(db);
  migrateVec0(db);
}

// External-content FTS5: no row duplication; triggers keep it in sync.
// Backfills from `facts` on first creation so existing DBs gain search.
function migrateFts5(db: DB): void {
  const existing = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='facts_fts'")
    .get();
  if (existing) return;

  db.exec(`
    CREATE VIRTUAL TABLE facts_fts USING fts5(
      content,
      tags,
      content='facts',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN
      INSERT INTO facts_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
    END;

    CREATE TRIGGER facts_ad AFTER DELETE ON facts BEGIN
      INSERT INTO facts_fts(facts_fts, rowid, content, tags) VALUES ('delete', old.id, old.content, old.tags);
    END;

    CREATE TRIGGER facts_au AFTER UPDATE ON facts BEGIN
      INSERT INTO facts_fts(facts_fts, rowid, content, tags) VALUES ('delete', old.id, old.content, old.tags);
      INSERT INTO facts_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
    END;

    INSERT INTO facts_fts(rowid, content, tags)
      SELECT id, content, COALESCE(tags, '') FROM facts;
  `);
}

function migrateDocumentsFts5(db: DB): void {
  const existing = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='documents_fts'")
    .get();
  if (existing) return;

  db.exec(`
    CREATE VIRTUAL TABLE documents_fts USING fts5(
      content,
      tags,
      content='documents',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
    END;

    CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, content, tags) VALUES ('delete', old.id, old.content, old.tags);
    END;

    CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, content, tags) VALUES ('delete', old.id, old.content, old.tags);
      INSERT INTO documents_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
    END;

    INSERT INTO documents_fts(rowid, content, tags)
      SELECT id, content, COALESCE(tags, '') FROM documents;
  `);
}

// vec0 virtual table for embedding vectors. Only created if sqlite-vec loaded.
function migrateVec0(db: DB): void {
  if (!_vecLoaded) return;
  const existing = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fact_embeddings'")
    .get();
  if (existing) return;

  db.exec(`
    CREATE VIRTUAL TABLE fact_embeddings USING vec0(
      embedding float[512]
    );
  `);
}

// ── Facts CRUD ────────────────────────────────────────────────────────────────

export async function insertFact(fact: Omit<Fact, "id" | "created_at" | "updated_at">): Promise<number> {
  const db = await getDb();
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO facts
        (content, source, source_type, confidence, valid_from, valid_to,
         created_at, updated_at, superseded_by, tags, raw_message,
         message_id, source_url, source_file, document_id)
       VALUES
        (@content, @source, @source_type, @confidence, @valid_from, @valid_to,
         @created_at, @updated_at, @superseded_by, @tags, @raw_message,
         @message_id, @source_url, @source_file, @document_id)`
    )
    .run({
      content: fact.content,
      source: fact.source,
      source_type: fact.source_type,
      confidence: fact.confidence,
      valid_from: fact.valid_from,
      valid_to: fact.valid_to ?? null,
      created_at: now,
      updated_at: now,
      superseded_by: fact.superseded_by ?? null,
      tags: JSON.stringify(fact.tags ?? []),
      raw_message: fact.raw_message ?? null,
      message_id: fact.message_id ?? null,
      source_url: fact.source_url ?? null,
      source_file: fact.source_file ?? null,
      document_id: fact.document_id ?? null,
    });
  return Number(info.lastInsertRowid);
}

// ── Documents CRUD ────────────────────────────────────────────────────────────

export async function insertDocument(doc: Omit<Document, "id" | "created_at">): Promise<number> {
  const db = await getDb();
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO documents (source, source_file, source_url, message_id, content, tags, created_at)
       VALUES (@source, @source_file, @source_url, @message_id, @content, @tags, @created_at)`
    )
    .run({
      source: doc.source,
      source_file: doc.source_file ?? null,
      source_url: doc.source_url ?? null,
      message_id: doc.message_id ?? null,
      content: doc.content,
      tags: JSON.stringify(doc.tags ?? []),
      created_at: now,
    });
  return Number(info.lastInsertRowid);
}

export async function getDocument(id: number): Promise<Document | null> {
  const db = await getDb();
  const row = db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as DocumentRow | undefined;
  return row ? deserializeDocument(row) : null;
}

export async function getDocumentsByIds(ids: number[]): Promise<Document[]> {
  if (ids.length === 0) return [];
  const db = await getDb();
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM documents WHERE id IN (${placeholders})`)
    .all(...ids) as DocumentRow[];
  return rows.map(deserializeDocument);
}

export async function searchDocuments(keyword: string, limit = 10): Promise<Document[]> {
  const db = await getDb();
  const kw = keyword.trim();
  if (!kw) return [];
  const matchExpr = ftsMatchExpression(kw);
  const rows = db
    .prepare(
      `SELECT d.*
         FROM documents_fts
         JOIN documents d ON d.id = documents_fts.rowid
        WHERE documents_fts MATCH ?
        ORDER BY bm25(documents_fts), d.created_at DESC
        LIMIT ?`
    )
    .all(matchExpr, limit) as DocumentRow[];
  return rows.map(deserializeDocument);
}

function deserializeDocument(row: DocumentRow): Document {
  return {
    ...row,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
  };
}

export async function getFact(id: number): Promise<Fact | null> {
  const db = await getDb();
  const row = db.prepare("SELECT * FROM facts WHERE id = ?").get(id) as FactRow | undefined;
  return row ? deserializeFact(row) : null;
}

export async function getFactsByIds(ids: number[]): Promise<Fact[]> {
  if (ids.length === 0) return [];
  const db = await getDb();
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM facts WHERE id IN (${placeholders})`)
    .all(...ids) as FactRow[];
  return rows.map(deserializeFact);
}

export async function getActiveFacts(): Promise<Fact[]> {
  const db = await getDb();
  const rows = db
    .prepare("SELECT * FROM facts WHERE valid_to IS NULL ORDER BY created_at DESC")
    .all() as FactRow[];
  return rows.map(deserializeFact);
}

export async function expireFact(id: number, supersededById?: number): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE facts SET valid_to = @now, updated_at = @now, superseded_by = @sup WHERE id = @id"
  ).run({ now, sup: supersededById ?? null, id });
  // Clean up embedding for expired fact
  if (_vecLoaded) {
    db.prepare("DELETE FROM fact_embeddings WHERE rowid = ?").run(BigInt(id));
  }
}

export async function searchFacts(keyword: string, tags: string[] = [], limit = 20): Promise<Fact[]> {
  const db = await getDb();
  const kw = keyword.trim();

  // No keyword → tag-only filter (fallback to base table), or empty list.
  if (!kw) {
    if (tags.length === 0) return [];
    const tagClauses = tags.map((_, i) => `tags LIKE @tag${i}`).join(" OR ");
    const params: Record<string, unknown> = { limit };
    tags.forEach((t, i) => { params[`tag${i}`] = `%"${t}"%`; });
    const rows = db
      .prepare(
        `SELECT * FROM facts
         WHERE valid_to IS NULL AND (${tagClauses})
         ORDER BY confidence DESC, created_at DESC
         LIMIT @limit`
      )
      .all(params) as FactRow[];
    return rows.map(deserializeFact);
  }

  // FTS5 MATCH + bm25 ranking, joined back to facts for full row.
  const matchExpr = ftsMatchExpression(kw);
  const params: Record<string, unknown> = { match: matchExpr, limit };
  let tagClause = "";
  if (tags.length > 0) {
    const ors = tags.map((_, i) => `f.tags LIKE @tag${i}`).join(" OR ");
    tagClause = `OR (${ors})`;
    tags.forEach((t, i) => { params[`tag${i}`] = `%"${t}"%`; });
  }

  const rows = db
    .prepare(
      `SELECT f.*
         FROM facts_fts
         JOIN facts f ON f.id = facts_fts.rowid
        WHERE f.valid_to IS NULL
          AND (facts_fts MATCH @match ${tagClause})
        ORDER BY bm25(facts_fts), f.confidence DESC, f.created_at DESC
        LIMIT @limit`
    )
    .all(params) as FactRow[];
  return rows.map(deserializeFact);
}

// Quote each token so FTS5 operators (" ( ) *) are treated as literals.
function ftsMatchExpression(kw: string): string {
  const tokens = kw
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '""'))
    .filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t}"`).join(" ");
}

function deserializeFact(row: FactRow): Fact {
  return {
    ...row,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
  };
}

// ── Relations ─────────────────────────────────────────────────────────────────

export async function insertRelation(rel: FactRelation): Promise<void> {
  const db = await getDb();
  db.prepare(
    `INSERT INTO fact_relations (fact_id, related_fact_id, relation_type, created_at)
     VALUES (@fact_id, @related_fact_id, @relation_type, @created_at)`
  ).run({ ...rel, created_at: new Date().toISOString() });
}

// ── Consolidation log ─────────────────────────────────────────────────────────

export async function logConsolidationPhase(entry: ConsolidationLogEntry): Promise<void> {
  const db = await getDb();
  db.prepare(
    `INSERT INTO consolidation_log
       (run_at, phase, facts_processed, facts_merged, facts_invalidated,
        contradictions_found, duration_ms, notes)
     VALUES
       (@run_at, @phase, @facts_processed, @facts_merged, @facts_invalidated,
        @contradictions_found, @duration_ms, @notes)`
  ).run({ ...entry } as Record<string, unknown>);
}

export async function getConsolidationRunCount(): Promise<number> {
  const db = await getDb();
  const row = db
    .prepare("SELECT COUNT(DISTINCT run_at) as n FROM consolidation_log")
    .get() as { n: number } | undefined;
  return row?.n ?? 0;
}

export async function getLastConsolidation(): Promise<string | null> {
  const db = await getDb();
  const row = db
    .prepare("SELECT run_at FROM consolidation_log ORDER BY id DESC LIMIT 1")
    .get() as { run_at: string } | undefined;
  return row?.run_at ?? null;
}

export async function getFactCount(): Promise<{ active: number; expired: number }> {
  const db = await getDb();
  const active = (db
    .prepare("SELECT COUNT(*) as n FROM facts WHERE valid_to IS NULL")
    .get() as { n: number }).n;
  const expired = (db
    .prepare("SELECT COUNT(*) as n FROM facts WHERE valid_to IS NOT NULL")
    .get() as { n: number }).n;
  return { active, expired };
}

// ── Drift findings ───────────────────────────────────────────────────────────

export interface DriftFinding {
  id?: number;
  run_at: string;
  fact_id: number;
  consistent: boolean;
  evidence: string | null;
  question: string | null;
  addressed: boolean;
  addressed_at: string | null;
}

interface DriftFindingRow {
  id: number;
  run_at: string;
  fact_id: number;
  consistent: number;
  evidence: string | null;
  question: string | null;
  addressed: number;
  addressed_at: string | null;
}

function deserializeDriftFinding(row: DriftFindingRow): DriftFinding {
  return { ...row, consistent: row.consistent === 1, addressed: row.addressed === 1 };
}

export async function insertDriftFinding(
  finding: Omit<DriftFinding, "id" | "addressed" | "addressed_at">
): Promise<number> {
  const db = await getDb();
  const info = db
    .prepare(
      `INSERT INTO drift_findings (run_at, fact_id, consistent, evidence, question, addressed)
       VALUES (@run_at, @fact_id, @consistent, @evidence, @question, 0)`
    )
    .run({
      run_at: finding.run_at,
      fact_id: finding.fact_id,
      consistent: finding.consistent ? 1 : 0,
      evidence: finding.evidence ?? null,
      question: finding.question ?? null,
    });
  return Number(info.lastInsertRowid);
}

export async function getDriftFindings(runAt?: string): Promise<DriftFinding[]> {
  const db = await getDb();
  if (runAt) {
    return (db
      .prepare("SELECT * FROM drift_findings WHERE run_at = ? ORDER BY id")
      .all(runAt) as DriftFindingRow[]).map(deserializeDriftFinding);
  }
  const latest = db
    .prepare("SELECT run_at FROM drift_findings ORDER BY id DESC LIMIT 1")
    .get() as { run_at: string } | undefined;
  if (!latest) return [];
  return (db
    .prepare("SELECT * FROM drift_findings WHERE run_at = ? ORDER BY id")
    .all(latest.run_at) as DriftFindingRow[]).map(deserializeDriftFinding);
}

export async function getUnansweredQuestions(): Promise<DriftFinding[]> {
  const db = await getDb();
  return (db
    .prepare(
      "SELECT * FROM drift_findings WHERE addressed = 0 AND question IS NOT NULL ORDER BY run_at DESC, id"
    )
    .all() as DriftFindingRow[]).map(deserializeDriftFinding);
}

export async function addressDriftFinding(id: number): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE drift_findings SET addressed = 1, addressed_at = @now WHERE id = @id").run({
    now,
    id,
  });
}

// ── Embeddings (vec0) ───────────────────────────────────────────────────────

export async function insertFactEmbedding(factId: number, embedding: Float32Array): Promise<void> {
  if (!_vecLoaded) return;
  const db = await getDb();
  db.prepare("DELETE FROM fact_embeddings WHERE rowid = ?").run(BigInt(factId));
  db.prepare(
    "INSERT INTO fact_embeddings (rowid, embedding) VALUES (?, ?)"
  ).run(BigInt(factId), embedding);
}

export async function deleteFactEmbedding(factId: number): Promise<void> {
  if (!_vecLoaded) return;
  const db = await getDb();
  db.prepare("DELETE FROM fact_embeddings WHERE rowid = ?").run(BigInt(factId));
}

export async function searchFactsByVector(
  queryEmbedding: Float32Array,
  k = 20,
): Promise<{ factId: number; distance: number }[]> {
  if (!_vecLoaded) return [];
  const db = await getDb();
  const rows = db
    .prepare(
      `SELECT rowid, distance
       FROM fact_embeddings
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ?`
    )
    .all(queryEmbedding, k) as { rowid: number; distance: number }[];
  return rows.map((r) => ({ factId: Number(r.rowid), distance: r.distance }));
}

export async function getFactsWithoutEmbeddings(): Promise<number[]> {
  if (!_vecLoaded) return [];
  const db = await getDb();
  const rows = db
    .prepare(
      `SELECT f.id FROM facts f
       LEFT JOIN fact_embeddings e ON e.rowid = f.id
       WHERE f.valid_to IS NULL AND e.rowid IS NULL
       ORDER BY f.id`
    )
    .all() as { id: number }[];
  return rows.map((r) => r.id);
}
