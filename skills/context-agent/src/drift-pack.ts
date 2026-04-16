/**
 * Drift analysis — repomix + SDK path.
 *
 * Pack the target repo once via `repomix --stdout --compress`, then run a
 * per-fact SDK call that puts the packed repo in the system prompt with a
 * `cache_control: ephemeral` marker. The first fact in a run pays the full
 * prefix; every subsequent fact inside the 5-minute cache TTL pays ~10%.
 *
 * This module is intentionally self-contained — it bypasses the llm.ts
 * dispatcher because the dispatcher doesn't yet model cache markers and
 * drift.ts is the only current caller that needs them. If a second caller
 * shows up, lift the cache support into llm.ts.
 */

import Anthropic from "@anthropic-ai/sdk";
import { execFile } from "child_process";
import { promisify } from "util";
import type { Fact } from "./storage.js";
import { parsePerFactOutput, type ClaudeFinding } from "./drift.js";

const execFileAsync = promisify(execFile);

const REPOMIX_TIMEOUT_MS = 3 * 60 * 1000;
const REPOMIX_MAX_BUFFER = 64 * 1024 * 1024; // 64 MB — large enough for most repos
const SDK_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Pack a repo into a single string via `npx repomix --stdout`.
 * Compressed (tree-sitter) XML to maximise semantic density per token.
 */
export async function packRepo(workDir: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "npx",
    [
      "--yes",
      "repomix",
      "--stdout",
      "--style", "xml",
      "--compress",
      "--quiet",
      workDir,
    ],
    {
      timeout: REPOMIX_TIMEOUT_MS,
      maxBuffer: REPOMIX_MAX_BUFFER,
      encoding: "utf-8",
    },
  );
  return stdout;
}

// ── SDK client ──────────────────────────────────────────────────────────────

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set — repomix drift path requires SDK backend");
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

/** Test hook. */
export function _setClientForTest(client: Anthropic | null): void {
  _client = client;
}

// ── Per-fact prompt (packed-context variant) ────────────────────────────────

/**
 * Shorter prompt than the per-fact CLI variant: the model already has the
 * full repo in context, so no "search first" scaffolding is needed.
 */
export function buildPackedFactPrompt(fact: Fact): string {
  return `Verify this recorded fact against the codebase provided in the system prompt.

## Fact to verify

- ID: ${fact.id}
- Type: ${fact.source_type} (confidence: ${fact.confidence})
- Content: ${fact.content}
- Recorded: ${fact.valid_from.slice(0, 10)} from ${fact.source}

## Your job

Decide: is the codebase CONSISTENT or INCONSISTENT with the stated fact?
- Do NOT flag style differences — only semantic drift (wrong tech, missing feature, contradicted architecture).
- If you find no evidence either way, mark inconsistent and write a question.
- Cite specific file paths in evidence.

## Output

Respond with ONLY a JSON object (no markdown fences, no commentary):

{"fact_id": ${fact.id}, "consistent": <boolean>, "evidence": "<file:line — what you found, or null>", "question": "<question for stakeholders, or null if consistent>"}
`;
}

// ── SDK call with cache_control on the packed repo ──────────────────────────

const PACK_SYSTEM_HEADER = `You are a codebase consistency auditor. The following is the complete target codebase, packed via repomix. Subsequent user turns will each ask you to verify one recorded fact against this codebase.`;

export interface InvokePackedOptions {
  packedRepo: string;
  fact: Fact;
  model?: string;
  maxTokens?: number;
}

export async function invokePackedSdk(opts: InvokePackedOptions): Promise<ClaudeFinding> {
  const client = getClient();
  const model = opts.model ?? process.env.WHATSON_DRIFT_MODEL ?? "claude-sonnet-4-6";

  const response = await client.messages.create(
    {
      model,
      max_tokens: opts.maxTokens ?? 1024,
      system: [
        { type: "text", text: PACK_SYSTEM_HEADER },
        {
          type: "text",
          text: opts.packedRepo,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: buildPackedFactPrompt(opts.fact) }],
    },
    { timeout: SDK_TIMEOUT_MS },
  );

  const block = response.content[0];
  if (!block || block.type !== "text") {
    throw new Error("SDK returned a non-text content block");
  }
  return parsePerFactOutput(block.text, opts.fact.id!);
}
