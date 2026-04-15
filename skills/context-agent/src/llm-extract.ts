/**
 * LLM-based fact extraction.
 *
 * Regex pre-filter strips derivable noise (code, paths, git output) to save
 * tokens, then the shared `llm.ts` dispatcher routes the classification call
 * through whichever backend (SDK or CLI) is configured for the `extract`
 * component. Returns an empty result when the backend is unavailable or the
 * call fails — callers fall back to regex-only classification.
 */

import type { SourceType } from "./storage.js";
import { callModel, isBackendReady } from "./llm.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ExtractedFact {
  type: SourceType;
  text: string;
  tags: string[];
  confidence: "low" | "medium" | "high";
}

export interface ExtractionResult {
  facts: ExtractedFact[];
  method: "llm" | "regex";
}

// ── Non-derivable filter ────────────────────────────────────────────────────
// Claude Code's memory system (Part 6, section 6.3) says to never store:
// - Code patterns, file paths, architecture derivable from reading the repo
// - Git history, who-changed-what
// - Debugging solutions (the fix is in the code)
// Lines that look like code, file paths, or git refs are noise.

const DERIVABLE_PATTERNS = [
  /^(import|export|const|let|var|function|class|interface|type|enum)\s/,
  /^\s*(\/\/|\/\*|\*|#)/,                      // comments
  /^[a-zA-Z_~.\/\\][a-zA-Z0-9_.\/\\-]*\.(ts|js|py|go|rs|java|md|json|yaml|yml|toml|sql)\s*$/, // file paths
  /^[0-9a-f]{7,40}$/,                          // git hashes
  /^(diff|commit|Author:|Date:|@@)\s/,         // git output
  /^\s*[\{\}\[\]();,]+\s*$/,                   // pure punctuation / brackets
  /^(npm|pnpm|yarn|pip|cargo|go)\s+(install|add|run|build)/,  // package manager commands
];

export function isDerivable(line: string): boolean {
  return DERIVABLE_PATTERNS.some((p) => p.test(line.trim()));
}

// ── Extraction prompt ───────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are a fact extraction agent. Given a block of text from a conversation or document, extract discrete, atomic facts.

For each fact, classify it as one of:
- "decision" — a choice that was made or a stated requirement/guardrail/mechanism (e.g. "We will use PostgreSQL", "Run in a Docker sandbox", "Support Market/Limit/Trailing-Stop orders")
- "fact" — a statement of truth or observation (e.g. "The API latency is 200ms", "Team has 5 members")
- "correction" — something that overrides a previous belief (e.g. "Actually, it's Redis not Memcached")
- "opinion" — a subjective view (e.g. "I think we should use TypeScript")
- "question" — a genuinely UNRESOLVED question with no stated answer in the text (e.g. "What database should we use?"). If the text explicitly answers itself (e.g. a Security section listing mitigations), those are decisions, not questions.

For each fact, also:
- Assign confidence: "high" (explicitly stated, definitive), "medium" (stated but could change), "low" (implied, uncertain)
- Assign 1-3 short topic tags (e.g. ["database", "architecture"], ["deployment", "kubernetes"])

IMPORTANT:
- Do NOT extract code snippets, file paths, import statements, or git output — these are derivable from the codebase.
- Do NOT extract trivial greetings, acknowledgments, or filler ("ok", "sure", "got it").
- Each fact should be self-contained — a reader should understand it without seeing the original message.
- Be exhaustive for structured documents (PRDs, specs, roadmaps): extract every distinct decision, requirement, metric, user story, roadmap phase, and guardrail. Prefer completeness over brevity when the source is dense.
- For casual chat: prefer fewer, higher-quality facts over many noisy ones.
- Include the project/system name as its own fact when introduced.

Respond with a JSON array. Each element:
{"type": "decision|fact|correction|opinion|question", "text": "...", "tags": ["..."], "confidence": "high|medium|low"}

If there are no extractable facts, respond with an empty array: []`;

// ── LLM extraction ─────────────────────────────────────────────────────────

export async function extractWithLlm(
  text: string,
  source: string
): Promise<ExtractionResult> {
  if (!isBackendReady("extract").ready) {
    return { facts: [], method: "regex" };
  }

  // Pre-filter: remove derivable lines to save tokens
  const lines = text.split("\n").filter((l) => l.trim().length > 0 && !isDerivable(l));
  const filtered = lines.join("\n").trim();

  if (filtered.length < 10) {
    return { facts: [], method: "llm" };
  }

  // Cap input to avoid excessive token usage
  const input = filtered.slice(0, 12000);

  try {
    const { text: responseText } = await callModel({
      component: "extract",
      system: EXTRACTION_PROMPT,
      user: `Source: ${source}\n\nText to analyze:\n\n${input}`,
      model: "claude-haiku-4-5-20251001",
      maxTokens: 4096,
    });
    const parsed = parseResponse(responseText);
    return { facts: parsed, method: "llm" };
  } catch (err) {
    console.error("[llm-extract] LLM call failed, falling back to regex:", err);
    return { facts: [], method: "regex" };
  }
}

// ── Response parsing ────────────────────────────────────────────────────────

const VALID_TYPES = new Set<SourceType>(["decision", "fact", "correction", "opinion", "question", "summary"]);
const VALID_CONFIDENCE = new Set(["low", "medium", "high"]);

function parseResponse(text: string): ExtractedFact[] {
  // Extract JSON array from response — handle markdown code blocks
  let jsonStr = text.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  let raw: unknown;
  try {
    raw = JSON.parse(jsonStr);
  } catch {
    // Try to find array in the text
    const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (!arrayMatch) return [];
    try {
      raw = JSON.parse(arrayMatch[0]);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(raw)) return [];

  const results: ExtractedFact[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { type, text: factText, tags, confidence } = item as Record<string, unknown>;

    if (typeof factText !== "string" || factText.length < 5) continue;
    const validType = VALID_TYPES.has(type as SourceType) ? (type as SourceType) : "fact";
    const validConfidence = VALID_CONFIDENCE.has(confidence as string)
      ? (confidence as "low" | "medium" | "high")
      : "medium";
    const validTags = Array.isArray(tags)
      ? tags.filter((t): t is string => typeof t === "string").slice(0, 5)
      : [];

    results.push({
      type: validType,
      text: factText.trim(),
      tags: validTags,
      confidence: validConfidence,
    });
  }

  return results;
}
