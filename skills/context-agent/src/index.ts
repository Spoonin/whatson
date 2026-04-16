/**
 * Context Agent — Entry Point
 *
 * Wires the WAL → Storage pipeline and exports the 5 tool handlers
 * declared in SKILL.md. OpenClaw discovers and calls these by name.
 */

import { processMessage, processMessageWithUrls, processMessageLlm, processMessageWithUrlsLlm } from "./wal.js";
import { extractUrls } from "./url-fetch.js";
import { insertFact, insertDocument, searchFacts, addressDriftFinding, insertFactEmbedding, type Fact, type SourceType, type Confidence } from "./storage.js";
import {
  runConsolidation,
  normalize,
  contentOverlaps,
  kickOffConsolidation,
  getConsolidationRunState,
  getLatestConsolidationReport,
  type ConsolidationSummary,
  type ConsolidationRunState,
  type KickOffResult,
  clearDriftHeartbeatFlag,
} from "./consolidation.js";
import { syncToTargetRepo, type RepoSyncResult } from "./repo-sync.js";
import {
  renderProjectDoc, renderArchitectureDoc, renderDecisionsDoc,
  renderQuestionsDoc, renderRequirementsDoc, renderStatusDoc, renderAll,
  type RenderResult, type RenderOptions,
} from "./render.js";
import { retrieve, getStatus, type RetrievalResult } from "./retrieval.js";
import { embedText } from "./embeddings.js";
import type { ExtractedFact } from "./llm-extract.js";

// Confidence defaults per entry type
const CONFIDENCE_MAP: Record<string, Confidence> = {
  decision:   "high",
  correction: "high",
  fact:       "medium",
  question:   "medium",
  opinion:    "low",
};

// ── Bot command filter ───────────────────────────────────────────────────────
// Telegram/Discord bot commands (/start, /help, /reset, /cancel, …) carry no
// substantive content. Detect a message that is *only* a slash command — with
// optional @botname and optional short trailing args — and let the caller skip
// ingestion. A `/note here's my long note…` style command still falls through.
const BOT_COMMAND_RE = /^\s*\/[a-zA-Z][a-zA-Z0-9_]*(@[a-zA-Z0-9_]+)?(\s.*)?$/;
export function isBotCommand(message: string): boolean {
  const trimmed = message.trim();
  if (!BOT_COMMAND_RE.test(trimmed)) return false;
  // Only treat as a pure command if the whole message is short. A long
  // message starting with "/" is almost certainly not a command.
  return trimmed.length <= 64 && !trimmed.includes("\n");
}

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
  documentId: number | null,
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
    document_id:   documentId,
  });

  // Embed asynchronously — never blocks or fails the insert
  embedText(fact.text).then((vec) => {
    if (vec) insertFactEmbedding(id, vec);
  }).catch((e) => console.error("[embed-on-insert]", e));

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
  const result: Array<{ type: string; text: string; id: number; tags?: string[]; confidence?: string; source_url?: string }> = [];
  const allConflicts: Conflict[] = [];
  let method = "llm";

  // Skip bot slash-commands (/start, /help, /reset, …). They carry no
  // substantive content and should not pollute documents or facts.
  if (isBotCommand(args.message)) {
    return { entries: result, method: "skipped-command", conflicts: allConflicts };
  }

  const urls = extractUrls(args.message);

  // Persist the raw incoming message as a first-class Document so retrieval
  // can surface verbatim content even when fact extraction misses details.
  const primaryDocId = await insertDocument({
    source:      args.source,
    source_file: args.source_file ?? null,
    source_url:  args.source_url ?? null,
    message_id:  args.message_id ?? null,
    content:     args.message,
    tags:        [],
  });

  if (urls.length === 0) {
    // Plain text — use LLM extraction (falls back to regex internally)
    const extraction = await processMessageLlm(args.message, args.source, args.timestamp);
    method = extraction.method;

    for (const fact of extraction.facts) {
      const entry = await storeFact(
        fact, args.source, args.timestamp, args.message,
        args.message_id ?? null, null, args.source_file ?? null, primaryDocId,
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
        args.message_id ?? null, null, null, primaryDocId,
      );
      result.push(entry);
      const conflicts = await findConflicts(entry.id, fact);
      allConflicts.push(...conflicts);
    }

    for (const { url, result: urlResult, description } of urlResults) {
      // Each fetched URL becomes its own Document so retrieval can cite the
      // original page content instead of only distilled facts.
      const urlDocId = await insertDocument({
        source:      `web:${url}`,
        source_file: null,
        source_url:  url,
        message_id:  args.message_id ?? null,
        content:     description ?? "",
        tags:        [],
      });
      for (const fact of urlResult.facts) {
        const entry = await storeFact(
          fact, `web:${url}`, args.timestamp, args.message,
          args.message_id ?? null, url, null, urlDocId,
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

export async function consolidate(): Promise<ConsolidationSummary & { renderResults: RenderResult[] | { error: string } }> {
  const summary = await runConsolidation();
  let renderResults: RenderResult[] | { error: string };
  try {
    renderResults = await renderAll();
  } catch (e) {
    renderResults = { error: e instanceof Error ? e.message : String(e) };
  }
  return { ...summary, renderResults };
}

// ── Tool: consolidate_start (detached) ──────────────────────────────────────

/**
 * Kick off consolidation in the background and return immediately. The MCP
 * tool wraps this so the gateway doesn't block (and time out) on multi-minute
 * LLM consolidation runs. Results are available via `consolidate_status`.
 */
export function consolidate_start(): KickOffResult {
  return kickOffConsolidation(() => consolidate());
}

// ── Tool: consolidate_status ────────────────────────────────────────────────

export function consolidate_status(): {
  state: ConsolidationRunState;
  report: string | null;
} {
  return {
    state: getConsolidationRunState(),
    report: getLatestConsolidationReport(),
  };
}

// ── Tool: sync_repo ───────────────────────────────────────────────────────────

export async function sync_repo(): Promise<RepoSyncResult> {
  return syncToTargetRepo();
}

// ── Tool: render_project ─────────────────────────────────────────────────────

export async function render_project(args: RenderOptions = {}): Promise<RenderResult> {
  return renderProjectDoc(args);
}

export async function render_architecture(args: RenderOptions = {}): Promise<RenderResult> {
  return renderArchitectureDoc(args);
}

export async function render_decisions(args: RenderOptions = {}): Promise<RenderResult> {
  return renderDecisionsDoc(args);
}

export async function render_questions(args: RenderOptions = {}): Promise<RenderResult> {
  return renderQuestionsDoc(args);
}

export async function render_requirements(args: RenderOptions = {}): Promise<RenderResult> {
  return renderRequirementsDoc(args);
}

export async function render_status(args: RenderOptions = {}): Promise<RenderResult> {
  return renderStatusDoc(args);
}

export async function render_all(args: RenderOptions = {}): Promise<RenderResult[]> {
  return renderAll(args);
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
  const report = getDriftReport();
  // Clear the heartbeat flag now that the agent has read the report
  clearDriftHeartbeatFlag();
  return report;
}

// ── Tool: resolve_drift_finding ─────────────────────────────────────────────

export async function resolve_drift_finding(args: {
  finding_id: number;
}): Promise<{ resolved: boolean }> {
  await addressDriftFinding(args.finding_id);
  return { resolved: true };
}
