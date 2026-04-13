/**
 * Context Agent — Entry Point
 *
 * Wires the WAL → Storage pipeline and exports the 5 tool handlers
 * declared in SKILL.md. OpenClaw discovers and calls these by name.
 */

import { processMessage, processMessageWithUrls, processMessageLlm, processMessageWithUrlsLlm } from "./wal.js";
import { extractUrls } from "./url-fetch.js";
import { insertFact, searchFacts, addressDriftFinding, type Fact, type SourceType, type Confidence } from "./storage.js";
import { runConsolidation, normalize, contentOverlaps, type ConsolidationSummary } from "./consolidation.js";
import { syncToTargetRepo, type RepoSyncResult } from "./repo-sync.js";
import { retrieve, getStatus, type RetrievalResult } from "./retrieval.js";
import type { ExtractedFact } from "./llm-extract.js";

// Confidence defaults per entry type
const CONFIDENCE_MAP: Record<string, Confidence> = {
  decision:   "high",
  correction: "high",
  fact:       "medium",
  question:   "medium",
  opinion:    "low",
};

// ── Conflict detection ───────────────────────────────────────────────────────

interface Conflict {
  newFactId: number;
  newText: string;
  existingFactId: number;
  existingText: string;
  existingSource: string;
}

async function findConflicts(
  newFactId: number,
  newFact: ExtractedFact,
): Promise<Conflict[]> {
  // Extract significant keywords (>4 chars) for search
  const words = normalize(newFact.text)
    .split(" ")
    .filter((w) => w.length > 4);
  if (words.length === 0) return [];

  // Search existing facts using the most distinctive keywords
  const keyword = words.slice(0, 3).join(" ");
  const existing = await searchFacts(keyword, [], 30);

  const conflicts: Conflict[] = [];
  for (const fact of existing) {
    if (fact.id === newFactId) continue;
    // Skip exact duplicates (handled by consolidation)
    if (normalize(fact.content) === normalize(newFact.text)) continue;
    // Check for meaningful overlap
    if (contentOverlaps(newFact.text, fact.content)) {
      conflicts.push({
        newFactId,
        newText: newFact.text,
        existingFactId: fact.id!,
        existingText: fact.content,
        existingSource: fact.source,
      });
    }
  }
  return conflicts;
}

// ── Tool: wal_append ──────────────────────────────────────────────────────────

/** Store an ExtractedFact into SQLite and return the result entry */
async function storeFact(
  fact: ExtractedFact,
  source: string,
  timestamp: string,
  rawMessage: string,
  messageId: string | null,
  sourceUrl: string | null,
  sourceFile: string | null,
): Promise<{ type: string; text: string; id: number; tags: string[]; confidence: string; source_url?: string }> {
  const id = await insertFact({
    content:       fact.text,
    source,
    source_type:   fact.type as SourceType,
    confidence:    fact.confidence ?? (CONFIDENCE_MAP[fact.type] ?? "medium"),
    valid_from:    timestamp,
    valid_to:      null,
    superseded_by: null,
    tags:          fact.tags ?? [],
    raw_message:   rawMessage,
    message_id:    messageId,
    source_url:    sourceUrl,
    source_file:   sourceFile,
  });
  return { type: fact.type, text: fact.text, id, tags: fact.tags, confidence: fact.confidence, ...(sourceUrl ? { source_url: sourceUrl } : {}) };
}

export async function wal_append(args: {
  message: string;
  source: string;
  timestamp: string;
  message_id?: string;
  source_url?: string;
  source_file?: string;
}): Promise<{
  entries: Array<{ type: string; text: string; id: number; tags?: string[]; confidence?: string; source_url?: string }>;
  method: string;
  conflicts: Conflict[];
}> {
  const urls = extractUrls(args.message);
  const result: Array<{ type: string; text: string; id: number; tags?: string[]; confidence?: string; source_url?: string }> = [];
  const allConflicts: Conflict[] = [];
  let method = "llm";

  if (urls.length === 0) {
    // Plain text — use LLM extraction (falls back to regex internally)
    const extraction = await processMessageLlm(args.message, args.source, args.timestamp);
    method = extraction.method;

    for (const fact of extraction.facts) {
      const entry = await storeFact(
        fact, args.source, args.timestamp, args.message,
        args.message_id ?? null, null, args.source_file ?? null,
      );
      result.push(entry);
      const conflicts = await findConflicts(entry.id, fact);
      allConflicts.push(...conflicts);
    }
  } else {
    // Message contains URLs — use LLM extraction for text + each URL
    const { textResult, urlResults } = await processMessageWithUrlsLlm(
      args.message, args.source, args.timestamp
    );
    method = textResult.method;

    for (const fact of textResult.facts) {
      const entry = await storeFact(
        fact, args.source, args.timestamp, args.message,
        args.message_id ?? null, null, null,
      );
      result.push(entry);
      const conflicts = await findConflicts(entry.id, fact);
      allConflicts.push(...conflicts);
    }

    for (const { url, result: urlResult } of urlResults) {
      for (const fact of urlResult.facts) {
        const entry = await storeFact(
          fact, `web:${url}`, args.timestamp, args.message,
          args.message_id ?? null, url, null,
        );
        result.push(entry);
        const conflicts = await findConflicts(entry.id, fact);
        allConflicts.push(...conflicts);
      }
    }
  }

  return { entries: result, method, conflicts: allConflicts };
}

// ── Tool: storage_insert ──────────────────────────────────────────────────────

export async function storage_insert(args: {
  content:      string;
  source:       string;
  source_type:  string;
  confidence:   string;
  tags:         string[];
  raw_message:  string;
  message_id?:  string;
  source_url?:  string;
  source_file?: string;
}): Promise<{ id: number }> {
  const id = await insertFact({
    content:       args.content,
    source:        args.source,
    source_type:   args.source_type as SourceType,
    confidence:    args.confidence as Confidence,
    valid_from:    new Date().toISOString(),
    valid_to:      null,
    superseded_by: null,
    tags:          args.tags ?? [],
    raw_message:   args.raw_message ?? null,
    message_id:    args.message_id ?? null,
    source_url:    args.source_url ?? null,
    source_file:   args.source_file ?? null,
  });
  return { id };
}

// ── Tool: storage_query ───────────────────────────────────────────────────────

export async function storage_query(args: {
  keyword?: string;
  tags?:    string[];
  limit?:   number;
}): Promise<{
  facts: Array<Pick<Fact, "id" | "content" | "source" | "confidence" | "created_at">>;
}> {
  const results = await searchFacts(args.keyword ?? "", args.tags ?? [], args.limit ?? 20);
  return {
    facts: results.map((f) => ({
      id:         f.id,
      content:    f.content,
      source:     f.source,
      confidence: f.confidence,
      created_at: f.created_at,
    })),
  };
}

// ── Tool: consolidate ─────────────────────────────────────────────────────────

export async function consolidate(): Promise<ConsolidationSummary> {
  return runConsolidation();
}

// ── Tool: sync_repo ───────────────────────────────────────────────────────────

export async function sync_repo(): Promise<RepoSyncResult> {
  return syncToTargetRepo();
}

// ── Tool: get_status ──────────────────────────────────────────────────────────

export async function get_status(): Promise<{ status: string }> {
  return { status: await getStatus() };
}

// ── Tool: retrieve_context ───────────────────────────────────────────────────

export async function retrieve_context(args: {
  question: string;
  limit?: number;
}): Promise<RetrievalResult> {
  return retrieve(args.question, args.limit);
}

// ── Tool: run_drift_analysis ─────────────────────────────────────────────────

import { runDriftAnalysis, getDriftReport, type DriftAnalysisResult } from "./drift.js";

export async function run_drift_analysis(): Promise<DriftAnalysisResult> {
  return runDriftAnalysis();
}

// ── Tool: get_drift_report ───────────────────────────────────────────────────

export async function get_drift_report(): Promise<{
  latestFindings: import("./storage.js").DriftFinding[];
  unansweredQuestions: import("./storage.js").DriftFinding[];
}> {
  return getDriftReport();
}

// ── Tool: resolve_drift_finding ─────────────────────────────────────────────

export async function resolve_drift_finding(args: {
  finding_id: number;
}): Promise<{ resolved: boolean }> {
  await addressDriftFinding(args.finding_id);
  return { resolved: true };
}
