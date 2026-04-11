import { describe, it, expect, beforeEach } from "vitest";
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
import { runConsolidation } from "./consolidation.js";

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
