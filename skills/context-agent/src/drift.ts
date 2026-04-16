/**
 * Module: Drift Analysis — Phase 5 of the consolidation pipeline
 *
 * Two backends:
 *
 *   1. `repomix` (default): pack the target repo once via `repomix --stdout
 *      --compress`, then run a per-fact SDK call with the packed repo in the
 *      system prompt (cache_control: ephemeral). Fast, cheap with prompt
 *      caching, unified billing on API credits. Bounded by context window —
 *      falls back to `cli` when the packed output exceeds
 *      `WHATSON_DRIFT_MAX_PACK_BYTES`.
 *
 *   2. `cli`: spawn a `claude -p` agent turn per fact with Read/Grep/Glob
 *      tools. No context ceiling, but more wall time and ties us to the
 *      subscription billing path.
 *
 * Findings are persisted to `drift_findings` immediately so a failed or
 * interrupted run still surfaces partial progress. A small concurrency pool
 * (default 4, override via `WHATSON_DRIFT_CONCURRENCY`) bounds wall time.
 *
 * Env vars:
 *   WHATSON_DRIFT_ENABLED         — "true" to enable (default: disabled)
 *   WHATSON_DRIFT_MODEL           — SDK model (default: claude-sonnet-4-6)
 *   WHATSON_DRIFT_CONCURRENCY     — parallel calls (default: 4, cap 16)
 *   WHATSON_DRIFT_PACK_MODE       — "repomix" | "cli" (default: repomix)
 *   WHATSON_DRIFT_MAX_PACK_BYTES  — fallback ceiling (default: 3_000_000)
 */

import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  getActiveFacts,
  insertDriftFinding,
  getDriftFindings,
  getUnansweredQuestions,
  getFactsByIds,
  getCachedDriftFinding,
  upsertDriftCache,
  type Fact,
  type DriftFinding,
} from "./storage.js";
import { getRepoSyncConfig } from "./repo-sync.js";
import { packRepo, invokePackedSdk } from "./drift-pack.js";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKDIR = path.resolve(__dirname, "../data/target-repo");
const LATEST_PACK_PATH = path.resolve(__dirname, "../data/LATEST-DRIFT-PACK.xml");

const DEFAULT_CONCURRENCY = 4;
const PER_CALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 min safety cap per fact
const MAX_BUFFER = 10 * 1024 * 1024;

export interface DriftAnalysisResult {
  skipped?: string;
  factsAnalyzed: number;
  findings: number;
  inconsistencies: number;
  questionsGenerated: number;
  errors?: number;
  cacheHits?: number;
}

export function hashFact(fact: Fact): string {
  return createHash("sha256")
    .update(`${fact.source_type}\0${fact.content}`)
    .digest("hex");
}

function getRepoSha(workDir: string): string | null {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return sha || null;
  } catch {
    return null;
  }
}

// ── Per-fact prompt ─────────────────────────────────────────────────────────

export function buildPerFactPrompt(fact: Fact): string {
  return `You are a codebase consistency auditor. Verify this single recorded fact against the current codebase in the working directory.

## Fact to verify

- ID: ${fact.id}
- Type: ${fact.source_type} (confidence: ${fact.confidence})
- Content: ${fact.content}
- Recorded: ${fact.valid_from.slice(0, 10)} from ${fact.source}

## Your job

1. Search the codebase for keywords, domain terms, or config keys related to this fact.
2. Read the most relevant files.
3. Decide: is the codebase CONSISTENT or INCONSISTENT with the stated fact?
4. If inconsistent, write a specific question for the stakeholders.

## Output

Respond with ONLY a JSON object (no markdown fences, no commentary):

{"fact_id": ${fact.id}, "consistent": <boolean>, "evidence": "<file:line — what you found, or null>", "question": "<question for stakeholders, or null if consistent>"}

Rules:
- Do NOT flag style differences — only semantic drift (wrong tech, missing feature, contradicted architecture).
- If you find no evidence either way, mark inconsistent and ask about it.
- Be specific in evidence: cite file paths.
`;
}

// ── Parse ───────────────────────────────────────────────────────────────────

export interface ClaudeFinding {
  fact_id: number;
  consistent: boolean;
  evidence: string | null;
  question: string | null;
}

interface ClaudeWrapper {
  result?: string;
}

export function parsePerFactOutput(raw: string, expectedFactId: number): ClaudeFinding {
  let text = raw.trim();

  // Unwrap --output-format json envelope
  try {
    const wrapper: ClaudeWrapper = JSON.parse(text);
    if (typeof wrapper.result === "string") {
      text = wrapper.result.trim();
    }
  } catch {
    // Not a wrapper — raw model output
  }

  // Strip markdown fences if the model added them despite instructions
  text = text.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();

  const parsed = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("drift output is not an object");
  }
  if (typeof parsed.consistent !== "boolean") {
    throw new Error("drift output missing 'consistent' boolean");
  }

  // Always trust our captured id over whatever the model echoes back — a
  // hallucinated `fact_id` here would become an FK violation on insert into
  // drift_findings(fact_id).
  return {
    fact_id: expectedFactId,
    consistent: parsed.consistent,
    evidence: typeof parsed.evidence === "string" ? parsed.evidence : null,
    question: typeof parsed.question === "string" ? parsed.question : null,
  };
}

// ── Claude CLI invocation ───────────────────────────────────────────────────

function claudeExists(): boolean {
  try {
    execFileSync("which", ["claude"], { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

export async function invokeClaudeCode(prompt: string, workDir: string): Promise<string> {
  const model = process.env.WHATSON_DRIFT_MODEL ?? "claude-opus-4-6";
  const args = [
    "-p", prompt,
    "--model", model,
    "--output-format", "json",
    "--bare",
    "--no-session-persistence",
    "--max-turns", "15",
    "--allowedTools", "Read,Grep,Glob,Bash(git log:*),Bash(ls:*),Bash(cat:*),Bash(find:*)",
  ];

  // Strip ANTHROPIC_API_KEY so claude -p uses the logged-in subscription
  // session (same pattern as llm.ts callCli).
  const { ANTHROPIC_API_KEY: _stripped, ...childEnv } = process.env;

  const { stdout } = await execFileAsync("claude", args, {
    cwd: workDir,
    encoding: "utf-8",
    timeout: PER_CALL_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    env: childEnv,
  });
  return stdout;
}

// ── Concurrency pool ────────────────────────────────────────────────────────

function parseConcurrency(raw: string | undefined): number {
  if (!raw) return DEFAULT_CONCURRENCY;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CONCURRENCY;
  return Math.min(n, 16); // hard cap
}

async function runPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx]);
    }
  });
  await Promise.all(runners);
  return results;
}

// ── Per-fact analysis ───────────────────────────────────────────────────────

interface PerFactOutcome {
  finding: ClaudeFinding;
  error: boolean;
  cached: boolean;
}

export type FactWorker = (fact: Fact) => Promise<ClaudeFinding>;

async function analyzeFact(
  fact: Fact,
  worker: FactWorker,
  repoSha: string | null,
): Promise<PerFactOutcome> {
  const factHash = hashFact(fact);

  if (repoSha) {
    const cached = await getCachedDriftFinding(factHash, repoSha);
    if (cached) {
      return {
        cached: true,
        error: false,
        finding: {
          fact_id: fact.id!,
          consistent: cached.consistent,
          evidence: cached.evidence,
          question: cached.question,
        },
      };
    }
  }

  try {
    const finding = await worker(fact);
    if (repoSha) {
      await upsertDriftCache(factHash, repoSha, {
        consistent: finding.consistent,
        evidence: finding.evidence,
        question: finding.question,
      });
    }
    return { finding, error: false, cached: false };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    return {
      error: true,
      cached: false,
      finding: {
        fact_id: fact.id!,
        consistent: false,
        evidence: `drift analysis failed: ${msg.slice(0, 200)}`,
        question: null,
      },
    };
  }
}

// ── Worker factories ────────────────────────────────────────────────────────

function makeCliWorker(workDir: string): FactWorker {
  return async (fact) => {
    const prompt = buildPerFactPrompt(fact);
    const raw = await invokeClaudeCode(prompt, workDir);
    return parsePerFactOutput(raw, fact.id!);
  };
}

function makePackedWorker(packedRepo: string): FactWorker {
  return async (fact) => invokePackedSdk({ packedRepo, fact });
}

type PackMode = "repomix" | "cli";

function resolvePackMode(): PackMode {
  const raw = process.env.WHATSON_DRIFT_PACK_MODE?.toLowerCase();
  if (raw === "cli") return "cli";
  return "repomix";
}

function parseMaxPackBytes(raw: string | undefined): number {
  const DEFAULT = 3_000_000;
  if (!raw) return DEFAULT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT;
  return n;
}

// ── Main ────────────────────────────────────────────────────────────────────

export async function runDriftAnalysis(): Promise<DriftAnalysisResult> {
  if (process.env.WHATSON_DRIFT_ENABLED !== "true") {
    return skip("WHATSON_DRIFT_ENABLED is not 'true'");
  }

  const cfg = getRepoSyncConfig();
  const workDir = cfg?.workDir ?? DEFAULT_WORKDIR;
  if (!fs.existsSync(path.join(workDir, ".git"))) {
    return skip("target repo not cloned (run sync first)");
  }

  const allFacts = await getActiveFacts();
  const factsToAnalyze = allFacts.filter(
    (f) => f.source_type === "decision" || f.confidence === "high"
  );

  if (factsToAnalyze.length === 0) {
    return skip("no high-confidence decisions or facts to analyze");
  }

  // Resolve worker: repomix+SDK by default, CLI as opt-out or auto-fallback
  // when the packed repo exceeds the context ceiling.
  const mode = resolvePackMode();
  const maxPackBytes = parseMaxPackBytes(process.env.WHATSON_DRIFT_MAX_PACK_BYTES);
  let worker: FactWorker;

  if (mode === "repomix") {
    if (!process.env.ANTHROPIC_API_KEY) {
      return skip("repomix drift path requires ANTHROPIC_API_KEY (set WHATSON_DRIFT_PACK_MODE=cli to use subscription)");
    }
    let packed: string;
    try {
      packed = await packRepo(workDir);
    } catch (err) {
      return skip(`repomix failed: ${(err as Error).message.slice(0, 200)}`);
    }
    const packBytes = Buffer.byteLength(packed, "utf-8");

    try {
      fs.mkdirSync(path.dirname(LATEST_PACK_PATH), { recursive: true });
      fs.writeFileSync(LATEST_PACK_PATH, packed, "utf-8");
      console.error(`[drift] packed repo persisted to ${LATEST_PACK_PATH} (${packBytes} bytes)`);
    } catch (e) {
      console.error("[drift] failed to persist pack:", e);
    }

    const model = process.env.WHATSON_DRIFT_MODEL ?? "claude-sonnet-4-6";
    if (packBytes > maxPackBytes) {
      if (!claudeExists()) {
        return skip(`packed repo ${packBytes}B exceeds ${maxPackBytes}B ceiling and claude CLI fallback not on PATH`);
      }
      console.error(`[drift] mode=repomix packBytes=${packBytes} exceeds ceiling=${maxPackBytes} → falling back worker=cli`);
      worker = makeCliWorker(workDir);
    } else {
      console.error(`[drift] mode=repomix packBytes=${packBytes} worker=sdk model=${model}`);
      worker = makePackedWorker(packed);
    }

    if (process.env.WHATSON_DRIFT_DRY_RUN === "true") {
      return skip(`dry run — pack written to ${LATEST_PACK_PATH} (${packBytes} bytes), would use ${packBytes > maxPackBytes ? "cli" : "sdk"} worker`);
    }
  } else {
    if (!claudeExists()) {
      return skip("claude CLI not found on PATH");
    }
    console.error(`[drift] mode=cli worker=claude-p workDir=${workDir}`);
    worker = makeCliWorker(workDir);
  }

  const runAt = new Date().toISOString();
  const concurrency = parseConcurrency(process.env.WHATSON_DRIFT_CONCURRENCY);
  const repoSha = getRepoSha(workDir);

  let inconsistencies = 0;
  let questionsGenerated = 0;
  let errors = 0;
  let cacheHits = 0;

  // Process with bounded concurrency; persist each finding as it completes so
  // a crash mid-run still leaves partial progress in the DB.
  const outcomes = await runPool(factsToAnalyze, concurrency, async (fact) => {
    const outcome = await analyzeFact(fact, worker, repoSha);
    await insertDriftFinding({
      run_at: runAt,
      fact_id: fact.id!,
      consistent: outcome.finding.consistent,
      evidence: outcome.finding.evidence,
      question: outcome.finding.question,
    });
    return outcome;
  });

  for (const outcome of outcomes) {
    if (outcome.error) errors++;
    if (outcome.cached) cacheHits++;
    if (!outcome.finding.consistent) inconsistencies++;
    if (outcome.finding.question) questionsGenerated++;
  }

  return {
    factsAnalyzed: factsToAnalyze.length,
    findings: outcomes.length,
    inconsistencies,
    questionsGenerated,
    errors: errors > 0 ? errors : undefined,
    cacheHits: cacheHits > 0 ? cacheHits : undefined,
  };
}

function skip(reason: string): DriftAnalysisResult {
  return {
    skipped: reason,
    factsAnalyzed: 0,
    findings: 0,
    inconsistencies: 0,
    questionsGenerated: 0,
  };
}

// ── Report helpers (for MCP tools) ──────────────────────────────────────────

export async function getDriftReport(): Promise<{
  latestFindings: DriftFinding[];
  unansweredQuestions: DriftFinding[];
}> {
  const latestFindings = await getDriftFindings();
  const unansweredQuestions = await getUnansweredQuestions();
  return { latestFindings, unansweredQuestions };
}

/**
 * Format drift findings as a human-readable summary, enriched with fact content.
 * Used in the consolidation report and morning digest.
 */
export async function formatDriftSummary(
  result: DriftAnalysisResult | { error: string } | { skipped: string }
): Promise<string> {
  if ("skipped" in result) return `Drift analysis: skipped (${result.skipped})`;
  if ("error" in result) return `Drift analysis: error — ${result.error}`;

  const cacheNote = result.cacheHits ? ` (${result.cacheHits} cached)` : "";
  if (result.inconsistencies === 0) {
    return `Drift analysis: ${result.factsAnalyzed} facts checked, all consistent${cacheNote}`;
  }

  const findings = await getDriftFindings();
  const inconsistent = findings.filter((f) => !f.consistent);
  const factIds = inconsistent.map((f) => f.fact_id);
  const facts = await getFactsByIds(factIds);
  const factMap = new Map(facts.map((f) => [f.id!, f]));

  const headline = result.errors
    ? `Drift analysis: ${result.inconsistencies} inconsistencies, ${result.errors} errors (${result.factsAnalyzed} facts checked${cacheNote})`
    : `Drift analysis: ${result.inconsistencies} inconsistencies found (${result.factsAnalyzed} facts checked${cacheNote})`;
  const lines: string[] = [headline];

  for (const finding of inconsistent) {
    const fact = factMap.get(finding.fact_id);
    const label = fact ? fact.content.slice(0, 80) : `Fact #${finding.fact_id}`;
    lines.push(`  - ${label}`);
    if (finding.evidence) {
      lines.push(`    Evidence: ${finding.evidence.slice(0, 120)}`);
    }
  }

  const questions = findings.filter((f) => f.question && !f.addressed);
  if (questions.length > 0) {
    lines.push(``);
    lines.push(`Open questions for stakeholders:`);
    for (let i = 0; i < questions.length; i++) {
      lines.push(`  ${i + 1}. ${questions[i].question!.slice(0, 150)}`);
    }
  }

  return lines.join("\n");
}
