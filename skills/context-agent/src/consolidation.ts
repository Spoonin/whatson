/**
 * Module 3: Consolidation Loop — 4-phase pipeline
 *
 * Phases: Orient → Gather Signal → Consolidate → Prune & Index
 * Triggered by cron (daily 03:00) or manually via /consolidate.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  getActiveFacts,
  expireFact,
  insertRelation,
  logConsolidationPhase,
  getLastConsolidation,
  getFactCount,
  type Fact,
} from "./storage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../data");
const INDEX_PATH = path.join(DATA_DIR, "INDEX.md");
const SESSION_STATE_PATH = path.join(DATA_DIR, "SESSION-STATE.md");

const INDEX_LINE_BUDGET = 200;
const STALE_DAYS = 30;

export interface ConsolidationSummary {
  runAt: string;
  factsProcessed: number;
  factsMerged: number;
  factsInvalidated: number;
  contradictionsFound: number;
  indexUpdated: boolean;
}

// ── Phase 1: Orient ───────────────────────────────────────────────────────────

interface OrientSnapshot {
  totalActive: number;
  totalExpired: number;
  lastConsolidation: string | null;
  topicGroups: Record<string, number>;
}

function orient(): OrientSnapshot {
  const counts = getFactCount();
  const facts = getActiveFacts();
  const lastConsolidation = getLastConsolidation();

  // Group by first tag (rough topic)
  const topicGroups: Record<string, number> = {};
  for (const f of facts) {
    const tag = f.tags[0] ?? "untagged";
    topicGroups[tag] = (topicGroups[tag] ?? 0) + 1;
  }

  return {
    totalActive: counts.active,
    totalExpired: counts.expired,
    lastConsolidation,
    topicGroups,
  };
}

// ── Phase 2: Gather Signal ────────────────────────────────────────────────────

interface GatherResult {
  newFacts: Fact[];
  sinceDate: string;
}

function gatherSignal(snapshot: OrientSnapshot): GatherResult {
  const sinceDate = snapshot.lastConsolidation ?? new Date(0).toISOString();
  const facts = getActiveFacts();

  // Priority: corrections > decisions > facts > opinions
  const priorityOrder: Record<string, number> = {
    correction: 0,
    decision: 1,
    fact: 2,
    opinion: 3,
  };

  const newFacts = facts
    .filter((f) => f.created_at > sinceDate)
    .sort((a, b) => priorityOrder[a.source_type] - priorityOrder[b.source_type]);

  return { newFacts, sinceDate };
}

// ── Phase 3: Consolidate ──────────────────────────────────────────────────────

interface ConsolidateResult {
  merged: number;
  contradictions: number;
}

function consolidate(newFacts: Fact[], allFacts: Fact[]): ConsolidateResult {
  let merged = 0;
  let contradictions = 0;

  const processed = new Set<number>();

  for (const fact of newFacts) {
    if (processed.has(fact.id!)) continue;

    for (const other of allFacts) {
      if (other.id === fact.id) continue;
      if (processed.has(other.id!)) continue;

      // Duplicate detection — same content, same source_type
      if (
        normalize(fact.content) === normalize(other.content) &&
        fact.source_type === other.source_type
      ) {
        // Keep newer, expire older
        const [keep, expire] =
          fact.created_at >= other.created_at
            ? [fact, other]
            : [other, fact];

        expireFact(expire.id!, keep.id!);
        insertRelation({
          fact_id: keep.id!,
          related_fact_id: expire.id!,
          relation_type: "supersedes",
        });
        processed.add(expire.id!);
        merged++;
        continue;
      }

      // Contradiction detection — same topic, conflicting types
      if (
        fact.source_type === "correction" &&
        other.source_type !== "correction" &&
        contentOverlaps(fact.content, other.content)
      ) {
        expireFact(other.id!, fact.id!);
        insertRelation({
          fact_id: fact.id!,
          related_fact_id: other.id!,
          relation_type: "contradicts",
        });
        processed.add(other.id!);
        contradictions++;
      }
    }

    processed.add(fact.id!);
  }

  return { merged, contradictions };
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function contentOverlaps(a: string, b: string): boolean {
  const wordsA = new Set(normalize(a).split(" ").filter((w) => w.length > 4));
  const wordsB = normalize(b).split(" ").filter((w) => w.length > 4);
  const overlap = wordsB.filter((w) => wordsA.has(w));
  return overlap.length >= 2;
}

// ── Phase 4: Prune & Index ────────────────────────────────────────────────────

function pruneAndIndex(snapshot: OrientSnapshot): { invalidated: number } {
  const facts = getActiveFacts();
  const cutoff = new Date(Date.now() - STALE_DAYS * 86400 * 1000).toISOString();
  let invalidated = 0;

  for (const f of facts) {
    if (f.valid_from < cutoff && f.confidence === "low") {
      expireFact(f.id!);
      invalidated++;
    }
  }

  // Refresh counts after pruning so the index reflects the current state
  const freshCounts = getFactCount();
  const freshSnapshot: OrientSnapshot = {
    ...snapshot,
    totalActive: freshCounts.active,
    totalExpired: freshCounts.expired,
  };
  updateIndex(freshSnapshot);
  return { invalidated };
}

function updateIndex(snapshot: OrientSnapshot): void {
  const facts = getActiveFacts();
  const now = new Date().toISOString();

  const lines: string[] = [
    `# Knowledge Index`,
    ``,
    `> Last updated: ${now}`,
    `> Active facts: ${snapshot.totalActive} | Expired: ${snapshot.totalExpired}`,
    `> Last consolidation: ${snapshot.lastConsolidation ?? "never"}`,
    ``,
    `## Topics`,
    ``,
  ];

  for (const [topic, count] of Object.entries(snapshot.topicGroups).sort(
    (a, b) => b[1] - a[1]
  )) {
    lines.push(`- **${topic}**: ${count} facts`);
  }

  lines.push(``, `## Recent Decisions`, ``);
  const decisions = facts
    .filter((f) => f.source_type === "decision")
    .slice(0, 20);

  for (const d of decisions) {
    lines.push(`- [${d.valid_from.slice(0, 10)}] ${d.content} *(${d.source})*`);
  }

  lines.push(``, `## Key Facts`, ``);
  const keyFacts = facts
    .filter((f) => f.source_type === "fact" && f.confidence === "high")
    .slice(0, 30);

  for (const f of keyFacts) {
    lines.push(`- [${f.valid_from.slice(0, 10)}] ${f.content} *(${f.source})*`);
  }

  lines.push(``, `## Open Contradictions`, ``);
  const corrections = facts.filter((f) => f.source_type === "correction").slice(0, 10);
  for (const c of corrections) {
    lines.push(`- [${c.valid_from.slice(0, 10)}] ${c.content} *(${c.source})*`);
  }

  // Enforce line budget
  const trimmed = lines.slice(0, INDEX_LINE_BUDGET);
  if (lines.length > INDEX_LINE_BUDGET) {
    trimmed.push(``, `*(index truncated — ${lines.length - INDEX_LINE_BUDGET} lines over budget)*`);
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(INDEX_PATH, trimmed.join("\n"), "utf-8");
}

// ── Runner ────────────────────────────────────────────────────────────────────

export async function runConsolidation(): Promise<ConsolidationSummary> {
  const runAt = new Date().toISOString();

  // Phase 1
  const t1 = Date.now();
  const snapshot = orient();
  logConsolidationPhase({
    run_at: runAt,
    phase: "orient",
    facts_processed: snapshot.totalActive,
    facts_merged: 0,
    facts_invalidated: 0,
    contradictions_found: 0,
    duration_ms: Date.now() - t1,
    notes: JSON.stringify(snapshot.topicGroups),
  });

  // Phase 2
  const t2 = Date.now();
  const { newFacts, sinceDate } = gatherSignal(snapshot);
  logConsolidationPhase({
    run_at: runAt,
    phase: "gather",
    facts_processed: newFacts.length,
    facts_merged: 0,
    facts_invalidated: 0,
    contradictions_found: 0,
    duration_ms: Date.now() - t2,
    notes: `since ${sinceDate}`,
  });

  // Phase 3
  const t3 = Date.now();
  const allFacts = getActiveFacts();
  const { merged, contradictions } = consolidate(newFacts, allFacts);
  logConsolidationPhase({
    run_at: runAt,
    phase: "consolidate",
    facts_processed: newFacts.length,
    facts_merged: merged,
    facts_invalidated: 0,
    contradictions_found: contradictions,
    duration_ms: Date.now() - t3,
    notes: null,
  });

  // Phase 4
  const t4 = Date.now();
  const { invalidated } = pruneAndIndex(snapshot);
  logConsolidationPhase({
    run_at: runAt,
    phase: "prune",
    facts_processed: allFacts.length,
    facts_merged: 0,
    facts_invalidated: invalidated,
    contradictions_found: 0,
    duration_ms: Date.now() - t4,
    notes: null,
  });

  return {
    runAt,
    factsProcessed: newFacts.length,
    factsMerged: merged,
    factsInvalidated: invalidated,
    contradictionsFound: contradictions,
    indexUpdated: true,
  };
}
