import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  _setDbForTest,
  insertFact,
  getActiveFacts,
  getFact,
  expireFact,
  getFactCount,
  getLastConsolidation,
  type Fact,
} from "./storage.js";
import {
  runConsolidation,
  normalize,
  contentOverlaps,
  parseConsolidationResponse,
  clusterFacts,
  kickOffConsolidation,
  getConsolidationRunState,
  _resetRunStateForTest,
  _setClientForTest,
} from "./consolidation.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeFact(
  overrides: Partial<Omit<Fact, "id" | "created_at" | "updated_at">> = {}
): Omit<Fact, "id" | "created_at" | "updated_at"> {
  return {
    content: "Test fact content that is meaningful",
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

// ── Storage CRUD ────────────────────────────────────────────────────────────

describe("storage", () => {
  beforeEach(async () => {
    await _setDbForTest();
  });

  it("inserts and retrieves a fact", async () => {
    const id = await insertFact(makeFact({ content: "OpenClaw runs in Docker" }));
    const fact = await getFact(id);
    expect(fact).not.toBeNull();
    expect(fact!.content).toBe("OpenClaw runs in Docker");
    expect(fact!.source_type).toBe("fact");
  });

  it("assigns auto-incrementing ids", async () => {
    const id1 = await insertFact(makeFact({ content: "Fact one" }));
    const id2 = await insertFact(makeFact({ content: "Fact two" }));
    expect(id2).toBe(id1 + 1);
  });

  it("getActiveFacts excludes expired facts", async () => {
    const id1 = await insertFact(makeFact({ content: "Active fact" }));
    const id2 = await insertFact(makeFact({ content: "Will expire" }));
    await expireFact(id2);

    const active = await getActiveFacts();
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(id1);
  });

  it("expireFact sets valid_to and superseded_by", async () => {
    const id1 = await insertFact(makeFact({ content: "Old fact" }));
    const id2 = await insertFact(makeFact({ content: "New fact" }));
    await expireFact(id1, id2);

    const expired = await getFact(id1);
    expect(expired!.valid_to).not.toBeNull();
    expect(expired!.superseded_by).toBe(id2);
  });

  it("getFactCount returns correct active/expired counts", async () => {
    await insertFact(makeFact());
    await insertFact(makeFact());
    const id3 = await insertFact(makeFact());
    await expireFact(id3);

    const counts = await getFactCount();
    expect(counts.active).toBe(2);
    expect(counts.expired).toBe(1);
  });

  it("serializes and deserializes tags as JSON", async () => {
    const id = await insertFact(
      makeFact({ content: "Tagged", tags: ["architecture", "docker"] })
    );
    const fact = await getFact(id);
    expect(fact!.tags).toEqual(["architecture", "docker"]);
  });
});

// ── Consolidation ───────────────────────────────────────────────────────────

describe("consolidation", () => {
  beforeEach(async () => {
    await _setDbForTest();
  });

  it("merges exact duplicate facts", async () => {
    await insertFact(makeFact({ content: "We use Docker for deployment", source_type: "fact" }));
    // Small delay so created_at differs — otherwise both are "equally new"
    await insertFact(makeFact({ content: "We use Docker for deployment", source_type: "fact" }));

    const summary = await runConsolidation();
    expect(summary.factsMerged).toBeGreaterThanOrEqual(1);

    const active = await getActiveFacts();
    expect(active).toHaveLength(1);
  });

  it("merges duplicates ignoring whitespace differences", async () => {
    await insertFact(makeFact({ content: "Runtime is  OpenClaw", source_type: "decision" }));
    await insertFact(makeFact({ content: "runtime is openclaw", source_type: "decision" }));

    const summary = await runConsolidation();
    expect(summary.factsMerged).toBeGreaterThanOrEqual(1);
  });

  it("does NOT merge facts with different source_type", async () => {
    await insertFact(makeFact({ content: "We use Docker", source_type: "fact" }));
    await insertFact(makeFact({ content: "We use Docker", source_type: "decision" }));

    const summary = await runConsolidation();
    expect(summary.factsMerged).toBe(0);

    const active = await getActiveFacts();
    expect(active).toHaveLength(2);
  });

  it("detects contradiction when correction overlaps with existing fact", async () => {
    await insertFact(
      makeFact({
        content: "Database is ChromaDB for vector storage",
        source_type: "fact",
      })
    );
    await insertFact(
      makeFact({
        content: "Actually, database should be LanceDB for vector storage",
        source_type: "correction",
      })
    );

    const summary = await runConsolidation();
    expect(summary.contradictionsFound).toBeGreaterThanOrEqual(1);

    // The original fact should be expired, correction stays active
    const active = await getActiveFacts();
    expect(active).toHaveLength(1);
    expect(active[0]!.source_type).toBe("correction");
  });

  it("does NOT flag contradiction when correction has no word overlap", async () => {
    await insertFact(makeFact({ content: "Server port is 3000", source_type: "fact" }));
    await insertFact(
      makeFact({
        content: "Actually the deadline is next Friday",
        source_type: "correction",
      })
    );

    const summary = await runConsolidation();
    expect(summary.contradictionsFound).toBe(0);
    expect(await getActiveFacts()).toHaveLength(2);
  });

  it("prunes stale low-confidence facts", async () => {
    const staleDate = new Date(Date.now() - 31 * 86400 * 1000).toISOString();
    await insertFact(
      makeFact({
        content: "Maybe we should consider Kubernetes later",
        confidence: "low",
        valid_from: staleDate,
      })
    );
    await insertFact(
      makeFact({
        content: "We decided to use Docker",
        confidence: "high",
        valid_from: staleDate,
      })
    );

    const summary = await runConsolidation();
    expect(summary.factsInvalidated).toBe(1);

    // High-confidence stale fact survives
    const active = await getActiveFacts();
    expect(active).toHaveLength(1);
    expect(active[0]!.confidence).toBe("high");
  });

  it("returns indexUpdated: true", async () => {
    await insertFact(makeFact());
    const summary = await runConsolidation();
    expect(summary.indexUpdated).toBe(true);
  });

  it("handles empty database without errors", async () => {
    const summary = await runConsolidation();
    expect(summary.factsProcessed).toBe(0);
    expect(summary.factsMerged).toBe(0);
    expect(summary.contradictionsFound).toBe(0);
    expect(summary.indexUpdated).toBe(true);
  });

  it("logs consolidation phases", async () => {
    await insertFact(makeFact());
    await runConsolidation();

    const lastRun = await getLastConsolidation();
    expect(lastRun).not.toBeNull();
  });
});

// ── Sync gating ─────────────────────────────────────────────────────────────

describe("consolidation sync gating", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    await _setDbForTest();
    for (const k of ["WHATSON_SYNC_EVERY_N_CONSOLIDATION", "TARGET_REPO"]) {
      saved[k] = process.env[k];
    }
    // No TARGET_REPO set → syncToTargetRepo() returns { skipped: "TARGET_REPO not configured" }
    // That's fine for these tests — we only care about the N-gate deciding whether to call it at all.
    delete process.env.TARGET_REPO;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("N=0 disables auto-sync (skipped with disabled reason)", async () => {
    process.env.WHATSON_SYNC_EVERY_N_CONSOLIDATION = "0";
    await insertFact(makeFact());
    const summary = await runConsolidation();
    expect(summary.repoSync).toBeDefined();
    expect((summary.repoSync as { skipped: string }).skipped).toMatch(/disabled/);
  });

  it("N=1 attempts sync on every run (gate passes)", async () => {
    process.env.WHATSON_SYNC_EVERY_N_CONSOLIDATION = "1";
    await insertFact(makeFact());
    const summary = await runConsolidation();
    // Gate passed → syncToTargetRepo() was called → skipped because TARGET_REPO unset
    expect(summary.repoSync).toBeDefined();
    expect((summary.repoSync as { skipped: string }).skipped).toBe("TARGET_REPO not configured");
  });

  it("N=3 syncs only on runs 3, 6, 9…", async () => {
    process.env.WHATSON_SYNC_EVERY_N_CONSOLIDATION = "3";

    const skippedReasons: string[] = [];
    for (let i = 1; i <= 4; i++) {
      await insertFact(makeFact({ content: `fact ${i}` }));
      const summary = await runConsolidation();
      const rs = summary.repoSync as { skipped: string };
      skippedReasons.push(rs.skipped);
    }

    // Run 1: skip (1 % 3 !== 0)
    expect(skippedReasons[0]).toMatch(/run 1 not a multiple of 3/);
    // Run 2: skip (2 % 3 !== 0)
    expect(skippedReasons[1]).toMatch(/run 2 not a multiple of 3/);
    // Run 3: gate passes → attempted → skipped because TARGET_REPO unset
    expect(skippedReasons[2]).toBe("TARGET_REPO not configured");
    // Run 4: skip (4 % 3 !== 0)
    expect(skippedReasons[3]).toMatch(/run 4 not a multiple of 3/);
  });

  it("defaults to N=1 when env var unset", async () => {
    delete process.env.WHATSON_SYNC_EVERY_N_CONSOLIDATION;
    await insertFact(makeFact());
    const summary = await runConsolidation();
    expect((summary.repoSync as { skipped: string }).skipped).toBe("TARGET_REPO not configured");
  });

  it("defaults to N=1 when env var is garbage", async () => {
    process.env.WHATSON_SYNC_EVERY_N_CONSOLIDATION = "banana";
    await insertFact(makeFact());
    const summary = await runConsolidation();
    expect((summary.repoSync as { skipped: string }).skipped).toBe("TARGET_REPO not configured");
  });
});

// ── parseConsolidationResponse ─────────────────────────────────────────────

describe("parseConsolidationResponse", () => {
  const validIds = new Set([1, 2, 3, 5, 8, 14]);

  it("parses a valid merge action", () => {
    const json = JSON.stringify([
      { action: "merge", keep: 5, expire: [3], reason: "Same fact" },
    ]);
    const actions = parseConsolidationResponse(json, validIds);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ action: "merge", keep: 5, expire: [3] });
  });

  it("parses a valid contradict action", () => {
    const json = JSON.stringify([
      { action: "contradict", keep: 2, expire: [1], reason: "Correction" },
    ]);
    const actions = parseConsolidationResponse(json, validIds);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ action: "contradict", keep: 2, expire: [1] });
  });

  it("parses a valid relate action", () => {
    const json = JSON.stringify([
      { action: "relate", ids: [5, 14], relation: "supports", reason: "Both about DB" },
    ]);
    const actions = parseConsolidationResponse(json, validIds);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ action: "relate", ids: [5, 14], relation: "supports" });
  });

  it("silently skips keep actions (no-ops)", () => {
    const json = JSON.stringify([
      { action: "keep", id: 3 },
    ]);
    const actions = parseConsolidationResponse(json, validIds);
    expect(actions).toHaveLength(0);
  });

  it("rejects actions with unknown fact IDs", () => {
    const json = JSON.stringify([
      { action: "merge", keep: 5, expire: [999], reason: "Hallucinated ID" },
    ]);
    const actions = parseConsolidationResponse(json, validIds);
    expect(actions).toHaveLength(0);
  });

  it("rejects merge where keep === expire", () => {
    const json = JSON.stringify([
      { action: "merge", keep: 5, expire: [5], reason: "Self-merge" },
    ]);
    const actions = parseConsolidationResponse(json, validIds);
    expect(actions).toHaveLength(0);
  });

  it("rejects actions with invalid action type", () => {
    const json = JSON.stringify([
      { action: "delete", id: 3 },
    ]);
    const actions = parseConsolidationResponse(json, validIds);
    expect(actions).toHaveLength(0);
  });

  it("extracts JSON from markdown code fences", () => {
    const text = '```json\n[{"action":"merge","keep":5,"expire":[3],"reason":"dup"}]\n```';
    const actions = parseConsolidationResponse(text, validIds);
    expect(actions).toHaveLength(1);
  });

  it("returns empty for completely invalid input", () => {
    expect(parseConsolidationResponse("not json at all", validIds)).toEqual([]);
    expect(parseConsolidationResponse("", validIds)).toEqual([]);
    expect(parseConsolidationResponse("{}", validIds)).toEqual([]);
  });

  it("preserves valid actions when mixed with invalid", () => {
    const json = JSON.stringify([
      { action: "merge", keep: 5, expire: [3], reason: "Valid" },
      { action: "merge", keep: 999, expire: [1], reason: "Bad ID" },
      { action: "relate", ids: [1, 2], relation: "supports", reason: "Valid" },
    ]);
    const actions = parseConsolidationResponse(json, validIds);
    expect(actions).toHaveLength(2);
    expect(actions[0].action).toBe("merge");
    expect(actions[1].action).toBe("relate");
  });

  it("defaults to 'related' for unknown relation types", () => {
    const json = JSON.stringify([
      { action: "relate", ids: [1, 2], relation: "similar_to" },
    ]);
    const actions = parseConsolidationResponse(json, validIds);
    expect(actions).toHaveLength(1);
    expect(actions[0].relation).toBe("related");
  });
});

// ── clusterFacts ───────────────────────────────────────────────────────────

describe("clusterFacts", () => {
  beforeEach(async () => {
    await _setDbForTest();
  });

  it("groups facts that share keywords via FTS5", async () => {
    const id1 = await insertFact(makeFact({ content: "We decided to use PostgreSQL for the database" }));
    const id2 = await insertFact(makeFact({ content: "Database choice: PostgreSQL is confirmed" }));
    const id3 = await insertFact(makeFact({ content: "Telegram bot is running on port 443" }));

    const allFacts = await getActiveFacts();
    const newFacts = allFacts.filter((f) => f.id === id1);
    const processed = new Set<number>();

    const clusters = await clusterFacts(newFacts, allFacts, processed);
    expect(clusters.length).toBeGreaterThanOrEqual(1);

    // The PostgreSQL cluster should contain id1 and id2 but not id3
    const pgCluster = clusters.find((c) => c.some((f) => f.id === id1));
    expect(pgCluster).toBeDefined();
    expect(pgCluster!.some((f) => f.id === id2)).toBe(true);
    expect(pgCluster!.some((f) => f.id === id3)).toBe(false);
  });

  it("supplements with tag overlap", async () => {
    const id1 = await insertFact(makeFact({
      content: "Runtime is Docker",
      tags: ["infrastructure"],
    }));
    const id2 = await insertFact(makeFact({
      content: "Kubernetes will be used for orchestration",
      tags: ["infrastructure"],
    }));

    const allFacts = await getActiveFacts();
    const newFacts = allFacts.filter((f) => f.id === id1);
    const processed = new Set<number>();

    const clusters = await clusterFacts(newFacts, allFacts, processed);
    const cluster = clusters.find((c) => c.some((f) => f.id === id1));
    expect(cluster).toBeDefined();
    expect(cluster!.some((f) => f.id === id2)).toBe(true);
  });

  it("skips already-processed facts", async () => {
    const id1 = await insertFact(makeFact({ content: "PostgreSQL is the database" }));
    const id2 = await insertFact(makeFact({ content: "PostgreSQL confirmed as database" }));

    const allFacts = await getActiveFacts();
    const processed = new Set<number>([id1]);

    const clusters = await clusterFacts(allFacts, allFacts, processed);
    // id1 is processed → should not be a seed for a cluster
    const hasId1AsSeed = clusters.some((c) => c[0]?.id === id1 && c.length === 1);
    expect(hasId1AsSeed).toBe(false);
  });

  it("returns empty for single-fact clusters", async () => {
    await insertFact(makeFact({ content: "Very unique standalone fact about quantum computing" }));

    const allFacts = await getActiveFacts();
    const processed = new Set<number>();

    const clusters = await clusterFacts(allFacts, allFacts, processed);
    // Single fact with no FTS5 or tag matches → no cluster (need at least 2)
    expect(clusters.every((c) => c.length >= 2)).toBe(true);
  });
});

// ── LLM consolidation (mocked client) ──────────────────────────────────────

describe("LLM consolidation", () => {
  beforeEach(async () => {
    await _setDbForTest();
  });

  afterEach(() => {
    _setClientForTest(null);
  });

  it("merges semantic duplicates via LLM", async () => {
    // Mock Anthropic client that returns a merge action
    const mockClient = {
      messages: {
        create: async (_params: unknown) => ({
          content: [{
            type: "text" as const,
            text: JSON.stringify([]),
          }],
        }),
      },
    };

    const id1 = await insertFact(makeFact({
      content: "We decided to use PostgreSQL for the database",
      source_type: "decision",
    }));
    const id2 = await insertFact(makeFact({
      content: "Database choice: PostgreSQL is confirmed",
      source_type: "decision",
    }));

    // Set up mock that returns merge action for these IDs
    mockClient.messages.create = async (params: unknown) => {
      const p = params as { messages: { content: string }[] };
      const text = p.messages[0].content;
      // Extract the IDs from the prompt to return correct merge action
      const idMatches = [...text.matchAll(/ID:(\d+)/g)].map((m) => Number(m[1]));
      if (idMatches.length >= 2) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify([
              { action: "merge", keep: idMatches[1], expire: [idMatches[0]], reason: "Same PostgreSQL decision" },
            ]),
          }],
        };
      }
      return { content: [{ type: "text" as const, text: "[]" }] };
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setClientForTest(mockClient as any);

    const summary = await runConsolidation();
    expect(summary.factsMerged).toBeGreaterThanOrEqual(1);

    const active = await getActiveFacts();
    expect(active).toHaveLength(1);
  });

  it("falls back to heuristic when no API key", async () => {
    _setClientForTest(null);

    // Exact duplicates should still be caught by heuristic fallback
    await insertFact(makeFact({ content: "We use Docker", source_type: "fact" }));
    await insertFact(makeFact({ content: "We use Docker", source_type: "fact" }));

    const summary = await runConsolidation();
    expect(summary.factsMerged).toBeGreaterThanOrEqual(1);
  });

  it("falls back to heuristic when LLM call fails", async () => {
    const failClient = {
      messages: {
        create: async () => { throw new Error("API down"); },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setClientForTest(failClient as any);

    // Exact duplicates caught by heuristic fallback
    await insertFact(makeFact({ content: "Docker is the runtime", source_type: "fact" }));
    await insertFact(makeFact({ content: "Docker is the runtime", source_type: "fact" }));

    const summary = await runConsolidation();
    expect(summary.factsMerged).toBeGreaterThanOrEqual(1);
  });

  it("detects contradiction via LLM", async () => {
    const id1 = await insertFact(makeFact({
      content: "We use Redis for caching",
      source_type: "fact",
    }));
    const id2 = await insertFact(makeFact({
      content: "Memcached is our caching layer",
      source_type: "fact",
    }));

    const mockClient = {
      messages: {
        create: async (params: unknown) => {
          const p = params as { messages: { content: string }[] };
          const text = p.messages[0].content;
          const idMatches = [...text.matchAll(/ID:(\d+)/g)].map((m) => Number(m[1]));
          if (idMatches.length >= 2) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify([
                  { action: "contradict", keep: idMatches[1], expire: [idMatches[0]], reason: "Conflicting caching choice" },
                ]),
              }],
            };
          }
          return { content: [{ type: "text" as const, text: "[]" }] };
        },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setClientForTest(mockClient as any);

    const summary = await runConsolidation();
    expect(summary.contradictionsFound).toBeGreaterThanOrEqual(1);

    const active = await getActiveFacts();
    expect(active).toHaveLength(1);
  });
});

// ── kickOffConsolidation ────────────────────────────────────────────────────

describe("kickOffConsolidation (detached)", () => {
  beforeEach(() => {
    _resetRunStateForTest();
  });

  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("returns started=true on first call and transitions state idle → running → succeeded", async () => {
    expect(getConsolidationRunState().status).toBe("idle");

    const d = deferred<{ report: string }>();
    const kickoff = kickOffConsolidation(() => d.promise);
    expect(kickoff.started).toBe(true);
    expect(kickoff.runAt).toBeTruthy();
    expect(getConsolidationRunState().status).toBe("running");

    d.resolve({ report: "test report body" });
    // Let the .then microtask drain
    await new Promise((r) => setTimeout(r, 10));

    const final = getConsolidationRunState();
    expect(final.status).toBe("succeeded");
    expect(final.error).toBeNull();
    expect(final.finishedAt).toBeTruthy();
  });

  it("returns started=false with reason when a run is already in flight", async () => {
    const d = deferred<{ report: string }>();
    const first = kickOffConsolidation(() => d.promise);
    expect(first.started).toBe(true);

    const second = kickOffConsolidation(async () => ({ report: "should not run" }));
    expect(second.started).toBe(false);
    expect(second.reason).toMatch(/already running/);
    expect(second.runAt).toBe(first.runAt);

    // Clean up the in-flight run
    d.resolve({ report: "done" });
    await new Promise((r) => setTimeout(r, 10));
  });

  it("transitions state to failed when the worker throws", async () => {
    const d = deferred<{ report: string }>();
    kickOffConsolidation(() => d.promise);

    d.reject(new Error("boom"));
    await new Promise((r) => setTimeout(r, 10));

    const final = getConsolidationRunState();
    expect(final.status).toBe("failed");
    expect(final.error).toBe("boom");
  });

  it("allows a fresh run after the previous one finished", async () => {
    const d1 = deferred<{ report: string }>();
    kickOffConsolidation(() => d1.promise);
    d1.resolve({ report: "r1" });
    await new Promise((r) => setTimeout(r, 10));
    expect(getConsolidationRunState().status).toBe("succeeded");

    const d2 = deferred<{ report: string }>();
    const second = kickOffConsolidation(() => d2.promise);
    expect(second.started).toBe(true);
    d2.resolve({ report: "r2" });
    await new Promise((r) => setTimeout(r, 10));
    expect(getConsolidationRunState().status).toBe("succeeded");
  });
});
