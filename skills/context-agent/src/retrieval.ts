/**
 * Module 4: Retrieval — keyword search + attribution
 *
 * Pipeline:
 * 1. Extract keywords and tags from the incoming question
 * 2. SQL query: active facts matching keyword/tags
 * 3. Rank by: confidence DESC, created_at DESC
 * 4. Build a context block for LLM (~2000 token budget)
 * 5. Format with source attribution per fact
 */

import { searchFacts, type Fact } from "./storage.js";

const TOKEN_BUDGET = 2000;
// Rough estimate: 1 token ≈ 4 chars
const CHAR_BUDGET = TOKEN_BUDGET * 4;

export interface RetrievalResult {
  contextBlock: string;
  facts: AttributedFact[];
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

// ── Context block builder ─────────────────────────────────────────────────────

function buildContextBlock(facts: AttributedFact[]): { block: string; truncated: boolean } {
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

  return { block: lines.join("\n"), truncated };
}

// ── Main retrieval function ───────────────────────────────────────────────────

export function retrieve(question: string, limit = 20): RetrievalResult {
  const { keywords, tags } = extractKeywords(question);

  // Try each keyword independently and merge results
  const seen = new Set<number>();
  const factMap = new Map<number, Fact>();

  for (const kw of keywords.slice(0, 5)) {
    const results = searchFacts(kw, tags, limit);
    for (const f of results) {
      if (!seen.has(f.id!)) {
        seen.add(f.id!);
        factMap.set(f.id!, f);
      }
    }
  }

  // If no keyword matched, search by tags only
  if (factMap.size === 0 && tags.length > 0) {
    const results = searchFacts("", tags, limit);
    for (const f of results) {
      factMap.set(f.id!, f);
    }
  }

  // Final fallback: no keywords and no tags (e.g. bare "?" message) — return recent active facts
  if (factMap.size === 0) {
    const results = searchFacts("", [], limit);
    for (const f of results) {
      factMap.set(f.id!, f);
    }
  }

  // Sort: confidence first, then recency
  const confidenceRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const ranked = [...factMap.values()].sort((a, b) => {
    const cmp = (confidenceRank[a.confidence] ?? 1) - (confidenceRank[b.confidence] ?? 1);
    if (cmp !== 0) return cmp;
    return b.created_at.localeCompare(a.created_at);
  });

  const attributed: AttributedFact[] = ranked.map((f) => ({
    id: f.id!,
    content: f.content,
    source: f.source,
    source_type: f.source_type,
    confidence: f.confidence,
    date: (f.valid_from ?? f.created_at).slice(0, 10),
    attribution: formatAttribution(f),
  }));

  const { block, truncated } = buildContextBlock(attributed);

  return {
    contextBlock: block,
    facts: attributed,
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

export function getStatus(): string {
  const counts = getFactCount();
  const lastConsolidation = getLastConsolidation() ?? "never";

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
