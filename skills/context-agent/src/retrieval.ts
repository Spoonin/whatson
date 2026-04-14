/**
 * Module 4: Retrieval — hybrid search (FTS5 + vector) with RRF fusion
 *
 * Pipeline:
 * 1. Extract keywords and tags from the incoming question
 * 2. FTS5 keyword search → ranked list A
 * 3. Vector KNN search (if embeddings available) → ranked list B
 * 4. RRF fusion merges A + B
 * 5. Confidence + recency tiebreak
 * 6. Build a context block for LLM (~2000 token budget)
 * 7. Format with source attribution per fact
 */

import { searchFacts, searchFactsByVector, getFactsByIds, searchDocuments, hasVecSupport, type Fact, type Document } from "./storage.js";
import { embedText } from "./embeddings.js";

const TOKEN_BUDGET = 2000;
// Rough estimate: 1 token ≈ 4 chars
const CHAR_BUDGET = TOKEN_BUDGET * 4;
// Per-document excerpt cap inside the context block. Full content is always
// returned separately via `documents` so callers can re-read verbatim.
const DOC_EXCERPT_CHARS = 1200;

export interface RetrievalResult {
  contextBlock: string;
  facts: AttributedFact[];
  documents: AttributedDocument[];
  truncated: boolean;
}

export interface AttributedFact {
  id: number;
  content: string;
  source: string;
  source_type: string;
  confidence: string;
  date: string;
  attribution: string;
}

export interface AttributedDocument {
  id: number;
  source: string;
  source_file: string | null;
  source_url: string | null;
  date: string;
  excerpt: string;
  content: string;
}

// ── Keyword extraction ────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the", "a", "an", "in", "on", "at", "to", "for", "of", "with", "by",
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "what", "how", "when", "where", "why", "which", "that", "this", "from",
]);

export function extractKeywords(question: string): { keywords: string[]; tags: string[] } {
  const words = question
    .toLowerCase()
    .replace(/[^\w\s]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));

  // De-duplicate
  const keywords = [...new Set(words)];

  // Simple tag heuristics — known domain terms
  const TAG_PATTERNS: Record<string, RegExp> = {
    architecture: /architecture|runtime|docker|deploy|infrastructure/i,
    storage: /storage|database|db|sqlite|lancedb|chromadb|vector/i,
    telegram: /telegram|bot|channel/i,
    consolidation: /consolidat|merge|duplicate/i,
    retrieval: /retriev|search|context/i,
  };

  const tags: string[] = [];
  for (const [tag, pattern] of Object.entries(TAG_PATTERNS)) {
    if (pattern.test(question)) tags.push(tag);
  }

  return { keywords, tags };
}

// ── Attribution formatting ────────────────────────────────────────────────────

function formatAttribution(fact: Fact): string {
  const date = (fact.valid_from ?? fact.created_at).slice(0, 10);
  return `(source: ${fact.source}, ${date})`;
}

// ── Context block builder ────────────────────────────────────────────────────

function buildContextBlock(
  facts: AttributedFact[],
  documents: AttributedDocument[],
): { block: string; truncated: boolean } {
  const lines: string[] = [
    "## Relevant Context",
    "",
  ];

  let charCount = lines.join("\n").length;
  let truncated = false;

  for (const f of facts) {
    const line = `- [${f.source_type.toUpperCase()}] ${f.content} ${f.attribution}`;
    if (charCount + line.length > CHAR_BUDGET) {
      truncated = true;
      break;
    }
    lines.push(line);
    charCount += line.length + 1;
  }

  if (documents.length > 0 && !truncated) {
    lines.push("", "## Source Documents", "");
    charCount += "\n## Source Documents\n\n".length;
    for (const d of documents) {
      const header = `### ${d.source_file ?? d.source_url ?? d.source} (${d.date}, doc#${d.id})`;
      const block = `${header}\n${d.excerpt}\n`;
      if (charCount + block.length > CHAR_BUDGET) {
        truncated = true;
        break;
      }
      lines.push(header, d.excerpt, "");
      charCount += block.length;
    }
  }

  return { block: lines.join("\n"), truncated };
}

// ── Reciprocal Rank Fusion ───────────────────────────────────────────────────

const RRF_K = 60; // Standard RRF constant

export function reciprocalRankFusion(
  ftsResults: { id: number; rank: number }[],
  vecResults: { id: number; rank: number }[],
): Map<number, number> {
  const scores = new Map<number, number>();

  for (const { id, rank } of ftsResults) {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank));
  }
  for (const { id, rank } of vecResults) {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank));
  }

  return scores;
}

// ── Main retrieval function ───────────────────────────────────────────────────

export async function retrieve(question: string, limit = 20): Promise<RetrievalResult> {
  const { keywords, tags } = extractKeywords(question);

  // ── FTS5 keyword search (ranked list A) ──
  const ftsFactMap = new Map<number, Fact>();
  for (const kw of keywords.slice(0, 5)) {
    const results = await searchFacts(kw, tags, limit);
    for (const f of results) {
      if (!ftsFactMap.has(f.id!)) ftsFactMap.set(f.id!, f);
    }
  }
  if (ftsFactMap.size === 0 && tags.length > 0) {
    for (const f of await searchFacts("", tags, limit)) ftsFactMap.set(f.id!, f);
  }

  // ── Vector KNN search (ranked list B) ──
  const vecRanked: { id: number; rank: number }[] = [];
  if (hasVecSupport()) {
    const queryEmbedding = await embedText(question);
    if (queryEmbedding) {
      const vecResults = await searchFactsByVector(queryEmbedding, limit);
      for (let i = 0; i < vecResults.length; i++) {
        vecRanked.push({ id: vecResults[i].factId, rank: i + 1 });
      }
    }
  }

  // ── Fusion ──
  const ftsRanked = [...ftsFactMap.keys()].map((id, i) => ({ id, rank: i + 1 }));

  let ranked: Fact[];

  if (vecRanked.length > 0) {
    // RRF merge
    const scores = reciprocalRankFusion(ftsRanked, vecRanked);
    const sortedIds = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => id);

    // Fetch full facts for any IDs we don't already have from FTS
    const missingIds = sortedIds.filter((id) => !ftsFactMap.has(id));
    const extraFacts = missingIds.length > 0 ? await getFactsByIds(missingIds) : [];
    const allFacts = new Map(ftsFactMap);
    for (const f of extraFacts) allFacts.set(f.id!, f);

    ranked = sortedIds.map((id) => allFacts.get(id)).filter((f): f is Fact => !!f);
  } else if (ftsFactMap.size > 0) {
    // FTS only — confidence + recency sort
    const confidenceRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
    ranked = [...ftsFactMap.values()].sort((a, b) => {
      const cmp = (confidenceRank[a.confidence] ?? 1) - (confidenceRank[b.confidence] ?? 1);
      if (cmp !== 0) return cmp;
      return b.created_at.localeCompare(a.created_at);
    });
  } else {
    // Final fallback: recent active facts
    ranked = await searchFacts("", [], limit);
  }

  const attributed: AttributedFact[] = ranked.map((f) => ({
    id: f.id!,
    content: f.content,
    source: f.source,
    source_type: f.source_type,
    confidence: f.confidence,
    date: (f.valid_from ?? f.created_at).slice(0, 10),
    attribution: formatAttribution(f),
  }));

  // ── Document search ──
  // Run the same keywords against the documents FTS so that details which
  // were never extracted as discrete facts (e.g. a roadmap bullet from a
  // PRD) can still be surfaced verbatim to the caller.
  const docMap = new Map<number, Document>();
  for (const kw of keywords.slice(0, 5)) {
    for (const d of await searchDocuments(kw, Math.min(limit, 5))) {
      if (d.id !== undefined && !docMap.has(d.id)) docMap.set(d.id, d);
    }
  }
  const attributedDocs: AttributedDocument[] = [...docMap.values()]
    .slice(0, 5)
    .map((d) => ({
      id: d.id!,
      source: d.source,
      source_file: d.source_file,
      source_url: d.source_url,
      date: d.created_at.slice(0, 10),
      excerpt: d.content.length > DOC_EXCERPT_CHARS
        ? d.content.slice(0, DOC_EXCERPT_CHARS) + "…"
        : d.content,
      content: d.content,
    }));

  const { block, truncated } = buildContextBlock(attributed, attributedDocs);

  return {
    contextBlock: block,
    facts: attributed,
    documents: attributedDocs,
    truncated,
  };
}

// ── Status helper ─────────────────────────────────────────────────────────────

import { getFactCount, getLastConsolidation } from "./storage.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_STATE_PATH = path.resolve(__dirname, "../data/SESSION-STATE.md");

export async function getStatus(): Promise<string> {
  const counts = await getFactCount();
  const lastConsolidation = (await getLastConsolidation()) ?? "never";

  let openQuestions = 0;
  if (fs.existsSync(SESSION_STATE_PATH)) {
    const content = fs.readFileSync(SESSION_STATE_PATH, "utf-8");
    const section = content.match(/## Open Questions\n([\s\S]*?)(?:\n##|$)/);
    if (section) {
      openQuestions = (section[1].match(/^- /gm) ?? []).length;
    }
  }

  return [
    `**Active facts:** ${counts.active}`,
    `**Expired facts:** ${counts.expired}`,
    `**Last consolidation:** ${lastConsolidation}`,
    `**Open questions:** ${openQuestions}`,
  ].join("\n");
}
