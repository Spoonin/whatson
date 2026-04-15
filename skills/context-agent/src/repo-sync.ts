/**
 * Module: Target Repo Sync
 *
 * Exports the active knowledge base to a target project's `docs/context/`
 * directory as structured markdown, then commits and pushes so other AI agents
 * working on the target repo can discover the context naturally.
 *
 * Layout produced inside the target repo:
 *   docs/context/
 *     INDEX.md            — top-level summary (≤200 lines)
 *     topics/<tag>.md     — per-topic fact summaries
 *     sources/<date>_<source>.md — per-source extraction summaries
 *
 * Configured via env vars (all optional — sync is skipped if TARGET_REPO unset):
 *   TARGET_REPO             — git URL (https or ssh)
 *   WHATSON_CONTEXT_DIR     — default: "docs/context"
 *   WHATSON_TARGET_WORKDIR  — default: "<data>/target-repo"
 *   GITHUB_TOKEN            — injected into https URLs for auth
 *   WHATSON_COMMIT_AUTHOR   — default: "Whatson <whatson@bot.local>"
 *   WHATSON_SYNC_PUSH       — "false" to skip push (local commit only)
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getActiveFacts, type Fact } from "./storage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKDIR = path.resolve(__dirname, "../data/target-repo");

const INDEX_LINE_BUDGET = 200;

export interface RepoSyncConfig {
  targetRepo: string;
  contextDir: string;
  workDir: string;
  githubToken?: string;
  commitAuthorName: string;
  commitAuthorEmail: string;
  push: boolean;
}

export interface RepoSyncResult {
  skipped?: string;
  filesWritten: number;
  committed: boolean;
  pushed: boolean;
  commitSha?: string;
  commitMessage?: string;
}

// ── Config ───────────────────────────────────────────────────────────────────

export function getRepoSyncConfig(): RepoSyncConfig | null {
  const targetRepo = process.env.TARGET_REPO;
  if (!targetRepo) return null;

  const rawAuthor = process.env.WHATSON_COMMIT_AUTHOR ?? "Whatson <whatson@bot.local>";
  const match = rawAuthor.match(/^(.*)<(.+)>$/);
  const commitAuthorName = (match?.[1] ?? "Whatson").trim();
  const commitAuthorEmail = (match?.[2] ?? "whatson@bot.local").trim();

  return {
    targetRepo,
    contextDir: process.env.WHATSON_CONTEXT_DIR ?? "docs/context",
    workDir: process.env.WHATSON_TARGET_WORKDIR ?? DEFAULT_WORKDIR,
    githubToken: process.env.GITHUB_TOKEN,
    commitAuthorName,
    commitAuthorEmail,
    push: process.env.WHATSON_SYNC_PUSH !== "false",
  };
}

// ── Git helpers ──────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Inject a GitHub token into an https URL for basic auth. Leaves ssh URLs alone. */
function authUrl(repo: string, token?: string): string {
  if (!token) return repo;
  if (repo.startsWith("https://")) {
    return repo.replace(/^https:\/\//, `https://x-access-token:${token}@`);
  }
  return repo;
}

/** Strip any injected `x-access-token:…@` credentials from an https URL. */
function stripAuth(url: string): string {
  return url.replace(/^(https:\/\/)[^@/]+@/, "$1");
}

/** Clone the target repo if not present, otherwise fetch + reset to origin HEAD. */
function ensureCheckout(cfg: RepoSyncConfig): void {
  const gitDir = path.join(cfg.workDir, ".git");

  if (fs.existsSync(gitDir)) {
    // If the existing checkout points at a different remote (e.g. TARGET_REPO
    // was changed), wipe it and re-clone. Otherwise we'd silently keep
    // pushing to the old repo.
    let currentRemote = "";
    try {
      currentRemote = git(["remote", "get-url", "origin"], cfg.workDir).trim();
    } catch {
      // no origin — treat as stale
    }
    if (stripAuth(currentRemote) !== stripAuth(cfg.targetRepo)) {
      fs.rmSync(cfg.workDir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(cfg.workDir), { recursive: true });
      const url = authUrl(cfg.targetRepo, cfg.githubToken);
      execFileSync("git", ["clone", url, cfg.workDir], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      return;
    }
    git(["fetch", "origin"], cfg.workDir);
    // Determine default branch from origin HEAD; fall back to main/master.
    let ref = "origin/HEAD";
    try {
      git(["symbolic-ref", "refs/remotes/origin/HEAD"], cfg.workDir);
    } catch {
      try {
        git(["rev-parse", "--verify", "origin/main"], cfg.workDir);
        ref = "origin/main";
      } catch {
        ref = "origin/master";
      }
    }
    git(["reset", "--hard", ref], cfg.workDir);
    return;
  }

  fs.mkdirSync(path.dirname(cfg.workDir), { recursive: true });
  const url = authUrl(cfg.targetRepo, cfg.githubToken);
  execFileSync("git", ["clone", url, cfg.workDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// ── Grouping ─────────────────────────────────────────────────────────────────

function groupByTag(facts: Fact[]): Map<string, Fact[]> {
  const map = new Map<string, Fact[]>();
  for (const f of facts) {
    const tags = f.tags.length > 0 ? f.tags : ["untagged"];
    for (const tag of tags) {
      const list = map.get(tag) ?? [];
      list.push(f);
      map.set(tag, list);
    }
  }
  return map;
}

/**
 * Group facts by (source, day) so that each source gets a separate file per
 * calendar day.  Without the day component a single high-traffic source
 * (e.g. "telegram") would produce one ever-growing file.
 *
 * The map key is "YYYY-MM-DD/<source>" which `sourceFilename()` turns into
 * the on-disk filename  `YYYY-MM-DD_<slug>.md`.
 */
function groupBySource(facts: Fact[]): Map<string, Fact[]> {
  const map = new Map<string, Fact[]>();
  for (const f of facts) {
    const src = f.source_url ?? f.source_file ?? f.source;
    const day = dateOnly(f.created_at);
    const key = `${day}/${src}`;
    const list = map.get(key) ?? [];
    list.push(f);
    map.set(key, list);
  }
  return map;
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** Check if a correction likely refers to a given fact (lenient keyword overlap). */
function correctionTargets(correction: string, fact: string): boolean {
  const words = (s: string) => new Set(s.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter((w) => w.length > 2));
  const cWords = words(correction);
  const fWords = words(fact);
  let shared = 0;
  for (const w of fWords) {
    if (cWords.has(w)) shared++;
  }
  return shared >= 2;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";
}

function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

function earliestFact(facts: Fact[]): Fact {
  return facts.reduce((a, b) => (a.created_at < b.created_at ? a : b));
}

function renderIndex(
  facts: Fact[],
  tagMap: Map<string, Fact[]>,
  sourceMap: Map<string, Fact[]>,
  now: string
): string {
  const lines: string[] = [
    `# Project Context Index`,
    ``,
    `> Maintained by Whatson. Last updated: ${dateOnly(now)}`,
    `> Active facts: ${facts.length} · Topics: ${tagMap.size} · Sources: ${sourceMap.size}`,
    ``,
    `Read this file first. It summarizes all project context below.`,
    `Corrections override earlier facts. Open questions need stakeholder input.`,
    `See \`topics/\` for detail by subject, \`sources/\` for raw extraction logs.`,
    ``,
    `## Topics`,
    ``,
  ];

  const topics = [...tagMap.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [tag, list] of topics) {
    lines.push(`- [${tag}](topics/${slugify(tag)}.md) — ${list.length} fact${list.length === 1 ? "" : "s"}`);
  }

  lines.push(``, `## Recent Decisions`, ``);
  const decisions = facts
    .filter((f) => f.source_type === "decision")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 20);
  for (const d of decisions) {
    lines.push(`- [${dateOnly(d.valid_from)}] ${d.content} *(${d.source})*`);
  }

  lines.push(``, `## Key Facts`, ``);
  const keyFacts = facts
    .filter((f) => f.source_type === "fact" && f.confidence === "high")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 20);
  for (const f of keyFacts) {
    lines.push(`- [${dateOnly(f.valid_from)}] ${f.content} *(${f.source})*`);
  }

  const corrections = facts
    .filter((f) => f.source_type === "correction")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 10);
  if (corrections.length > 0) {
    lines.push(``, `## Corrections`, ``);
    for (const c of corrections) {
      lines.push(`- [${dateOnly(c.valid_from)}] ${c.content} *(${c.source})*`);
    }
  }

  const openQuestions = facts
    .filter((f) => f.source_type === "question")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 10);
  if (openQuestions.length > 0) {
    lines.push(``, `## Open Questions`, ``);
    for (const q of openQuestions) {
      lines.push(`- [${dateOnly(q.valid_from)}] ${q.content} *(${q.source})*`);
    }
  }

  lines.push(``, `## Recent Sources`, ``);
  const recentSources = [...sourceMap.entries()]
    .map(([key, list]) => ({ key, first: earliestFact(list) }))
    .sort((a, b) => b.first.created_at.localeCompare(a.first.created_at))
    .slice(0, 10);
  for (const { key } of recentSources) {
    // key is "YYYY-MM-DD/<source>", extract parts for display
    const slashIdx = key.indexOf("/");
    const day = key.slice(0, slashIdx);
    const src = key.slice(slashIdx + 1);
    lines.push(`- [${src}](sources/${sourceFilename(key)}) — ${day}`);
  }

  // Enforce line budget
  if (lines.length > INDEX_LINE_BUDGET) {
    const trimmed = lines.slice(0, INDEX_LINE_BUDGET);
    trimmed.push(
      ``,
      `*(index truncated — ${lines.length - INDEX_LINE_BUDGET} lines over budget; see topics/ and sources/ for full detail)*`
    );
    return trimmed.join("\n") + "\n";
  }
  return lines.join("\n") + "\n";
}

function renderTopic(tag: string, facts: Fact[]): string {
  const title = tag.charAt(0).toUpperCase() + tag.slice(1);

  // Cross-references: collect other tags from facts in this topic
  const otherTags = new Set<string>();
  for (const f of facts) {
    for (const t of f.tags) {
      if (t !== tag) otherTags.add(t);
    }
  }
  const seeAlso = [...otherTags].sort().map((t) => `[${t}](${slugify(t)}.md)`).join(", ");
  const header = seeAlso
    ? `> ${facts.length} active fact${facts.length === 1 ? "" : "s"} · See also: ${seeAlso}`
    : `> ${facts.length} active fact${facts.length === 1 ? "" : "s"}`;

  const lines: string[] = [
    `# ${title}`,
    ``,
    header,
    ``,
  ];

  const byType: Record<string, Fact[]> = {};
  for (const f of facts) {
    (byType[f.source_type] ??= []).push(f);
  }

  // Non-correction facts for overlap matching
  const nonCorrections = facts.filter((f) => f.source_type !== "correction");

  const typeOrder: Array<[string, string]> = [
    ["decision", "Decisions"],
    ["fact", "Facts"],
    ["correction", "Corrections"],
    ["opinion", "Opinions"],
    ["question", "Open Questions"],
    ["summary", "Summaries"],
  ];

  for (const [type, heading] of typeOrder) {
    const list = byType[type];
    if (!list?.length) continue;
    lines.push(`## ${heading}`, ``);
    const sorted = list.sort((a, b) => b.created_at.localeCompare(a.created_at));
    for (const f of sorted) {
      lines.push(`- [${dateOnly(f.valid_from)}] ${f.content} *(${f.source}, ${f.confidence})*`);
      // For corrections, find which fact they override
      if (type === "correction") {
        const overridden = nonCorrections.find((o) => correctionTargets(f.content, o.content));
        if (overridden) {
          lines.push(`  - Overrides: "${overridden.content}" (${dateOnly(overridden.valid_from)})`);
        }
      }
    }
    lines.push(``);
  }

  return lines.join("\n");
}

function renderSource(key: string, facts: Fact[]): string {
  const first = earliestFact(facts);
  // key is "YYYY-MM-DD/<source>" — extract display name
  const displayName = key.slice(key.indexOf("/") + 1);
  const lines: string[] = [
    `# ${displayName}`,
    ``,
    `> Ingested: ${dateOnly(first.created_at)} · Source: ${first.source}${first.source_url ? ` · URL: ${first.source_url}` : ""}${first.source_file ? ` · File: ${first.source_file}` : ""}`,
    ``,
    `## Extracted Facts`,
    ``,
  ];

  for (const f of facts) {
    const tagStr = f.tags.length > 0 ? ` [${f.tags.join(", ")}]` : "";
    lines.push(`- **${f.source_type}** (${f.confidence}): ${f.content}${tagStr}`);
  }

  if (first.raw_message) {
    const excerpt = first.raw_message.length > 2000
      ? first.raw_message.slice(0, 2000) + "…"
      : first.raw_message;
    lines.push(``, `## Original`, ``, "```", excerpt, "```");
  }

  return lines.join("\n") + "\n";
}

/** Derive filename from the composite "YYYY-MM-DD/<source>" key. */
function sourceFilename(key: string): string {
  const slashIdx = key.indexOf("/");
  const day = key.slice(0, slashIdx);   // "YYYY-MM-DD"
  const src = key.slice(slashIdx + 1);  // original source string
  return `${day}_${slugify(src)}.md`;
}

// ── Single-file push (for render artifacts) ──────────────────────────────────

/**
 * Copy a single rendered file into the target repo and push.
 * Reuses the same checkout/auth/commit flow as syncToTargetRepo.
 */
export async function syncRenderedFile(
  localPath: string,
  artifact: string
): Promise<RepoSyncResult> {
  const cfg = getRepoSyncConfig();
  if (!cfg) {
    return { skipped: "TARGET_REPO not configured", filesWritten: 0, committed: false, pushed: false };
  }

  ensureCheckout(cfg);

  const contextPath = path.join(cfg.workDir, cfg.contextDir);
  fs.mkdirSync(contextPath, { recursive: true });
  fs.copyFileSync(localPath, path.join(contextPath, artifact));

  const relPath = path.join(cfg.contextDir, artifact);
  const authorArgs = [
    "-c", `user.name=${cfg.commitAuthorName}`,
    "-c", `user.email=${cfg.commitAuthorEmail}`,
  ];

  git(["add", relPath], cfg.workDir);

  const status = git(["status", "--porcelain", relPath], cfg.workDir).trim();
  if (status.length === 0) {
    return { filesWritten: 1, committed: false, pushed: false };
  }

  const commitMessage = `context: render ${artifact}`;
  git([...authorArgs, "commit", "-m", commitMessage], cfg.workDir);
  const commitSha = git(["rev-parse", "HEAD"], cfg.workDir).trim();

  let pushed = false;
  if (cfg.push) {
    git(["push"], cfg.workDir);
    pushed = true;
  }

  return { filesWritten: 1, committed: true, pushed, commitSha, commitMessage };
}

// ── Main sync ────────────────────────────────────────────────────────────────

export async function syncToTargetRepo(): Promise<RepoSyncResult> {
  const cfg = getRepoSyncConfig();
  if (!cfg) {
    return {
      skipped: "TARGET_REPO not configured",
      filesWritten: 0,
      committed: false,
      pushed: false,
    };
  }

  ensureCheckout(cfg);

  const facts = await getActiveFacts();
  const tagMap = groupByTag(facts);
  const sourceMap = groupBySource(facts);
  const now = new Date().toISOString();

  const contextPath = path.join(cfg.workDir, cfg.contextDir);
  const topicsPath = path.join(contextPath, "topics");
  const sourcesPath = path.join(contextPath, "sources");
  fs.mkdirSync(topicsPath, { recursive: true });
  fs.mkdirSync(sourcesPath, { recursive: true });

  let filesWritten = 0;

  // Clean old topic and source files to avoid stale entries
  for (const dir of [topicsPath, sourcesPath]) {
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith(".md")) fs.unlinkSync(path.join(dir, file));
    }
  }

  // INDEX.md
  fs.writeFileSync(path.join(contextPath, "INDEX.md"), renderIndex(facts, tagMap, sourceMap, now));
  filesWritten++;

  // topics/
  for (const [tag, list] of tagMap) {
    fs.writeFileSync(path.join(topicsPath, `${slugify(tag)}.md`), renderTopic(tag, list));
    filesWritten++;
  }

  // sources/
  for (const [key, list] of sourceMap) {
    fs.writeFileSync(path.join(sourcesPath, sourceFilename(key)), renderSource(key, list));
    filesWritten++;
  }

  // Stage, commit, push
  const authorArgs = [
    "-c", `user.name=${cfg.commitAuthorName}`,
    "-c", `user.email=${cfg.commitAuthorEmail}`,
  ];

  git(["add", cfg.contextDir], cfg.workDir);

  const status = git(["status", "--porcelain", cfg.contextDir], cfg.workDir).trim();
  if (status.length === 0) {
    return { filesWritten, committed: false, pushed: false };
  }

  const commitMessage = `whatson: consolidation ${dateOnly(now)}`;
  git([...authorArgs, "commit", "-m", commitMessage], cfg.workDir);
  const commitSha = git(["rev-parse", "HEAD"], cfg.workDir).trim();

  let pushed = false;
  if (cfg.push) {
    git(["push"], cfg.workDir);
    pushed = true;
  }

  return {
    filesWritten,
    committed: true,
    pushed,
    commitSha,
    commitMessage,
  };
}
