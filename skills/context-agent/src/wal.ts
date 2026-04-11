/**
 * Module 1: Write-Ahead Log (WAL)
 *
 * Scans every incoming message for decisions, facts, and corrections,
 * then appends them to SESSION-STATE.md before any response is generated.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { extractUrls, stripUrls, fetchPageText } from "./url-fetch.js";
import { extractWithLlm, type ExtractedFact, type ExtractionResult } from "./llm-extract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../data");
const SESSION_STATE_PATH = path.join(DATA_DIR, "SESSION-STATE.md");

export type EntryType = "decision" | "fact" | "correction" | "question";

export interface WalEntry {
  type: EntryType;
  text: string;
  source: string;
  timestamp: string;
}

// ── Keyword patterns ────────────────────────────────────────────────────────

const DECISION_KEYWORDS =
  /decided|we will|will use|chose|rejected|agreed|approved/i;

const CORRECTION_KEYWORDS =
  /actually|incorrect|correction|instead of|wrong|not true/i;

const QUESTION_KEYWORDS =
  /\?|open question|need to clarify|unclear/i;

// ── Extraction ───────────────────────────────────────────────────────────────

export function extractEntries(
  message: string,
  source: string,
  timestamp: string
): WalEntry[] {
  const entries: WalEntry[] = [];
  const lines = message.split(/\n+/).map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    if (CORRECTION_KEYWORDS.test(line)) {
      entries.push({ type: "correction", text: line, source, timestamp });
    } else if (DECISION_KEYWORDS.test(line)) {
      entries.push({ type: "decision", text: line, source, timestamp });
    } else if (QUESTION_KEYWORDS.test(line)) {
      entries.push({ type: "question", text: line, source, timestamp });
    } else if (line.length > 20) {
      // Heuristic: non-trivial lines without a keyword → generic fact
      entries.push({ type: "fact", text: line, source, timestamp });
    }
  }

  return entries;
}

// ── SESSION-STATE.md I/O ─────────────────────────────────────────────────────

function todayHeader(): string {
  return new Date().toISOString().slice(0, 10);
}

function ensureSessionFile(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(SESSION_STATE_PATH)) {
    const date = todayHeader();
    fs.writeFileSync(
      SESSION_STATE_PATH,
      `# Session State — ${date}\n\n## Decisions\n\n## Facts\n\n## Corrections\n\n## Open Questions\n`
    );
  }
}

function appendToSection(content: string, section: string, line: string): string {
  const marker = `## ${section}`;
  const idx = content.indexOf(marker);
  if (idx === -1) return content + `\n## ${section}\n- ${line}\n`;

  // Find end of section (next ## or EOF)
  const afterSection = content.indexOf("\n## ", idx + marker.length);
  const insertAt = afterSection === -1 ? content.length : afterSection;

  return content.slice(0, insertAt) + `- ${line}\n` + content.slice(insertAt);
}

export function appendToWal(entries: WalEntry[]): void {
  if (entries.length === 0) return;

  ensureSessionFile();
  let content = fs.readFileSync(SESSION_STATE_PATH, "utf-8");

  for (const entry of entries) {
    const line = `[${entry.timestamp}] ${entry.text}`;
    const sectionMap: Record<EntryType, string> = {
      decision: "Decisions",
      fact: "Facts",
      correction: "Corrections",
      question: "Open Questions",
    };
    content = appendToSection(content, sectionMap[entry.type], line);
  }

  fs.writeFileSync(SESSION_STATE_PATH, content, "utf-8");
}

// ── URL section in SESSION-STATE.md ──────────────────────────────────────────

function appendUrlToWal(url: string, description: string, timestamp: string): void {
  ensureSessionFile();
  let content = fs.readFileSync(SESSION_STATE_PATH, "utf-8");

  // Ensure URLs section exists
  if (!content.includes("## URLs")) {
    const openQIdx = content.indexOf("## Open Questions");
    if (openQIdx !== -1) {
      content = content.slice(0, openQIdx) + "## URLs\n\n" + content.slice(openQIdx);
    } else {
      content += "\n## URLs\n";
    }
  }

  const line = `[${timestamp}] ${url}\n  Description: ${description.slice(0, 500)}`;
  content = appendToSection(content, "URLs", line);
  fs.writeFileSync(SESSION_STATE_PATH, content, "utf-8");
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Process a raw incoming message (text only, synchronous):
 * 1. Extract WAL entries
 * 2. Append to SESSION-STATE.md
 * Returns the extracted entries for further processing (e.g. storage).
 */
export function processMessage(
  message: string,
  source: string,
  timestamp = new Date().toISOString()
): WalEntry[] {
  const entries = extractEntries(message, source, timestamp);
  appendToWal(entries);
  return entries;
}

/**
 * Process a message that may contain URLs (regex-only):
 * 1. Detect and fetch each URL
 * 2. Extract WAL entries from plain text + each fetched page
 * 3. Append everything to SESSION-STATE.md
 * Returns all entries with source_url metadata.
 */
export async function processMessageWithUrls(
  message: string,
  source: string,
  timestamp = new Date().toISOString()
): Promise<{ textEntries: WalEntry[]; urlEntries: Array<{ url: string; entries: WalEntry[]; description: string }> }> {
  const urls = extractUrls(message);
  const plainText = stripUrls(message);

  // Process plain text portion
  const textEntries = plainText.length > 0
    ? extractEntries(plainText, source, timestamp)
    : [];
  appendToWal(textEntries);

  // Fetch and process each URL
  const urlEntries: Array<{ url: string; entries: WalEntry[]; description: string }> = [];
  for (const url of urls) {
    const pageText = await fetchPageText(url);
    if (pageText.startsWith("[fetch error:")) {
      urlEntries.push({ url, entries: [], description: pageText });
      continue;
    }

    // Take first ~4000 chars for extraction (avoid overwhelming the WAL)
    const truncated = pageText.slice(0, 4000);
    const entries = extractEntries(truncated, `web:${url}`, timestamp);
    appendToWal(entries);
    appendUrlToWal(url, truncated.slice(0, 500), timestamp);
    urlEntries.push({ url, entries, description: truncated.slice(0, 500) });
  }

  return { textEntries, urlEntries };
}

// ── LLM-based extraction (primary path) ─────────────────────────────────────

/** Convert LLM-extracted facts to WalEntry format for SESSION-STATE.md */
function llmFactsToWalEntries(facts: ExtractedFact[], source: string, timestamp: string): WalEntry[] {
  return facts.map((f) => ({
    type: (f.type === "summary" || f.type === "opinion" ? "fact" : f.type) as EntryType,
    text: f.text,
    source,
    timestamp,
  }));
}

/**
 * Process a message using LLM-based extraction (with regex fallback):
 * 1. Send text to Anthropic for classification
 * 2. If LLM fails, fall back to regex extraction
 * 3. Append to SESSION-STATE.md
 * Returns extracted facts with full metadata (tags, confidence from LLM).
 */
export async function processMessageLlm(
  message: string,
  source: string,
  timestamp = new Date().toISOString()
): Promise<ExtractionResult> {
  const result = await extractWithLlm(message, source);

  if (result.method === "regex" || result.facts.length === 0) {
    // LLM unavailable or returned nothing — fall back to regex
    const regexEntries = extractEntries(message, source, timestamp);
    appendToWal(regexEntries);
    return {
      facts: regexEntries.map((e) => ({
        type: e.type as ExtractedFact["type"],
        text: e.text,
        tags: [],
        confidence: e.type === "decision" || e.type === "correction" ? "high" : "medium",
      })),
      method: "regex",
    };
  }

  // LLM succeeded — convert to WAL entries and write
  const walEntries = llmFactsToWalEntries(result.facts, source, timestamp);
  appendToWal(walEntries);

  return result;
}

/**
 * Process a message with URLs using LLM-based extraction:
 * 1. Detect and fetch each URL
 * 2. Use LLM to extract facts from plain text + each fetched page
 * 3. Append everything to SESSION-STATE.md
 */
export async function processMessageWithUrlsLlm(
  message: string,
  source: string,
  timestamp = new Date().toISOString()
): Promise<{
  textResult: ExtractionResult;
  urlResults: Array<{ url: string; result: ExtractionResult; description: string }>;
}> {
  const urls = extractUrls(message);
  const plainText = stripUrls(message);

  // Process plain text with LLM
  const textResult = plainText.length > 0
    ? await processMessageLlm(plainText, source, timestamp)
    : { facts: [], method: "llm" as const };

  // Fetch and process each URL with LLM
  const urlResults: Array<{ url: string; result: ExtractionResult; description: string }> = [];
  for (const url of urls) {
    const pageText = await fetchPageText(url);
    if (pageText.startsWith("[fetch error:")) {
      urlResults.push({ url, result: { facts: [], method: "llm" }, description: pageText });
      continue;
    }

    const truncated = pageText.slice(0, 6000);
    const result = await extractWithLlm(truncated, `web:${url}`);

    // Write to WAL
    if (result.facts.length > 0) {
      const walEntries = llmFactsToWalEntries(result.facts, `web:${url}`, timestamp);
      appendToWal(walEntries);
    }
    appendUrlToWal(url, truncated.slice(0, 500), timestamp);

    urlResults.push({ url, result, description: truncated.slice(0, 500) });
  }

  return { textResult, urlResults };
}
