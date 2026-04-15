/**
 * LLM backend dispatcher.
 *
 * Centralises every Anthropic call behind a single `callModel()` function so
 * callers don't care whether they reach Claude via the SDK (api.anthropic.com,
 * billed against API credits) or via the `claude` CLI (Claude Code headless
 * mode, billed against a Pro/Max subscription when the binary is logged in).
 *
 * Backend resolution per component:
 *   1. `LLM_BACKEND_<COMPONENT>`  (e.g. LLM_BACKEND_RENDER=cli)
 *   2. `LLM_BACKEND`              (global default)
 *   3. fallback: "sdk"
 *
 * Components enumerated here include every current and planned caller.
 * `retrieval` is listed for future use — retrieval.ts is still SQL-only.
 * `drift` is CLI-only by design (needs tool access to scan the target repo);
 * drift.ts will refuse to run if the resolver returns "sdk" for it.
 *
 * CLI caveat: `claude -p` uses whichever auth the binary is configured with.
 * If `ANTHROPIC_API_KEY` is present in the environment it normally takes
 * precedence over a logged-in session. To bill a Pro/Max subscription, unset
 * `ANTHROPIC_API_KEY` for the container (or the render subprocess) and ensure
 * `claude login` was run with the session volume mounted.
 */

import Anthropic from "@anthropic-ai/sdk";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// ── Component registry ──────────────────────────────────────────────────────

export type LlmComponent =
  | "extract"
  | "consolidation"
  | "drift"
  | "render"
  | "retrieval";

export type LlmBackend = "sdk" | "cli";

const COMPONENTS: LlmComponent[] = [
  "extract",
  "consolidation",
  "drift",
  "render",
  "retrieval",
];

/**
 * Per-component fallback when neither the component-specific env var nor the
 * global `LLM_BACKEND` is set. `drift` is CLI-only by design (it needs tool
 * access to scan the target repo); everything else defaults to SDK.
 */
const COMPONENT_DEFAULTS: Record<LlmComponent, LlmBackend> = {
  extract: "sdk",
  consolidation: "sdk",
  drift: "cli",
  render: "sdk",
  retrieval: "sdk",
};

function envVarFor(component: LlmComponent): string {
  return `LLM_BACKEND_${component.toUpperCase()}`;
}

export function resolveBackend(component: LlmComponent): LlmBackend {
  const specific = process.env[envVarFor(component)]?.toLowerCase();
  if (specific === "sdk" || specific === "cli") return specific;
  const global = process.env.LLM_BACKEND?.toLowerCase();
  if (global === "sdk" || global === "cli") return global;
  return COMPONENT_DEFAULTS[component];
}

/** Dump the currently-resolved backend for every component (for diagnostics). */
export function backendMatrix(): Record<LlmComponent, LlmBackend> {
  const out = {} as Record<LlmComponent, LlmBackend>;
  for (const c of COMPONENTS) out[c] = resolveBackend(c);
  return out;
}

// ── Call interface ──────────────────────────────────────────────────────────

export interface LlmCallOptions {
  component: LlmComponent;
  system: string;
  user: string;
  maxTokens?: number;
  /** SDK path only. Ignored by CLI (CLI uses whichever model `claude` chooses). */
  model?: string;
  /** CLI path only. Extra args forwarded to `claude -p`. */
  cliExtraArgs?: string[];
}

export interface LlmCallResult {
  text: string;
  backend: LlmBackend;
}

// ── SDK path ────────────────────────────────────────────────────────────────

let _sdkClient: Anthropic | null = null;

function getSdkClient(): Anthropic | null {
  if (_sdkClient) return _sdkClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  _sdkClient = new Anthropic({ apiKey });
  return _sdkClient;
}

/** Test hook: replace (or reset with null) the SDK client. */
export function _setSdkClientForTest(client: Anthropic | null): void {
  _sdkClient = client;
}

async function callSdk(opts: LlmCallOptions): Promise<LlmCallResult> {
  const client = getSdkClient();
  if (!client) {
    throw new Error("ANTHROPIC_API_KEY not set — SDK backend unavailable");
  }
  const response = await client.messages.create({
    model: opts.model ?? "claude-sonnet-4-6",
    max_tokens: opts.maxTokens ?? 4096,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
  });
  const block = response.content[0];
  if (!block || block.type !== "text") {
    throw new Error("SDK returned a non-text content block");
  }
  return { text: block.text.trim(), backend: "sdk" };
}

// ── CLI path ────────────────────────────────────────────────────────────────
// Uses `claude -p` (Claude Code print/headless mode). System prompt is passed
// via `--append-system-prompt` so the user message stays the -p argument and
// both sides are shell-escaped by execFile (no string concatenation = no
// injection risk).

const DEFAULT_CLI_BIN = "claude";
const CLI_TIMEOUT_MS = 5 * 60 * 1000; // 5 min safety cap
const CLI_MAX_BUFFER = 10 * 1024 * 1024; // 10 MB stdout

async function callCli(opts: LlmCallOptions): Promise<LlmCallResult> {
  const bin = process.env.CLAUDE_CLI_BIN ?? DEFAULT_CLI_BIN;
  const args = [
    "-p", opts.user,
    "--append-system-prompt", opts.system,
    "--output-format", "text",
    "--no-session-persistence",
    ...(opts.cliExtraArgs ?? []),
  ];
  // Strip ANTHROPIC_API_KEY so `claude -p` falls back to the logged-in
  // session (billing Pro/Max) instead of silently using API credits.
  const { ANTHROPIC_API_KEY: _stripped, ...childEnv } = process.env;
  try {
    const { stdout } = await execFileAsync(bin, args, {
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: CLI_MAX_BUFFER,
      env: childEnv,
    });
    return { text: stdout.trim(), backend: "cli" };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const detail = e.stderr?.toString().trim() || e.message;
    throw new Error(`claude CLI call failed: ${detail}`);
  }
}

// ── Dispatcher ──────────────────────────────────────────────────────────────

export async function callModel(opts: LlmCallOptions): Promise<LlmCallResult> {
  const backend = resolveBackend(opts.component);
  return backend === "cli" ? callCli(opts) : callSdk(opts);
}

/** Quick probe: is the resolved backend for `component` usable right now? */
export function isBackendReady(component: LlmComponent): { ready: boolean; reason?: string } {
  const backend = resolveBackend(component);
  if (backend === "sdk") {
    // If a test has pre-injected a client, we're ready regardless of env.
    if (_sdkClient) return { ready: true };
    if (!process.env.ANTHROPIC_API_KEY) {
      return { ready: false, reason: "ANTHROPIC_API_KEY not set" };
    }
    return { ready: true };
  }
  // CLI: we can't cheaply verify the binary without shelling out; trust PATH.
  return { ready: true };
}
