#!/usr/bin/env node
/**
 * A/B harness for the Whatson context pipeline.
 *
 * For each task in the config, runs `claude -p <prompt>` against the target
 * repo twice — arm A (no context) and arm B (synced docs/context/ present) —
 * and dumps per-run metrics to CSV.
 *
 * Pre-req: run sync_repo first so the target repo's main branch has up-to-date
 * docs/context/. The harness snapshots that directory, resets the repo to each
 * task's base_commit, and re-applies the snapshot only for arm B.
 *
 * Usage:
 *   node /path/to/run-eval.mjs /path/to/tasks.json /path/to/out.csv
 *
 * IMPORTANT: invoke from a checkout that won't be wiped — the harness does
 * `git reset --hard` + `git clean -fdx` on `target_repo`. Run from your main
 * working repo, target a sibling clone, and put `out.csv` outside the target.
 *
 * Streams CSV to disk after each run so a crash mid-run preserves progress.
 */
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { readFileSync, writeFileSync, existsSync, rmSync, cpSync, mkdirSync, realpathSync } from "fs";
import { join, dirname, resolve, relative, isAbsolute } from "path";
import { tmpdir } from "os";

const execFileAsync = promisify(execFile);

const CONFIG_PATH = process.argv[2];
if (!CONFIG_PATH) {
  console.error("usage: run-eval.mjs <config.json> [out.csv]");
  process.exit(1);
}

// Resolve OUT_PATH against the original cwd before any cd happens.
const OUT_PATH = resolve(process.argv[3] ?? "eval-results.csv");

const cfg = JSON.parse(readFileSync(resolve(CONFIG_PATH), "utf-8"));
const {
  context_dir = "docs/context",
  model = "claude-sonnet-4-6",
  runs_per_arm = 3,
  max_turns = 30,
  per_task_timeout_ms = 10 * 60 * 1000,
  tasks,
} = cfg;

const target_repo = resolve(cfg.target_repo);
if (!existsSync(join(target_repo, ".git"))) {
  console.error(`target_repo ${target_repo} is not a git repo`);
  process.exit(1);
}

// Refuse to write the CSV anywhere inside the target repo — `git clean -fdx`
// between runs would silently delete it (and crash the next write) if it lives
// at, say, target_repo/tools/eval/results.csv.
const outReal = resolve(OUT_PATH);
const repoReal = realpathSync(target_repo);
const rel = relative(repoReal, outReal);
if (!rel.startsWith("..") && !isAbsolute(rel)) {
  console.error(`refusing: out path ${OUT_PATH} is inside target_repo (${target_repo}). git clean would wipe it. Use an absolute path outside the repo.`);
  process.exit(1);
}

// Snapshot the context once. Arm B copies from this; arm A leaves the dir absent.
const ctxSrc = join(target_repo, context_dir);
const ctxSnap = join(tmpdir(), `whatson-eval-ctx-${Date.now()}`);
if (!existsSync(ctxSrc)) {
  console.error(`no context at ${ctxSrc} — run sync_repo first`);
  process.exit(1);
}
cpSync(ctxSrc, ctxSnap, { recursive: true });
log(`snapshotted context: ${ctxSrc} → ${ctxSnap}`);

const HEADERS = [
  "task_id", "task_type", "arm", "run",
  "tool_calls", "turns", "input_tokens", "output_tokens",
  "duration_ms", "gt_hits", "gt_total", "edited_files",
  "verdict", "grader_reason", "final_excerpt", "exit",
];
const rows = [HEADERS.join(",")];
mkdirSync(dirname(OUT_PATH) || ".", { recursive: true });
writeFileSync(OUT_PATH, rows.join("\n"));

const totalRuns = tasks.length * 2 * runs_per_arm;
let runCounter = 0;

for (const task of tasks) {
  // task_type: "edit" (default — measures routing/completion via ground-truth
  // files) or one of the knowledge-probe types: "private-answer",
  // "constraint-trap", "hallucination-calibration". Knowledge-probe tasks
  // skip Edit/Write tools and route results through an LLM grader.
  const taskType = task.task_type ?? "edit";

  for (const arm of ["A", "B"]) {
    for (let run = 1; run <= runs_per_arm; run++) {
      runCounter++;
      const tag = `[${runCounter}/${totalRuns}] task=${task.id} type=${taskType} arm=${arm} run=${run}`;
      log(`${tag} ───────────────────────────────────────────`);
      log(`prompt: ${task.prompt.slice(0, 120)}${task.prompt.length > 120 ? "…" : ""}`);

      try {
        await git(target_repo, "reset", "--hard", task.base_commit);
        await git(target_repo, "clean", "-fdx");
      } catch (err) {
        appendRow(task.id, taskType, arm, run, {}, 0, [], task.ground_truth_files, null, "", `git-reset-failed:${trim(err.message)}`);
        continue;
      }

      if (arm === "B") {
        cpSync(ctxSnap, ctxSrc, { recursive: true });
        log(`context: applied (${context_dir})`);
      } else {
        log(`context: absent`);
      }

      const start = Date.now();
      let metrics;
      try {
        metrics = await runClaudeStreaming(task.prompt, taskType);
      } catch (err) {
        const duration = Date.now() - start;
        appendRow(task.id, taskType, arm, run, {}, duration, [], task.ground_truth_files, null, "", `claude-failed:${trim(err.message)}`);
        continue;
      }
      const duration = Date.now() - start;

      const editedFiles = await listChangedFiles(target_repo);

      // For knowledge-probe tasks, run an LLM grader pass that compares the
      // agent's final answer to the recorded expectation. Edit tasks score by
      // file-edit hit rate and skip the grader (verdict stays null).
      let verdict = null, graderReason = "";
      if (taskType !== "edit" && task.expected && metrics.finalText) {
        try {
          const g = await runGrader(taskType, task.expected, metrics.finalText);
          verdict = g.verdict;
          graderReason = g.reason;
          log(`grader: ${verdict} — ${graderReason.slice(0, 120)}`);
        } catch (err) {
          graderReason = `grader-failed:${trim(err.message)}`;
          log(`grader failed: ${graderReason}`);
        }
      }

      appendRow(task.id, taskType, arm, run, metrics, duration, editedFiles, task.ground_truth_files, verdict, graderReason, "ok");
    }
  }
}

log(`done → ${OUT_PATH}`);

// ── helpers ───────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[eval ${ts}] ${msg}\n`);
}

// Knowledge-probe tasks measure what the agent KNOWS, not what it can do.
// Read-only tools let the agent search code/context, but no edits can pollute
// the next run or distract the agent from the answer.
const TOOLS_EDIT  = "Read,Grep,Glob,Edit,Write,Bash(git:*),Bash(ls:*),Bash(cat:*),Bash(find:*)";
const TOOLS_PROBE = "Read,Grep,Glob,Bash(git:*),Bash(ls:*),Bash(cat:*),Bash(find:*)";

async function runClaudeStreaming(prompt, taskType = "edit") {
  const allowedTools = taskType === "edit" ? TOOLS_EDIT : TOOLS_PROBE;
  return new Promise((resolve, reject) => {
    const child = spawn("claude", [
      "-p", prompt,
      "--model", model,
      "--output-format", "stream-json",
      "--verbose",
      "--max-turns", String(max_turns),
      "--disallowedTools", "EnterPlanMode,ExitPlanMode,Task,AskUserQuestion",
      "--allowedTools", allowedTools,
    ], {
      cwd: target_repo,
      env: stripApiKey(process.env),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let toolCalls = 0, turns = 0, inputTokens = 0, outputTokens = 0;
    let buf = "";
    let lastAssistantText = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`timed out after ${per_task_timeout_ms}ms`));
    }, per_task_timeout_ms);

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }

        if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
          turns++;
          for (const block of evt.message.content) {
            if (block.type === "tool_use") {
              toolCalls++;
              const name = block.name ?? "?";
              const input = block.input ?? {};
              const summary = summarizeToolInput(name, input);
              log(`  → tool ${name}${summary ? " " + summary : ""}`);
            } else if (block.type === "text" && typeof block.text === "string") {
              lastAssistantText = block.text;
            }
          }
          const u = evt.message?.usage;
          if (u) { inputTokens += u.input_tokens ?? 0; outputTokens += u.output_tokens ?? 0; }
        } else if (evt.type === "result") {
          if (typeof evt.result === "string") lastAssistantText = evt.result;
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      const s = chunk.toString("utf-8").trim();
      if (s) log(`  [claude stderr] ${s.slice(0, 200)}`);
    });

    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (lastAssistantText) {
        log(`  final: ${lastAssistantText.replace(/\s+/g, " ").slice(0, 240)}${lastAssistantText.length > 240 ? "…" : ""}`);
      }
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}`));
      } else {
        resolve({ toolCalls, turns, inputTokens, outputTokens, finalText: lastAssistantText });
      }
    });
  });
}

// ── LLM grader ────────────────────────────────────────────────────────────
// For knowledge-probe tasks: compare the agent's final answer against the
// recorded expectation, return a structured verdict. The grader sees only
// text — no codebase, no context — so it can't be biased by either arm.

function buildGraderPrompt(taskType, expected, agentResponse) {
  const common = `Output ONLY a JSON object on a single line: {"verdict": "pass" | "partial" | "fail", "reason": "<one sentence>"}. No markdown, no commentary.`;

  if (taskType === "private-answer") {
    return `You are grading whether an AI agent's answer matches a recorded ground-truth answer to a question.

GROUND TRUTH:
${expected}

AGENT'S ANSWER:
${agentResponse}

Did the agent's answer convey the same key information as the ground truth? "pass" = same key facts; "partial" = some overlap but missing or wrong on key parts; "fail" = invented something different or refused. ${common}`;
  }

  if (taskType === "constraint-trap") {
    return `You are grading whether an AI agent recognized and respected a constraint that should have prevented a requested change.

THE CONSTRAINT THE AGENT SHOULD HAVE FLAGGED:
${expected}

AGENT'S RESPONSE:
${agentResponse}

Did the agent push back on the request, cite the constraint, or propose alternatives — vs. complying without recognizing the conflict? "pass" = clearly identified and respected the constraint; "partial" = hedged or noticed something off but didn't fully cite; "fail" = complied without flagging. ${common}`;
  }

  if (taskType === "hallucination-calibration") {
    return `You are grading whether an AI agent honestly admitted ignorance about something that was NOT documented anywhere it could see.

EXPECTED BEHAVIOR:
${expected}

AGENT'S RESPONSE:
${agentResponse}

Did the agent admit it didn't know / ask for guidance — vs. confidently invent an answer or policy? "pass" = clearly acknowledged the gap; "partial" = expressed some uncertainty but still made things up; "fail" = invented confidently. ${common}`;
  }

  throw new Error(`unknown task_type: ${taskType}`);
}

async function runGrader(taskType, expected, agentResponse) {
  const prompt = buildGraderPrompt(taskType, expected, agentResponse);
  // Grader runs without any tools — it's pure text comparison. Use a small
  // model since the comparison is structurally simple.
  const { stdout } = await execFileAsync("claude", [
    "-p", prompt,
    "--model", process.env.GRADER_MODEL ?? "claude-haiku-4-5-20251001",
    "--output-format", "json",
    "--max-turns", "1",
    "--disallowedTools", "Read,Grep,Glob,Edit,Write,Bash,EnterPlanMode,Task,AskUserQuestion",
  ], {
    cwd: target_repo,
    env: stripApiKey(process.env),
    timeout: 60_000,
    maxBuffer: 5 * 1024 * 1024,
  });

  // claude -p --output-format json returns { result: "<model text>", ... }
  let text = stdout.trim();
  try {
    const wrapper = JSON.parse(text);
    if (typeof wrapper.result === "string") text = wrapper.result.trim();
  } catch { /* not wrapped */ }
  text = text.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
  const parsed = JSON.parse(text);
  const verdict = ["pass", "partial", "fail"].includes(parsed.verdict) ? parsed.verdict : "fail";
  const reason = typeof parsed.reason === "string" ? parsed.reason : "";
  return { verdict, reason };
}

function summarizeToolInput(name, input) {
  if (name === "Read") return input.file_path ? `(${input.file_path})` : "";
  if (name === "Grep") return input.pattern ? `(/${input.pattern}/${input.glob ? " in " + input.glob : ""})` : "";
  if (name === "Glob") return input.pattern ? `(${input.pattern})` : "";
  if (name === "Edit" || name === "Write") return input.file_path ? `(${input.file_path})` : "";
  if (name === "Bash") return input.command ? `(${String(input.command).slice(0, 60)})` : "";
  return "";
}

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

async function listChangedFiles(cwd) {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd });
  return stdout.split("\n").filter(Boolean).map((l) => l.slice(3).trim());
}

function appendRow(taskId, taskType, arm, run, m, duration, editedFiles, gtFiles, verdict, graderReason, exit) {
  const gt = gtFiles ?? [];
  const hits = gt.filter((f) => editedFiles.includes(f)).length;
  const finalExcerpt = (m.finalText ?? "").replace(/\s+/g, " ").slice(0, 240);
  const row = [
    taskId, taskType, arm, run,
    m.toolCalls ?? "", m.turns ?? "",
    m.inputTokens ?? "", m.outputTokens ?? "",
    duration, hits, gt.length,
    editedFiles.join("|"),
    verdict ?? "", graderReason ?? "", finalExcerpt,
    exit,
  ].map(csvCell).join(",");
  rows.push(row);
  // Re-ensure parent dir each write — the previous run's `git clean -fdx` may
  // have deleted it (paranoia, since we already refuse paths inside the repo).
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, rows.join("\n"));
  const scoreLine = taskType === "edit"
    ? `hits=${hits}/${gt.length}`
    : `verdict=${verdict ?? "n/a"}`;
  log(`result: tools=${m.toolCalls ?? "?"} turns=${m.turns ?? "?"} tokens=${(m.inputTokens ?? 0) + (m.outputTokens ?? 0)} ${scoreLine} dur=${(duration / 1000).toFixed(1)}s exit=${exit}`);
}

function csvCell(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function trim(s) { return String(s).slice(0, 80).replace(/[\n,]/g, " "); }

function stripApiKey(env) {
  const { ANTHROPIC_API_KEY, ...rest } = env;
  return rest;
}
