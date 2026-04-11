/**
 * Context Agent — Entry Point
 *
 * Wires the WAL → Storage pipeline and exports the 5 tool handlers
 * declared in SKILL.md. OpenClaw discovers and calls these by name.
 */

import { processMessage } from "./wal.js";
import { insertFact, searchFacts, type Fact, type SourceType, type Confidence } from "./storage.js";
import { runConsolidation } from "./consolidation.js";
import { retrieve, getStatus } from "./retrieval.js";

// Confidence defaults per entry type
const CONFIDENCE_MAP: Record<string, Confidence> = {
  decision:   "high",
  correction: "high",
  fact:       "medium",
  question:   "medium",
  opinion:    "low",
};

// ── Tool: wal_append ──────────────────────────────────────────────────────────

export async function wal_append(args: {
  message: string;
  source: string;
  timestamp: string;
}): Promise<{ entries: Array<{ type: string; text: string; id: number }> }> {
  const entries = processMessage(args.message, args.source, args.timestamp);

  const result = [];
  for (const entry of entries) {
    const id = insertFact({
      content:       entry.text,
      source:        entry.source,
      source_type:   entry.type as SourceType,
      confidence:    CONFIDENCE_MAP[entry.type] ?? "medium",
      valid_from:    entry.timestamp,
      valid_to:      null,
      superseded_by: null,
      tags:          [],
      raw_message:   args.message,
    });
    result.push({ type: entry.type, text: entry.text, id });
  }

  return { entries: result };
}

// ── Tool: storage_insert ──────────────────────────────────────────────────────

export async function storage_insert(args: {
  content:     string;
  source:      string;
  source_type: string;
  confidence:  string;
  tags:        string[];
  raw_message: string;
}): Promise<{ id: number }> {
  const id = insertFact({
    content:       args.content,
    source:        args.source,
    source_type:   args.source_type as SourceType,
    confidence:    args.confidence as Confidence,
    valid_from:    new Date().toISOString(),
    valid_to:      null,
    superseded_by: null,
    tags:          args.tags ?? [],
    raw_message:   args.raw_message ?? null,
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
  const results = searchFacts(args.keyword ?? "", args.tags ?? [], args.limit ?? 20);
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

export async function consolidate(): Promise<{
  factsProcessed:    number;
  factsMerged:       number;
  factsInvalidated:  number;
  contradictionsFound: number;
  indexUpdated:      boolean;
}> {
  return runConsolidation();
}

// ── Tool: get_status ──────────────────────────────────────────────────────────

export async function get_status(): Promise<{ status: string }> {
  return { status: getStatus() };
}
