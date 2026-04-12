import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { _setDbForTest, insertFact, type Fact } from "./storage.js";
import { syncToTargetRepo, getRepoSyncConfig } from "./repo-sync.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeFact(
  overrides: Partial<Omit<Fact, "id" | "created_at" | "updated_at">> = {}
): Omit<Fact, "id" | "created_at" | "updated_at"> {
  return {
    content: "Test fact",
    source: "test:unit",
    source_type: "fact",
    confidence: "medium",
    valid_from: new Date().toISOString(),
    valid_to: null,
    superseded_by: null,
    tags: [],
    raw_message: null,
    message_id: null,
    source_url: null,
    source_file: null,
    ...overrides,
  };
}

describe("repo-sync", () => {
  let tmpRoot: string;
  let bareRepo: string;
  let workDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    await _setDbForTest();

    // Create a scratch directory containing:
    //   bare/   — the "remote" (a bare repo with one initial commit)
    //   work/   — whatson's local checkout (does not exist yet)
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "whatson-reposync-"));
    bareRepo = path.join(tmpRoot, "bare.git");
    workDir = path.join(tmpRoot, "work");

    // Seed the bare repo: init a regular repo, commit, then clone --bare.
    const seed = path.join(tmpRoot, "seed");
    fs.mkdirSync(seed, { recursive: true });
    git(["init", "-q", "-b", "main"], seed);
    git(["-c", "user.name=Seed", "-c", "user.email=seed@test", "commit", "--allow-empty", "-q", "-m", "init"], seed);
    execFileSync("git", ["clone", "--bare", "-q", seed, bareRepo], { stdio: ["ignore", "pipe", "pipe"] });
    // The bare repo must allow pushes to the checked-out branch (it has none, being bare).

    // Capture + set env
    for (const k of [
      "TARGET_REPO",
      "WHATSON_CONTEXT_DIR",
      "WHATSON_TARGET_WORKDIR",
      "WHATSON_COMMIT_AUTHOR",
      "WHATSON_SYNC_PUSH",
      "GITHUB_TOKEN",
    ]) {
      savedEnv[k] = process.env[k];
    }
    process.env.TARGET_REPO = bareRepo;
    process.env.WHATSON_CONTEXT_DIR = "docs/context";
    process.env.WHATSON_TARGET_WORKDIR = workDir;
    process.env.WHATSON_COMMIT_AUTHOR = "Whatson Test <test@whatson.local>";
    process.env.WHATSON_SYNC_PUSH = "true";
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns skipped when TARGET_REPO is not set", async () => {
    delete process.env.TARGET_REPO;
    const result = await syncToTargetRepo();
    expect(result.skipped).toBeDefined();
    expect(result.committed).toBe(false);
  });

  it("parses commit author from env", () => {
    process.env.WHATSON_COMMIT_AUTHOR = "Alice <alice@example.com>";
    const cfg = getRepoSyncConfig();
    expect(cfg?.commitAuthorName).toBe("Alice");
    expect(cfg?.commitAuthorEmail).toBe("alice@example.com");
  });

  it("clones, writes INDEX + topics + sources, commits and pushes", async () => {
    await insertFact(makeFact({
      content: "Runtime is OpenClaw in Docker",
      source: "telegram:@denis",
      source_type: "decision",
      confidence: "high",
      tags: ["architecture", "runtime"],
      raw_message: "We decided to use OpenClaw in Docker",
    }));
    await insertFact(makeFact({
      content: "Database is PostgreSQL",
      source: "web:https://wiki.example.com/adr-012",
      source_url: "https://wiki.example.com/adr-012",
      source_type: "decision",
      confidence: "high",
      tags: ["architecture", "database"],
    }));
    await insertFact(makeFact({
      content: "API rate limit is 1000 req/min",
      source: "telegram:@denis",
      source_type: "fact",
      confidence: "high",
      tags: ["api"],
    }));

    const result = await syncToTargetRepo();

    expect(result.skipped).toBeUndefined();
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.filesWritten).toBeGreaterThan(0);
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);

    // Local checkout has the files
    const contextPath = path.join(workDir, "docs/context");
    expect(fs.existsSync(path.join(contextPath, "INDEX.md"))).toBe(true);
    expect(fs.existsSync(path.join(contextPath, "topics/architecture.md"))).toBe(true);
    expect(fs.existsSync(path.join(contextPath, "topics/database.md"))).toBe(true);
    expect(fs.existsSync(path.join(contextPath, "topics/runtime.md"))).toBe(true);
    expect(fs.existsSync(path.join(contextPath, "topics/api.md"))).toBe(true);

    const index = fs.readFileSync(path.join(contextPath, "INDEX.md"), "utf-8");
    expect(index).toContain("Runtime is OpenClaw in Docker");
    expect(index).toContain("Database is PostgreSQL");
    expect(index).toContain("[architecture](topics/architecture.md)");

    const archTopic = fs.readFileSync(path.join(contextPath, "topics/architecture.md"), "utf-8");
    expect(archTopic).toContain("Runtime is OpenClaw in Docker");
    expect(archTopic).toContain("Database is PostgreSQL");
    expect(archTopic).toContain("## Decisions");

    // sources/ should have at least one file per unique source key
    const sources = fs.readdirSync(path.join(contextPath, "sources"));
    expect(sources.length).toBeGreaterThanOrEqual(2);

    // Bare remote has the commit
    const log = git(["log", "--oneline", "main"], bareRepo);
    expect(log).toContain("whatson: consolidation");
  });

  it("is idempotent: second sync with no changes produces no commit", async () => {
    await insertFact(makeFact({ content: "Stable fact", tags: ["stable"] }));

    const first = await syncToTargetRepo();
    expect(first.committed).toBe(true);

    const second = await syncToTargetRepo();
    expect(second.committed).toBe(false);
    expect(second.pushed).toBe(false);
  });

  it("produces a new commit when facts change between syncs", async () => {
    await insertFact(makeFact({ content: "First fact", tags: ["topic-a"] }));
    const first = await syncToTargetRepo();
    expect(first.committed).toBe(true);
    const firstSha = first.commitSha;

    await insertFact(makeFact({ content: "Second fact added later", tags: ["topic-b"] }));
    const second = await syncToTargetRepo();
    expect(second.committed).toBe(true);
    expect(second.commitSha).not.toBe(firstSha);

    // New topic file exists after second sync
    const topicB = path.join(workDir, "docs/context/topics/topic-b.md");
    expect(fs.existsSync(topicB)).toBe(true);
  });

  it("respects WHATSON_SYNC_PUSH=false", async () => {
    process.env.WHATSON_SYNC_PUSH = "false";
    await insertFact(makeFact({ content: "Local only fact" }));
    const result = await syncToTargetRepo();
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false);
  });

  it("groups source files by (source, day) — same source on different days produces separate files", async () => {
    const db = await _setDbForTest();

    // Insert two facts from the same source but with different created_at days.
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO facts (content, source, source_type, confidence, valid_from, valid_to,
        created_at, updated_at, superseded_by, tags, raw_message, message_id, source_url, source_file)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, NULL, NULL, NULL, NULL)`,
      ["Fact from day 1", "telegram:@bob", "fact", "medium", "2026-04-10T12:00:00Z", "2026-04-10T12:00:00Z", "2026-04-10T12:00:00Z", "[]"]
    );
    db.run(
      `INSERT INTO facts (content, source, source_type, confidence, valid_from, valid_to,
        created_at, updated_at, superseded_by, tags, raw_message, message_id, source_url, source_file)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, NULL, NULL, NULL, NULL)`,
      ["Fact from day 2", "telegram:@bob", "fact", "medium", "2026-04-11T12:00:00Z", "2026-04-11T12:00:00Z", "2026-04-11T12:00:00Z", "[]"]
    );

    const result = await syncToTargetRepo();
    expect(result.committed).toBe(true);

    const sources = fs.readdirSync(path.join(workDir, "docs/context/sources"));
    // Same source, two different days → two source files
    const bobFiles = sources.filter((f: string) => f.includes("telegram-bob"));
    expect(bobFiles.length).toBe(2);
    expect(bobFiles.some((f: string) => f.startsWith("2026-04-10"))).toBe(true);
    expect(bobFiles.some((f: string) => f.startsWith("2026-04-11"))).toBe(true);
  });
});
