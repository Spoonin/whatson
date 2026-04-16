import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildPackedFactPrompt,
  invokePackedSdk,
  _setClientForTest,
} from "./drift-pack.js";
import type { Fact } from "./storage.js";

function makeFact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: 42,
    content: "Use PostgreSQL 16",
    source: "telegram:@alice",
    source_type: "decision",
    confidence: "high",
    valid_from: "2026-04-10T10:00:00.000Z",
    valid_to: null,
    created_at: "2026-04-10T10:00:00.000Z",
    updated_at: "2026-04-10T10:00:00.000Z",
    superseded_by: null,
    tags: [],
    raw_message: null,
    message_id: null,
    source_url: null,
    source_file: null,
    ...overrides,
  };
}

describe("buildPackedFactPrompt", () => {
  it("includes fact id, content, source, and type but no search scaffolding", () => {
    const prompt = buildPackedFactPrompt(makeFact());
    expect(prompt).toContain("ID: 42");
    expect(prompt).toContain("Use PostgreSQL 16");
    expect(prompt).toContain("telegram:@alice");
    expect(prompt).toContain("decision");
    expect(prompt).toContain(`"fact_id": 42`);
    // Packed variant must not instruct a search loop — the repo is already in context.
    expect(prompt).not.toMatch(/Search the codebase/i);
  });
});

describe("invokePackedSdk", () => {
  // Capture every call into the mock so we can inspect params.
  interface Captured {
    model: string;
    system: unknown;
    messages: unknown[];
    max_tokens: number;
  }
  let captured: Captured | null;

  beforeEach(() => {
    captured = null;
    const mockClient = {
      messages: {
        create: async (params: Captured) => {
          captured = params;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  fact_id: 42,
                  consistent: false,
                  evidence: "no migration found in db/migrations",
                  question: "Has the PG16 upgrade landed?",
                }),
              },
            ],
          };
        },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setClientForTest(mockClient as any);
  });

  afterEach(() => {
    _setClientForTest(null);
  });

  it("puts the packed repo in system with cache_control: ephemeral", async () => {
    await invokePackedSdk({
      packedRepo: "<repo>fake packed content</repo>",
      fact: makeFact(),
    });

    expect(captured).not.toBeNull();
    expect(Array.isArray(captured!.system)).toBe(true);
    const systemBlocks = captured!.system as Array<{
      type: string;
      text: string;
      cache_control?: { type: string };
    }>;
    // Header block + packed block
    expect(systemBlocks).toHaveLength(2);
    // The packed block must carry the cache marker; the header need not.
    const packedBlock = systemBlocks[1];
    expect(packedBlock.text).toContain("fake packed content");
    expect(packedBlock.cache_control).toEqual({ type: "ephemeral" });
  });

  it("uses WHATSON_DRIFT_MODEL when set, defaults to sonnet otherwise", async () => {
    const prev = process.env.WHATSON_DRIFT_MODEL;
    try {
      delete process.env.WHATSON_DRIFT_MODEL;
      await invokePackedSdk({ packedRepo: "x", fact: makeFact() });
      expect(captured!.model).toBe("claude-sonnet-4-6");

      process.env.WHATSON_DRIFT_MODEL = "claude-opus-4-6";
      await invokePackedSdk({ packedRepo: "x", fact: makeFact() });
      expect(captured!.model).toBe("claude-opus-4-6");
    } finally {
      if (prev === undefined) delete process.env.WHATSON_DRIFT_MODEL;
      else process.env.WHATSON_DRIFT_MODEL = prev;
    }
  });

  it("parses the SDK response into a ClaudeFinding", async () => {
    const finding = await invokePackedSdk({
      packedRepo: "x",
      fact: makeFact(),
    });
    expect(finding.fact_id).toBe(42);
    expect(finding.consistent).toBe(false);
    expect(finding.evidence).toContain("no migration");
    expect(finding.question).toContain("PG16");
  });
});
