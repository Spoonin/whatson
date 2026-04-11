/**
 * Module 1: Write-Ahead Log (WAL)
 *
 * Scans every incoming message for decisions, facts, and corrections,
 * then appends them to SESSION-STATE.md before any response is generated.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

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

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Process a raw incoming message:
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
