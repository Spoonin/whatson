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
  "task_id", "arm", "run",
  "tool_calls", "turns", "input_tokens", "output_tokens",
  "duration_ms", "gt_hits", "gt_total", "edited_files", "exit",
];
const rows = [HEADERS.join(",")];
mkdirSync(dirname(OUT_PATH) || ".", { recursive: true });
writeFileSync(OUT_PATH, rows.join("\n"));

const totalRuns = tasks.length * 2 * runs_per_arm;
let runCounter = 0;

for (const task of tasks) {
  for (const arm of ["A", "B"]) {
    for (let run = 1; run <= runs_per_arm; run++) {
      runCounter++;
      const tag = `[${runCounter}/${totalRuns}] task=${task.id} arm=${arm} run=${run}`;
      log(`${tag} ───────────────────────────────────────────`);
      log(`prompt: ${task.prompt.slice(0, 120)}${task.prompt.length > 120 ? "…" : ""}`);

      try {
        await git(target_repo, "reset", "--hard", task.base_commit);
        await git(target_repo, "clean", "-fdx");
      } catch (err) {
        appendRow(task.id, arm, run, {}, 0, [], task.ground_truth_files, `git-reset-failed:${trim(err.message)}`);
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
        metrics = await runClaudeStreaming(task.prompt);
      } catch (err) {
        const duration = Date.now() - start;
        appendRow(task.id, arm, run, {}, duration, [], task.ground_truth_files, `claude-failed:${trim(err.message)}`);
        continue;
      }
      const duration = Date.now() - start;

      const editedFiles = await listChangedFiles(target_repo);
      appendRow(task.id, arm, run, metrics, duration, editedFiles, task.ground_truth_files, "ok");
    }
  }
}

log(`done → ${OUT_PATH}`);

// ── helpers ───────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[eval ${ts}] ${msg}\n`);
}

async function runClaudeStreaming(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", [
      "-p", prompt,
      "--model", model,
      "--output-format", "stream-json",
      "--verbose",
      "--max-turns", String(max_turns),
      "--allowedTools", "Read,Grep,Glob,Edit,Write,Bash(git:*),Bash(ls:*),Bash(cat:*),Bash(find:*)",
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
        resolve({ toolCalls, turns, inputTokens, outputTokens });
      }
    });
  });
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

function appendRow(taskId, arm, run, m, duration, editedFiles, gtFiles, exit) {
  const gt = gtFiles ?? [];
  const hits = gt.filter((f) => editedFiles.includes(f)).length;
  const row = [
    taskId, arm, run,
    m.toolCalls ?? "", m.turns ?? "",
    m.inputTokens ?? "", m.outputTokens ?? "",
    duration, hits, gt.length,
    editedFiles.join("|"), exit,
  ].map(csvCell).join(",");
  rows.push(row);
  // Re-ensure parent dir each write — the previous run's `git clean -fdx` may
  // have deleted it (paranoia, since we already refuse paths inside the repo).
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, rows.join("\n"));
  log(`result: tools=${m.toolCalls ?? "?"} turns=${m.turns ?? "?"} tokens=${(m.inputTokens ?? 0) + (m.outputTokens ?? 0)} hits=${hits}/${gt.length} edited=${editedFiles.length} files dur=${(duration / 1000).toFixed(1)}s exit=${exit}`);
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
