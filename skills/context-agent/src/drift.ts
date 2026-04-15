/**
 * Module: Drift Analysis — Phase 5 of the consolidation pipeline
 *
 * Shells out to Claude Code CLI (`claude -p`) to verify that the target
 * codebase is consistent with recorded decisions and high-confidence facts.
 * Findings are stored in the `drift_findings` table and surfaced via MCP.
 *
 * Configured via env vars:
 *   WHATSON_DRIFT_ENABLED   — "true" to enable (default: disabled)
 *   WHATSON_DRIFT_MODEL     — model to use (default: "claude-opus-4-6")
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  getActiveFacts,
  insertDriftFinding,
  getDriftFindings,
  getUnansweredQuestions,
  getFactsByIds,
  type Fact,
  type DriftFinding,
} from "./storage.js";
import { getRepoSyncConfig } from "./repo-sync.js";
import { resolveBackend } from "./llm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKDIR = path.resolve(__dirname, "../data/target-repo");

export interface DriftAnalysisResult {
  skipped?: string;
  factsAnalyzed: number;
  findings: number;
  inconsistencies: number;
  questionsGenerated: number;
}

// ── Prompt ──────────────────────────────────────────────────────────────────

export function buildAnalysisPrompt(facts: Fact[]): string {
  const factList = facts
    .map(
      (f) =>
        `- [ID=${f.id}] (${f.source_type}, ${f.confidence}) ${f.content} — source: ${f.source}, date: ${f.valid_from.slice(0, 10)}`
    )
    .join("\n");

  return `You are a codebase consistency auditor. You have been given a list of project decisions and facts recorded by a context agent. Your job is to verify each one against the actual codebase in the current working directory.

For each fact/decision below:
1. Search the codebase for related files (grep for keywords, domain terms, config keys).
2. Read the relevant files.
3. Determine if the codebase is CONSISTENT or INCONSISTENT with the stated fact.
4. If inconsistent, write a specific question for the stakeholders.

## Facts to verify

${factList}

## Output format

You MUST respond with ONLY a JSON object (no markdown fences, no commentary):

{
  "findings": [
    {
      "fact_id": <number>,
      "consistent": <boolean>,
      "evidence": "<file:line — what you found>",
      "question": "<question for stakeholders, or null if consistent>"
    }
  ]
}

Rules:
- Include ALL facts in your findings array, even consistent ones.
- Be specific in evidence — cite file paths and line numbers.
- Do not flag style differences — only semantic drift (wrong tech, missing feature, contradicted architecture).
- If you cannot find any evidence for or against a fact, mark it inconsistent and ask about it.
`;
}

// ── JSON output schema for --json-schema flag ───────────────────────────────

export const OUTPUT_SCHEMA = JSON.stringify({
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["fact_id", "consistent", "evidence", "question"],
        properties: {
          fact_id: { type: "number" },
          consistent: { type: "boolean" },
          evidence: { type: ["string", "null"] },
          question: { type: ["string", "null"] },
        },
      },
    },
  },
});

// ── Parse ───────────────────────────────────────────────────────────────────

interface ClaudeFinding {
  fact_id: number;
  consistent: boolean;
  evidence: string | null;
  question: string | null;
}

interface ClaudeOutput {
  result?: string; // --output-format json wraps the text in { result: "..." }
  findings?: ClaudeFinding[];
}

export function parseClaudeOutput(raw: string): ClaudeFinding[] {
  // --output-format json returns { result: "<text>" } where <text> is the model's response.
  // The model's response is the JSON we asked for.
  let text = raw.trim();

  // Try parsing as the wrapper { result: "..." } first
  try {
    const wrapper: ClaudeOutput = JSON.parse(text);
    if (wrapper.result) {
      text = wrapper.result;
    } else if (wrapper.findings) {
      return wrapper.findings;
    }
  } catch {
    // Not a wrapper — raw model output
  }

  // Strip markdown fences if the model added them despite instructions
  text = text.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");

  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.findings)) {
    throw new Error("Claude output missing 'findings' array");
  }
  return parsed.findings;
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

export function invokeClaudeCode(prompt: string, workDir: string): string {
  const model = process.env.WHATSON_DRIFT_MODEL ?? "claude-opus-4-6";
  const args = [
    "-p", prompt,
    "--model", model,
    "--output-format", "json",
    "--bare",
    "--no-session-persistence",
    "--max-turns", "30",
    "--allowedTools", "Read,Grep,Glob,Bash(git log:*),Bash(ls:*),Bash(cat:*),Bash(find:*)",
  ];

  return execFileSync("claude", args, {
    cwd: workDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5 * 60 * 1000, // 5 minute safety cap
    env: {
      ...process.env,
      // Ensure Claude Code uses the same API key
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    },
  });
}

// ── Main ────────────────────────────────────────────────────────────────────

export async function runDriftAnalysis(): Promise<DriftAnalysisResult> {
  // Gate: opt-in via env
  if (process.env.WHATSON_DRIFT_ENABLED !== "true") {
    return {
      skipped: "WHATSON_DRIFT_ENABLED is not 'true'",
      factsAnalyzed: 0,
      findings: 0,
      inconsistencies: 0,
      questionsGenerated: 0,
    };
  }

  // Gate: drift needs tool access (Read/Grep/Glob/Bash) to scan the target
  // repo, which the SDK backend cannot provide. Refuse if the resolver
  // returns "sdk" for this component.
  if (resolveBackend("drift") !== "cli") {
    return {
      skipped: "drift requires LLM_BACKEND_DRIFT=cli (needs tool access)",
      factsAnalyzed: 0,
      findings: 0,
      inconsistencies: 0,
      questionsGenerated: 0,
    };
  }

  // Gate: claude binary must exist
  if (!claudeExists()) {
    return {
      skipped: "claude CLI not found on PATH",
      factsAnalyzed: 0,
      findings: 0,
      inconsistencies: 0,
      questionsGenerated: 0,
    };
  }

  // Gate: target repo must be cloned
  const cfg = getRepoSyncConfig();
  const workDir = cfg?.workDir ?? DEFAULT_WORKDIR;
  if (!fs.existsSync(path.join(workDir, ".git"))) {
    return {
      skipped: "target repo not cloned (run sync first)",
      factsAnalyzed: 0,
      findings: 0,
      inconsistencies: 0,
      questionsGenerated: 0,
    };
  }

  // Gather facts to analyze: decisions + high-confidence facts
  const allFacts = await getActiveFacts();
  const factsToAnalyze = allFacts.filter(
    (f) => f.source_type === "decision" || f.confidence === "high"
  );

  if (factsToAnalyze.length === 0) {
    return {
      skipped: "no high-confidence decisions or facts to analyze",
      factsAnalyzed: 0,
      findings: 0,
      inconsistencies: 0,
      questionsGenerated: 0,
    };
  }

  // Build prompt and invoke Claude Code
  const prompt = buildAnalysisPrompt(factsToAnalyze);
  const rawOutput = invokeClaudeCode(prompt, workDir);
  const findings = parseClaudeOutput(rawOutput);

  // Store findings
  const runAt = new Date().toISOString();
  let inconsistencies = 0;
  let questionsGenerated = 0;

  for (const f of findings) {
    await insertDriftFinding({
      run_at: runAt,
      fact_id: f.fact_id,
      consistent: f.consistent,
      evidence: f.evidence,
      question: f.question,
    });
    if (!f.consistent) inconsistencies++;
    if (f.question) questionsGenerated++;
  }

  return {
    factsAnalyzed: factsToAnalyze.length,
    findings: findings.length,
    inconsistencies,
    questionsGenerated,
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

  if (result.inconsistencies === 0) {
    return `Drift analysis: ${result.factsAnalyzed} facts checked, all consistent`;
  }

  const findings = await getDriftFindings();
  const inconsistent = findings.filter((f) => !f.consistent);
  const factIds = inconsistent.map((f) => f.fact_id);
  const facts = await getFactsByIds(factIds);
  const factMap = new Map(facts.map((f) => [f.id!, f]));

  const lines: string[] = [
    `Drift analysis: ${result.inconsistencies} inconsistencies found (${result.factsAnalyzed} facts checked)`,
  ];

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
