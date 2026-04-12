/**
 * Module 2: Storage — SQLite + Temporal Knowledge Graph
 *
 * Uses sql.js (pure WASM SQLite) — no native addons needed.
 * Exposes typed CRUD helpers used by WAL and Consolidation modules.
 */

import initSqlJs, { type Database as SqlJsDatabase, type BindParams } from "sql.js";
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

// ── sql.js init ──────────────────────────────────────────────────────────────

let _SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

async function getSqlJs() {
  if (!_SQL) {
    _SQL = await initSqlJs();
  }
  return _SQL;
}

// ── DB connection (singleton) ─────────────────────────────────────────────────

let _db: SqlJsDatabase | null = null;

export async function getDb(): Promise<SqlJsDatabase> {
  if (!_db) {
    const SQL = await getSqlJs();
    if (fs.existsSync(DB_PATH)) {
      const buf = fs.readFileSync(DB_PATH);
      _db = new SQL.Database(buf);
    } else {
      _db = new SQL.Database();
    }
    _db.run("PRAGMA journal_mode = WAL");
    _db.run("PRAGMA foreign_keys = ON");
    migrate(_db);
  }
  return _db;
}

/** Replace the singleton with a custom DB instance (for tests). */
export async function _setDbForTest(db?: SqlJsDatabase): Promise<SqlJsDatabase> {
  if (_db) {
    try { _db.close(); } catch {}
  }
  if (db) {
    _db = db;
  } else {
    const SQL = await getSqlJs();
    _db = new SQL.Database();
    _db.run("PRAGMA foreign_keys = ON");
  }
  migrate(_db);
  return _db;
}

/** Persist current DB state to disk. */
export function saveDb(): void {
  if (!_db) return;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const data = _db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// ── Migrations ────────────────────────────────────────────────────────────────

function migrate(db: SqlJsDatabase): void {
  db.run(`
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
      FOREIGN KEY (superseded_by) REFERENCES facts(id)
    );
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_facts_valid    ON facts(valid_from, valid_to)");
  db.run("CREATE INDEX IF NOT EXISTS idx_facts_source   ON facts(source_type)");
  db.run("CREATE INDEX IF NOT EXISTS idx_facts_tags     ON facts(tags)");
  db.run("CREATE INDEX IF NOT EXISTS idx_facts_message  ON facts(message_id)");

  db.run(`
    CREATE TABLE IF NOT EXISTS fact_relations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      fact_id         INTEGER NOT NULL,
      related_fact_id INTEGER NOT NULL,
      relation_type   TEXT    NOT NULL,
      created_at      TEXT    NOT NULL,
      FOREIGN KEY (fact_id)         REFERENCES facts(id),
      FOREIGN KEY (related_fact_id) REFERENCES facts(id)
    );
  `);

  db.run(`
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

  db.run(`
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
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_drift_run ON drift_findings(run_at)");
  db.run("CREATE INDEX IF NOT EXISTS idx_drift_unanswered ON drift_findings(addressed, question)");
}

// ── Query helpers ─────────────────────────────────────────────────────────────

/** Run a SELECT and return rows as typed objects. */
function queryAll<T>(db: SqlJsDatabase, sql: string, params: BindParams = {}): T[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: T[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return rows;
}

function queryOne<T>(db: SqlJsDatabase, sql: string, params: BindParams = {}): T | undefined {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let row: T | undefined;
  if (stmt.step()) {
    row = stmt.getAsObject() as T;
  }
  stmt.free();
  return row;
}

/** sql.js uses $param syntax for named parameters. Convert @param → $param. */
function convertParams(params: Record<string, unknown>): BindParams {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    out[`$${k}`] = v ?? null;
  }
  return out as BindParams;
}

/** Convert @param placeholders in SQL to $param for sql.js. */
function sqlParams(sql: string): string {
  return sql.replace(/@(\w+)/g, "$$$1");
}

// ── Facts CRUD ────────────────────────────────────────────────────────────────

export async function insertFact(fact: Omit<Fact, "id" | "created_at" | "updated_at">): Promise<number> {
  const db = await getDb();
  const now = new Date().toISOString();
  db.run(
    sqlParams(`
      INSERT INTO facts
        (content, source, source_type, confidence, valid_from, valid_to,
         created_at, updated_at, superseded_by, tags, raw_message,
         message_id, source_url, source_file)
      VALUES
        (@content, @source, @source_type, @confidence, @valid_from, @valid_to,
         @created_at, @updated_at, @superseded_by, @tags, @raw_message,
         @message_id, @source_url, @source_file)
    `),
    convertParams({
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
    })
  );
  const row = queryOne<{ id: number }>(db, "SELECT last_insert_rowid() as id");
  const id = row!.id;
  saveDb();
  return id;
}

export async function getFact(id: number): Promise<Fact | null> {
  const db = await getDb();
  const row = queryOne<FactRow>(db, sqlParams("SELECT * FROM facts WHERE id = @id"), convertParams({ id }));
  return row ? deserializeFact(row) : null;
}

export async function getActiveFacts(): Promise<Fact[]> {
  const db = await getDb();
  const rows = queryAll<FactRow>(
    db,
    "SELECT * FROM facts WHERE valid_to IS NULL ORDER BY created_at DESC"
  );
  return rows.map(deserializeFact);
}

export async function expireFact(id: number, supersededById?: number): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  db.run(
    sqlParams("UPDATE facts SET valid_to = @now, updated_at = @now, superseded_by = @sup WHERE id = @id"),
    convertParams({ now, sup: supersededById ?? null, id })
  );
  saveDb();
}

export async function searchFacts(keyword: string, tags: string[] = [], limit = 20): Promise<Fact[]> {
  const db = await getDb();
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
  const rows = queryAll<FactRow>(db, sqlParams(query), convertParams(params));
  return rows.map(deserializeFact);
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
  db.run(
    sqlParams(`
      INSERT INTO fact_relations (fact_id, related_fact_id, relation_type, created_at)
      VALUES (@fact_id, @related_fact_id, @relation_type, @created_at)
    `),
    convertParams({ ...rel, created_at: new Date().toISOString() })
  );
  saveDb();
}

// ── Consolidation log ─────────────────────────────────────────────────────────

export async function logConsolidationPhase(entry: ConsolidationLogEntry): Promise<void> {
  const db = await getDb();
  db.run(
    sqlParams(`
      INSERT INTO consolidation_log
        (run_at, phase, facts_processed, facts_merged, facts_invalidated,
         contradictions_found, duration_ms, notes)
      VALUES
        (@run_at, @phase, @facts_processed, @facts_merged, @facts_invalidated,
         @contradictions_found, @duration_ms, @notes)
    `),
    convertParams({ ...entry } as Record<string, unknown>)
  );
  saveDb();
}

/** Count distinct consolidation runs (one per unique run_at in the log). */
export async function getConsolidationRunCount(): Promise<number> {
  const db = await getDb();
  const row = queryOne<{ n: number }>(
    db,
    "SELECT COUNT(DISTINCT run_at) as n FROM consolidation_log"
  );
  return row?.n ?? 0;
}

export async function getLastConsolidation(): Promise<string | null> {
  const db = await getDb();
  const row = queryOne<{ run_at: string }>(
    db,
    "SELECT run_at FROM consolidation_log ORDER BY id DESC LIMIT 1"
  );
  return row?.run_at ?? null;
}

export async function getFactCount(): Promise<{ active: number; expired: number }> {
  const db = await getDb();
  const active = queryOne<{ n: number }>(
    db,
    "SELECT COUNT(*) as n FROM facts WHERE valid_to IS NULL"
  )!.n;
  const expired = queryOne<{ n: number }>(
    db,
    "SELECT COUNT(*) as n FROM facts WHERE valid_to IS NOT NULL"
  )!.n;
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
  db.run(
    sqlParams(`
      INSERT INTO drift_findings (run_at, fact_id, consistent, evidence, question, addressed)
      VALUES (@run_at, @fact_id, @consistent, @evidence, @question, 0)
    `),
    convertParams({
      run_at: finding.run_at,
      fact_id: finding.fact_id,
      consistent: finding.consistent ? 1 : 0,
      evidence: finding.evidence ?? null,
      question: finding.question ?? null,
    })
  );
  const row = queryOne<{ id: number }>(db, "SELECT last_insert_rowid() as id");
  saveDb();
  return row!.id;
}

export async function getDriftFindings(runAt?: string): Promise<DriftFinding[]> {
  const db = await getDb();
  if (runAt) {
    return queryAll<DriftFindingRow>(
      db,
      sqlParams("SELECT * FROM drift_findings WHERE run_at = @run_at ORDER BY id"),
      convertParams({ run_at: runAt })
    ).map(deserializeDriftFinding);
  }
  // Latest run
  const latest = queryOne<{ run_at: string }>(
    db,
    "SELECT run_at FROM drift_findings ORDER BY id DESC LIMIT 1"
  );
  if (!latest) return [];
  return queryAll<DriftFindingRow>(
    db,
    sqlParams("SELECT * FROM drift_findings WHERE run_at = @run_at ORDER BY id"),
    convertParams({ run_at: latest.run_at })
  ).map(deserializeDriftFinding);
}

export async function getUnansweredQuestions(): Promise<DriftFinding[]> {
  const db = await getDb();
  return queryAll<DriftFindingRow>(
    db,
    "SELECT * FROM drift_findings WHERE addressed = 0 AND question IS NOT NULL ORDER BY run_at DESC, id"
  ).map(deserializeDriftFinding);
}
