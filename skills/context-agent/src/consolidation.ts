/**
 * Module 3: Consolidation Loop — 5-phase pipeline
 *
 * Phases: Orient → Gather Signal → Consolidate → Prune & Index → Drift Analysis
 * Triggered by cron (daily 03:00) or manually via /consolidate.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";
import {
  getActiveFacts,
  expireFact,
  insertRelation,
  logConsolidationPhase,
  getLastConsolidation,
  getConsolidationRunCount,
  getFactCount,
  searchFacts,
  type Fact,
  type RelationType,
} from "./storage.js";
import { syncToTargetRepo, type RepoSyncResult } from "./repo-sync.js";
import { runDriftAnalysis, formatDriftSummary, type DriftAnalysisResult } from "./drift.js";

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
  repoSync?: RepoSyncResult | { error: string } | { skipped: string };
  driftAnalysis?: DriftAnalysisResult | { error: string } | { skipped: string };
  report: string;
}

/**
 * Parse the WHATSON_SYNC_EVERY_N_CONSOLIDATION env var.
 * Defaults to 1 (sync on every consolidation). Non-numeric or negative values
 * also default to 1. Zero means "never auto-sync" (manual /sync only).
 */
function parseSyncEveryN(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 1;
  return n;
}

// ── Phase 1: Orient ───────────────────────────────────────────────────────────

interface OrientSnapshot {
  totalActive: number;
  totalExpired: number;
  lastConsolidation: string | null;
  topicGroups: Record<string, number>;
}

async function orient(): Promise<OrientSnapshot> {
  const counts = await getFactCount();
  const facts = await getActiveFacts();
  const lastConsolidation = await getLastConsolidation();

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

async function gatherSignal(snapshot: OrientSnapshot): Promise<GatherResult> {
  const sinceDate = snapshot.lastConsolidation ?? new Date(0).toISOString();
  const facts = await getActiveFacts();

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

// ── Anthropic client (lazy singleton, same pattern as llm-extract.ts) ────────

let _client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  _client = new Anthropic({ apiKey });
  return _client;
}

/** Override client for testing */
export function _setClientForTest(client: Anthropic | null): void {
  _client = client;
}

// ── LLM consolidation types ─────────────────────────────────────────────────

export interface ConsolidationAction {
  action: "merge" | "contradict" | "relate" | "keep";
  keep?: number;
  expire?: number[];
  ids?: number[];
  relation?: string;
  reason?: string;
  id?: number;
}

// ── Clustering: group facts by FTS5 similarity + tag overlap ────────────────

const MAX_CLUSTER_SIZE = 20;

const STOP_WORDS = new Set([
  "the", "a", "an", "in", "on", "at", "to", "for", "of", "with", "by",
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "what", "how", "when", "where", "why", "which", "that", "this", "from",
  "not", "but", "about", "our", "will", "use", "used", "using",
]);

function extractSignificantWords(text: string): string[] {
  return [...new Set(
    text.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/)
      .filter((w) => w.length > 3 && !STOP_WORDS.has(w)),
  )].slice(0, 5);
}

export async function clusterFacts(
  newFacts: Fact[],
  allFacts: Fact[],
  processed: Set<number>,
): Promise<Fact[][]> {
  const allById = new Map(allFacts.map((f) => [f.id!, f]));
  const clusters: Fact[][] = [];

  for (const fact of newFacts) {
    if (processed.has(fact.id!)) continue;

    const clusterIds = new Set<number>([fact.id!]);

    // FTS5 search per keyword (like retrieval.ts does)
    const words = extractSignificantWords(fact.content);
    for (const word of words) {
      if (clusterIds.size >= MAX_CLUSTER_SIZE) break;
      const results = await searchFacts(word, [], 10);
      for (const r of results) {
        if (clusterIds.size >= MAX_CLUSTER_SIZE) break;
        if (!processed.has(r.id!) && allById.has(r.id!)) {
          clusterIds.add(r.id!);
        }
      }
    }

    // Supplement: tag overlap
    if (fact.tags.length > 0) {
      for (const other of allFacts) {
        if (clusterIds.size >= MAX_CLUSTER_SIZE) break;
        if (processed.has(other.id!) || clusterIds.has(other.id!)) continue;
        if (other.tags.some((t) => fact.tags.includes(t))) {
          clusterIds.add(other.id!);
        }
      }
    }

    // Only worth an LLM call if there's more than just the new fact itself
    if (clusterIds.size > 1) {
      const cluster = [...clusterIds]
        .map((id) => allById.get(id))
        .filter((f): f is Fact => f !== undefined);
      clusters.push(cluster);
    }
  }

  return clusters;
}

// ── LLM prompt ──────────────────────────────────────────────────────────────

const CONSOLIDATION_PROMPT = `You are a knowledge base consolidation agent. You are given a cluster of facts from a project knowledge base. Each fact has an ID, content, type, confidence, and date.

Your task is to analyze the cluster and identify:

1. **Duplicates** — facts that express the same information in different words. Keep the most complete/recent version. Expire the others.

2. **Contradictions** — facts that make conflicting claims about the same topic. Keep the most recent or most authoritative (higher confidence). Expire the contradicted fact. If you cannot determine which is correct, keep both.

3. **Relations** — facts that support or are related to each other but are not duplicates. Link them.

Rules:
- A "correction" type always supersedes a non-correction on the same topic.
- Higher confidence supersedes lower confidence, all else equal.
- More recent supersedes older, all else equal.
- When in doubt, keep both facts — false merges lose data, false keeps do not.
- Do NOT invent new facts or modify existing fact text.

Respond ONLY with a JSON array of actions (no markdown fences, no explanation):

[
  {"action": "merge", "keep": 5, "expire": [3], "reason": "Same decision about PostgreSQL"},
  {"action": "contradict", "keep": 12, "expire": [2], "reason": "Correction supersedes original"},
  {"action": "relate", "ids": [5, 14], "relation": "supports", "reason": "Both about DB choice"},
  {"action": "keep", "id": 7}
]

If no actions are needed, respond with: []`;

// ── LLM call for one cluster ────────────────────────────────────────────────

async function consolidateClusterLlm(cluster: Fact[]): Promise<ConsolidationAction[]> {
  const client = getClient();
  if (!client) return [];

  const factsBlock = cluster
    .map((f) => `- ID:${f.id} [${f.source_type}] (confidence:${f.confidence}, date:${f.valid_from.slice(0, 10)}) "${f.content}"`)
    .join("\n");

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: CONSOLIDATION_PROMPT,
      messages: [{ role: "user", content: `Analyze this cluster:\n\n${factsBlock}` }],
    });

    const content = response.content[0];
    if (content.type !== "text") return [];

    const validIds = new Set(cluster.map((f) => f.id!));
    return parseConsolidationResponse(content.text, validIds);
  } catch (err) {
    console.error("[consolidation] LLM call failed, skipping cluster:", err);
    return [];
  }
}

// ── Response parsing (defensive, same pattern as llm-extract.ts) ────────────

const VALID_ACTIONS = new Set(["merge", "contradict", "relate", "keep"]);
const VALID_RELATIONS: Set<string> = new Set(["contradicts", "supports", "supersedes", "related"]);

export function parseConsolidationResponse(
  text: string,
  validIds: Set<number>,
): ConsolidationAction[] {
  let jsonStr = text.trim();

  // Strip markdown code fences
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  let raw: unknown;
  try {
    raw = JSON.parse(jsonStr);
  } catch {
    const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (!arrayMatch) return [];
    try {
      raw = JSON.parse(arrayMatch[0]);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(raw)) return [];

  const results: ConsolidationAction[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const a = item as Record<string, unknown>;

    if (!VALID_ACTIONS.has(a.action as string)) continue;
    const action = a.action as ConsolidationAction["action"];

    if (action === "merge" || action === "contradict") {
      const keep = Number(a.keep);
      const expire = Array.isArray(a.expire) ? a.expire.map(Number).filter(Number.isFinite) : [];
      if (!validIds.has(keep) || expire.length === 0) continue;
      if (expire.some((id) => !validIds.has(id))) continue;
      if (expire.includes(keep)) continue;
      results.push({ action, keep, expire, reason: String(a.reason ?? "") });
    } else if (action === "relate") {
      const ids = Array.isArray(a.ids) ? a.ids.map(Number).filter(Number.isFinite) : [];
      if (ids.length < 2 || ids.some((id) => !validIds.has(id))) continue;
      const relation = VALID_RELATIONS.has(a.relation as string) ? (a.relation as string) : "related";
      results.push({ action, ids, relation, reason: String(a.reason ?? "") });
    }
    // "keep" actions are no-ops — skip them silently
  }

  return results;
}

// ── Execute LLM actions ─────────────────────────────────────────────────────

async function executeActions(
  actions: ConsolidationAction[],
  processed: Set<number>,
): Promise<{ merged: number; contradictions: number }> {
  let merged = 0;
  let contradictions = 0;

  for (const a of actions) {
    if (a.action === "merge" && a.keep && a.expire) {
      for (const expId of a.expire) {
        if (processed.has(expId)) continue;
        await expireFact(expId, a.keep);
        await insertRelation({
          fact_id: a.keep,
          related_fact_id: expId,
          relation_type: "supersedes",
        });
        processed.add(expId);
        merged++;
      }
    } else if (a.action === "contradict" && a.keep && a.expire) {
      for (const expId of a.expire) {
        if (processed.has(expId)) continue;
        await expireFact(expId, a.keep);
        await insertRelation({
          fact_id: a.keep,
          related_fact_id: expId,
          relation_type: "contradicts",
        });
        processed.add(expId);
        contradictions++;
      }
    } else if (a.action === "relate" && a.ids && a.ids.length >= 2) {
      const relation = (a.relation as RelationType) ?? "related";
      for (let i = 1; i < a.ids.length; i++) {
        await insertRelation({
          fact_id: a.ids[0],
          related_fact_id: a.ids[i],
          relation_type: relation,
        });
      }
    }
  }

  return { merged, contradictions };
}

// ── Main consolidate: LLM path with heuristic fallback ─────────────────────

async function consolidate(newFacts: Fact[], allFacts: Fact[]): Promise<ConsolidateResult> {
  const processed = new Set<number>();
  let totalMerged = 0;
  let totalContradictions = 0;

  // Try LLM path
  const client = getClient();
  if (client && newFacts.length > 0) {
    const clusters = await clusterFacts(newFacts, allFacts, processed);

    for (const cluster of clusters) {
      // Skip clusters where all facts are already processed
      const live = cluster.filter((f) => !processed.has(f.id!));
      if (live.length < 2) continue;

      const actions = await consolidateClusterLlm(live);
      const { merged, contradictions } = await executeActions(actions, processed);
      totalMerged += merged;
      totalContradictions += contradictions;
    }
  }

  // Heuristic fallback for any new facts not covered by LLM clusters
  const heuristic = await consolidateHeuristic(newFacts, allFacts, processed);
  totalMerged += heuristic.merged;
  totalContradictions += heuristic.contradictions;

  return { merged: totalMerged, contradictions: totalContradictions };
}

// ── Heuristic consolidation (original logic, now fallback) ──────────────────

async function consolidateHeuristic(
  newFacts: Fact[],
  allFacts: Fact[],
  processed: Set<number>,
): Promise<ConsolidateResult> {
  let merged = 0;
  let contradictions = 0;

  for (const fact of newFacts) {
    if (processed.has(fact.id!)) continue;

    for (const other of allFacts) {
      if (other.id === fact.id) continue;
      if (processed.has(other.id!)) continue;

      if (
        normalize(fact.content) === normalize(other.content) &&
        fact.source_type === other.source_type
      ) {
        const [keep, expire] =
          fact.created_at >= other.created_at
            ? [fact, other]
            : [other, fact];

        await expireFact(expire.id!, keep.id!);
        await insertRelation({
          fact_id: keep.id!,
          related_fact_id: expire.id!,
          relation_type: "supersedes",
        });
        processed.add(expire.id!);
        merged++;
        continue;
      }

      if (
        fact.source_type === "correction" &&
        other.source_type !== "correction" &&
        contentOverlaps(fact.content, other.content)
      ) {
        await expireFact(other.id!, fact.id!);
        await insertRelation({
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

export function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function contentOverlaps(a: string, b: string): boolean {
  const wordsA = new Set(normalize(a).split(" ").filter((w) => w.length > 4));
  const wordsB = normalize(b).split(" ").filter((w) => w.length > 4);
  const overlap = wordsB.filter((w) => wordsA.has(w));
  return overlap.length >= 2;
}

// ── Phase 4: Prune & Index ────────────────────────────────────────────────────

async function pruneAndIndex(snapshot: OrientSnapshot): Promise<{ invalidated: number }> {
  const facts = await getActiveFacts();
  const cutoff = new Date(Date.now() - STALE_DAYS * 86400 * 1000).toISOString();
  let invalidated = 0;

  for (const f of facts) {
    if (f.valid_from < cutoff && f.confidence === "low") {
      await expireFact(f.id!);
      invalidated++;
    }
  }

  // Refresh counts after pruning so the index reflects the current state
  const freshCounts = await getFactCount();
  const freshSnapshot: OrientSnapshot = {
    ...snapshot,
    totalActive: freshCounts.active,
    totalExpired: freshCounts.expired,
  };
  await updateIndex(freshSnapshot);
  return { invalidated };
}

async function updateIndex(snapshot: OrientSnapshot): Promise<void> {
  const facts = await getActiveFacts();
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
  const snapshot = await orient();
  await logConsolidationPhase({
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
  const { newFacts, sinceDate } = await gatherSignal(snapshot);
  await logConsolidationPhase({
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
  const allFacts = await getActiveFacts();
  const { merged, contradictions } = await consolidate(newFacts, allFacts);
  await logConsolidationPhase({
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
  const { invalidated } = await pruneAndIndex(snapshot);

  // Export to target repo (if configured). Gated by WHATSON_SYNC_EVERY_N_CONSOLIDATION:
  //   0     → never auto-sync (manual /sync only)
  //   1     → every run (default)
  //   N>1   → every Nth run
  // Failures are captured but must not abort the phase — local state is already committed.
  let repoSync: RepoSyncResult | { error: string } | { skipped: string } | undefined;
  const everyN = parseSyncEveryN(process.env.WHATSON_SYNC_EVERY_N_CONSOLIDATION);
  if (everyN === 0) {
    repoSync = { skipped: "WHATSON_SYNC_EVERY_N_CONSOLIDATION=0 (auto-sync disabled)" };
  } else {
    // getConsolidationRunCount() includes the current run (orient/gather/consolidate
    // have already logged rows with this runAt), so numbering starts at 1.
    const runNumber = await getConsolidationRunCount();
    if (runNumber % everyN !== 0) {
      repoSync = {
        skipped: `run ${runNumber} not a multiple of ${everyN} (WHATSON_SYNC_EVERY_N_CONSOLIDATION)`,
      };
    } else {
      try {
        repoSync = await syncToTargetRepo();
      } catch (e) {
        repoSync = { error: e instanceof Error ? e.message : String(e) };
      }
    }
  }

  await logConsolidationPhase({
    run_at: runAt,
    phase: "prune",
    facts_processed: allFacts.length,
    facts_merged: 0,
    facts_invalidated: invalidated,
    contradictions_found: 0,
    duration_ms: Date.now() - t4,
    notes: repoSync ? JSON.stringify(repoSync) : null,
  });

  // Phase 5: Drift Analysis (opt-in via WHATSON_DRIFT_ENABLED=true)
  // Shells out to Claude Code CLI to verify codebase against recorded decisions.
  // Non-fatal — failures are captured but do not abort consolidation.
  let driftAnalysis: DriftAnalysisResult | { error: string } | { skipped: string } | undefined;
  const t5 = Date.now();
  try {
    driftAnalysis = await runDriftAnalysis();
  } catch (e) {
    driftAnalysis = { error: e instanceof Error ? e.message : String(e) };
  }
  await logConsolidationPhase({
    run_at: runAt,
    phase: "drift",
    facts_processed: "factsAnalyzed" in (driftAnalysis ?? {}) ? (driftAnalysis as DriftAnalysisResult).factsAnalyzed : 0,
    facts_merged: 0,
    facts_invalidated: 0,
    contradictions_found: "inconsistencies" in (driftAnalysis ?? {}) ? (driftAnalysis as DriftAnalysisResult).inconsistencies : 0,
    duration_ms: Date.now() - t5,
    notes: driftAnalysis ? JSON.stringify(driftAnalysis) : null,
  });

  // Build human-readable report
  const report = await formatConsolidationReport({
    runAt,
    factsProcessed: newFacts.length,
    factsMerged: merged,
    factsInvalidated: invalidated,
    contradictionsFound: contradictions,
    indexUpdated: true,
    repoSync,
    driftAnalysis,
    report: "", // placeholder — filled below
  });

  return {
    runAt,
    factsProcessed: newFacts.length,
    factsMerged: merged,
    factsInvalidated: invalidated,
    contradictionsFound: contradictions,
    indexUpdated: true,
    repoSync,
    driftAnalysis,
    report,
  };
}

// ── Report formatting ────────────────────────────────────────────────────────

async function formatConsolidationReport(summary: ConsolidationSummary): Promise<string> {
  const date = summary.runAt.slice(0, 10);
  const counts = await getFactCount();

  const lines: string[] = [
    `Consolidation Report (${date})`,
    ``,
    `Knowledge base: ${counts.active} active facts, ${counts.expired} expired`,
    `Processed: ${summary.factsProcessed} new facts, ${summary.factsMerged} merged, ${summary.contradictionsFound} contradictions`,
  ];

  // Repo sync
  if (summary.repoSync) {
    if ("skipped" in summary.repoSync) {
      lines.push(`Repo sync: skipped (${summary.repoSync.skipped})`);
    } else if ("error" in summary.repoSync) {
      lines.push(`Repo sync: error — ${summary.repoSync.error}`);
    } else if (summary.repoSync.committed) {
      const sha = summary.repoSync.commitSha?.slice(0, 7) ?? "?";
      lines.push(`Repo sync: committed and pushed (${sha})`);
    } else {
      lines.push(`Repo sync: no changes`);
    }
  }

  // Drift analysis
  if (summary.driftAnalysis) {
    lines.push(``);
    const driftText = await formatDriftSummary(summary.driftAnalysis);
    lines.push(driftText);
  }

  return lines.join("\n");
}
