/**
 * Module 2: Storage — SQLite + Temporal Knowledge Graph
 *
 * Schema as specified in the design doc.
 * Exposes typed CRUD helpers used by WAL and Consolidation modules.
 */

import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "../data/context.db");

export type SourceType = "decision" | "fact" | "correction" | "opinion" | "question";
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

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    migrate(_db);
  }
  return _db;
}

/** Replace the singleton with a custom DB instance (for tests). */
export function _setDbForTest(db: Database.Database): void {
  _db?.open && _db.close();
  _db = db;
  migrate(db);
}

// ── Migrations ────────────────────────────────────────────────────────────────

function migrate(db: Database.Database): void {
  db.exec(`
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
      FOREIGN KEY (superseded_by) REFERENCES facts(id)
    );

    CREATE INDEX IF NOT EXISTS idx_facts_valid    ON facts(valid_from, valid_to);
    CREATE INDEX IF NOT EXISTS idx_facts_source   ON facts(source_type);
    CREATE INDEX IF NOT EXISTS idx_facts_tags     ON facts(tags);

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
  `);
}

// ── Facts CRUD ────────────────────────────────────────────────────────────────

export function insertFact(fact: Omit<Fact, "id" | "created_at" | "updated_at">): number {
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO facts
      (content, source, source_type, confidence, valid_from, valid_to,
       created_at, updated_at, superseded_by, tags, raw_message)
    VALUES
      (@content, @source, @source_type, @confidence, @valid_from, @valid_to,
       @created_at, @updated_at, @superseded_by, @tags, @raw_message)
  `);
  const result = stmt.run({
    ...fact,
    valid_to: fact.valid_to ?? null,
    superseded_by: fact.superseded_by ?? null,
    tags: JSON.stringify(fact.tags ?? []),
    raw_message: fact.raw_message ?? null,
    created_at: now,
    updated_at: now,
  });
  return result.lastInsertRowid as number;
}

export function getFact(id: number): Fact | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM facts WHERE id = ?").get(id) as FactRow | undefined;
  return row ? deserializeFact(row) : null;
}

export function getActiveFacts(): Fact[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM facts WHERE valid_to IS NULL ORDER BY created_at DESC")
    .all() as FactRow[];
  return rows.map(deserializeFact);
}

export function expireFact(id: number, supersededById?: number): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE facts SET valid_to = @now, updated_at = @now, superseded_by = @sup WHERE id = @id"
  ).run({ now, sup: supersededById ?? null, id });
}

export function searchFacts(keyword: string, tags: string[] = [], limit = 20): Fact[] {
  const db = getDb();
  const kw = `%${keyword.toLowerCase()}%`;
  let query = "SELECT * FROM facts WHERE valid_to IS NULL AND (LOWER(content) LIKE @kw";
  const params: Record<string, unknown> = { kw, limit };

  if (tags.length > 0) {
    const tagConditions = tags
      .map((t, i) => {
        params[`tag${i}`] = `%"${t}"%`;
        return `tags LIKE @tag${i}`;
      })
      .join(" OR ");
    query += ` OR ${tagConditions}`;
  }

  query += ") ORDER BY confidence DESC, created_at DESC LIMIT @limit";
  const rows = db.prepare(query).all(params) as FactRow[];
  return rows.map(deserializeFact);
}

function deserializeFact(row: FactRow): Fact {
  return {
    ...row,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
  };
}

// ── Relations ─────────────────────────────────────────────────────────────────

export function insertRelation(rel: FactRelation): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO fact_relations (fact_id, related_fact_id, relation_type, created_at)
    VALUES (@fact_id, @related_fact_id, @relation_type, @created_at)
  `).run({ ...rel, created_at: new Date().toISOString() });
}

// ── Consolidation log ─────────────────────────────────────────────────────────

export function logConsolidationPhase(entry: ConsolidationLogEntry): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO consolidation_log
      (run_at, phase, facts_processed, facts_merged, facts_invalidated,
       contradictions_found, duration_ms, notes)
    VALUES
      (@run_at, @phase, @facts_processed, @facts_merged, @facts_invalidated,
       @contradictions_found, @duration_ms, @notes)
  `).run(entry);
}

export function getLastConsolidation(): string | null {
  const db = getDb();
  const row = db
    .prepare("SELECT run_at FROM consolidation_log ORDER BY id DESC LIMIT 1")
    .get() as { run_at: string } | undefined;
  return row?.run_at ?? null;
}

export function getFactCount(): { active: number; expired: number } {
  const db = getDb();
  const active = (
    db.prepare("SELECT COUNT(*) as n FROM facts WHERE valid_to IS NULL").get() as { n: number }
  ).n;
  const expired = (
    db.prepare("SELECT COUNT(*) as n FROM facts WHERE valid_to IS NOT NULL").get() as { n: number }
  ).n;
  return { active, expired };
}
