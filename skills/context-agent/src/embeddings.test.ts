import { describe, it, expect, beforeEach } from "vitest";
import {
  _setDbForTest,
  insertFact,
  insertFactEmbedding,
  searchFactsByVector,
  deleteFactEmbedding,
  getFactsWithoutEmbeddings,
  hasVecSupport,
  type Fact,
} from "./storage.js";
import { normalizeVector } from "./embeddings.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeFact(
  overrides: Partial<Omit<Fact, "id" | "created_at" | "updated_at">> = {}
): Omit<Fact, "id" | "created_at" | "updated_at"> {
  return {
    content: "Test fact",
    source: "test:unit",
    source_type: "fact",
    confidence: "medium",
    valid_from: "2026-01-01T00:00:00Z",
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

/** Create a random-ish unit vector of given dimension. */
function randomVec(dims: number, seed: number): Float32Array {
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    v[i] = Math.sin(seed * (i + 1) * 0.1) + Math.cos(seed * (i + 2) * 0.3);
  }
  return normalizeVector(v);
}

// ── normalizeVector ─────────────────────────────────────────────────────────

describe("normalizeVector", () => {
  it("returns a unit vector", () => {
    const v = new Float32Array([3, 4, 0]);
    const n = normalizeVector(v);
    const magnitude = Math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2);
    expect(magnitude).toBeCloseTo(1.0, 5);
    expect(n[0]).toBeCloseTo(0.6, 5);
    expect(n[1]).toBeCloseTo(0.8, 5);
  });

  it("handles zero vector", () => {
    const v = new Float32Array([0, 0, 0]);
    const n = normalizeVector(v);
    expect(n[0]).toBe(0);
    expect(n[1]).toBe(0);
  });

  it("preserves 512-dimensional input length", () => {
    const v = randomVec(512, 42);
    expect(v.length).toBe(512);
    const magnitude = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
    expect(magnitude).toBeCloseTo(1.0, 4);
  });
});

// ── vec0 storage functions ──────────────────────────────────────────────────

describe("vec0 storage", () => {
  beforeEach(async () => {
    await _setDbForTest();
  });

  it("has sqlite-vec loaded", () => {
    expect(hasVecSupport()).toBe(true);
  });

  it("insert + KNN search round-trip", async () => {
    const id1 = await insertFact(makeFact({ content: "PostgreSQL chosen for primary DB" }));
    const id2 = await insertFact(makeFact({ content: "Redis for caching layer" }));
    const id3 = await insertFact(makeFact({ content: "MongoDB considered but rejected" }));

    const vec1 = randomVec(512, 1);
    const vec2 = randomVec(512, 2);
    const vec3 = randomVec(512, 3);

    await insertFactEmbedding(id1, vec1);
    await insertFactEmbedding(id2, vec2);
    await insertFactEmbedding(id3, vec3);

    // Search near vec1 — should return id1 first (distance 0)
    const results = await searchFactsByVector(vec1, 3);
    expect(results.length).toBe(3);
    expect(results[0].factId).toBe(id1);
    expect(results[0].distance).toBeCloseTo(0, 3);
  });

  it("delete removes the embedding", async () => {
    const id = await insertFact(makeFact({ content: "Will be deleted" }));
    await insertFactEmbedding(id, randomVec(512, 10));

    let results = await searchFactsByVector(randomVec(512, 10), 5);
    expect(results.some((r) => r.factId === id)).toBe(true);

    await deleteFactEmbedding(id);

    results = await searchFactsByVector(randomVec(512, 10), 5);
    expect(results.some((r) => r.factId === id)).toBe(false);
  });

  it("getFactsWithoutEmbeddings finds un-embedded facts", async () => {
    const id1 = await insertFact(makeFact({ content: "Embedded fact" }));
    const id2 = await insertFact(makeFact({ content: "Not embedded fact" }));
    await insertFactEmbedding(id1, randomVec(512, 20));

    const missing = await getFactsWithoutEmbeddings();
    expect(missing).toContain(id2);
    expect(missing).not.toContain(id1);
  });

  it("upsert replaces existing embedding", async () => {
    const id = await insertFact(makeFact({ content: "Updated embedding" }));
    const vec1 = randomVec(512, 30);
    const vec2 = randomVec(512, 31);

    await insertFactEmbedding(id, vec1);
    await insertFactEmbedding(id, vec2);

    // Should find it near vec2, not vec1
    const results = await searchFactsByVector(vec2, 1);
    expect(results[0].factId).toBe(id);
    expect(results[0].distance).toBeCloseTo(0, 3);
  });
});
