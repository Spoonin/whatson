import { describe, it, expect, beforeEach } from "vitest";
import { _setDbForTest, insertFact, getActiveFacts, getDriftFindings, getUnansweredQuestions, getCachedDriftFinding, upsertDriftCache, type Fact } from "./storage.js";
import { buildPerFactPrompt, parsePerFactOutput, hashFact } from "./drift.js";

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

describe("drift analysis", () => {
  beforeEach(async () => {
    await _setDbForTest();
  });

  describe("buildPerFactPrompt", () => {
    it("includes fact id, content, source, and date in a single-fact prompt", async () => {
      const id = await insertFact(makeFact({
        content: "Use PostgreSQL 16",
        source: "telegram:@alice",
        source_type: "decision",
        confidence: "high",
      }));

      const facts = await getActiveFacts();
      const fact = facts.find((f) => f.id === id)!;
      const prompt = buildPerFactPrompt(fact);

      expect(prompt).toContain(`ID: ${id}`);
      expect(prompt).toContain("Use PostgreSQL 16");
      expect(prompt).toContain("telegram:@alice");
      expect(prompt).toContain("decision");
      expect(prompt).toContain("codebase consistency auditor");
      // Prompt should instruct the model to return a single JSON object,
      // not an array of findings.
      expect(prompt).not.toContain("findings");
      expect(prompt).toContain(`"fact_id": ${id}`);
    });
  });

  describe("parsePerFactOutput", () => {
    it("parses a direct single-finding JSON object", () => {
      const raw = JSON.stringify({
        fact_id: 7,
        consistent: true,
        evidence: "found in config.ts:12",
        question: null,
      });
      const finding = parsePerFactOutput(raw, 7);
      expect(finding.fact_id).toBe(7);
      expect(finding.consistent).toBe(true);
      expect(finding.evidence).toBe("found in config.ts:12");
      expect(finding.question).toBeNull();
    });

    it("unwraps the --output-format json envelope", () => {
      const inner = JSON.stringify({
        fact_id: 3,
        consistent: false,
        evidence: "missing from codebase",
        question: "Is the rate limit implemented?",
      });
      const raw = JSON.stringify({ result: inner });
      const finding = parsePerFactOutput(raw, 3);
      expect(finding.consistent).toBe(false);
      expect(finding.question).toBe("Is the rate limit implemented?");
    });

    it("strips markdown fences", () => {
      const json = JSON.stringify({ fact_id: 1, consistent: true, evidence: "ok", question: null });
      const raw = "```json\n" + json + "\n```";
      const finding = parsePerFactOutput(raw, 1);
      expect(finding.consistent).toBe(true);
    });

    it("falls back to expectedFactId when fact_id is missing or wrong type", () => {
      const raw = JSON.stringify({ consistent: true, evidence: "ok", question: null });
      const finding = parsePerFactOutput(raw, 42);
      expect(finding.fact_id).toBe(42);
    });

    it("throws on malformed output", () => {
      expect(() => parsePerFactOutput("not json", 1)).toThrow();
    });

    it("throws when 'consistent' boolean is missing", () => {
      expect(() => parsePerFactOutput('{"fact_id": 1}', 1)).toThrow("consistent");
    });
  });

  describe("drift_findings CRUD", () => {
    it("stores and retrieves findings", async () => {
      const { insertDriftFinding } = await import("./storage.js");

      const factId = await insertFact(makeFact({
        content: "Use Redis for caching",
        source_type: "decision",
        confidence: "high",
      }));

      await insertDriftFinding({
        run_at: "2026-04-12T10:00:00Z",
        fact_id: factId,
        consistent: false,
        evidence: "No Redis config found in docker-compose.yml",
        question: "Is Redis caching implemented yet?",
      });
      await insertDriftFinding({
        run_at: "2026-04-12T10:00:00Z",
        fact_id: factId,
        consistent: true,
        evidence: "Found in package.json:12",
        question: null,
      });

      const findings = await getDriftFindings("2026-04-12T10:00:00Z");
      expect(findings).toHaveLength(2);
      expect(findings[0].consistent).toBe(false);
      expect(findings[0].question).toBe("Is Redis caching implemented yet?");
      expect(findings[1].consistent).toBe(true);
    });

    it("returns latest run when no runAt specified", async () => {
      const { insertDriftFinding } = await import("./storage.js");
      const factId = await insertFact(makeFact({ source_type: "decision", confidence: "high" }));

      await insertDriftFinding({
        run_at: "2026-04-11T10:00:00Z",
        fact_id: factId,
        consistent: true,
        evidence: "ok",
        question: null,
      });
      await insertDriftFinding({
        run_at: "2026-04-12T10:00:00Z",
        fact_id: factId,
        consistent: false,
        evidence: "drift",
        question: "why?",
      });

      const findings = await getDriftFindings();
      expect(findings).toHaveLength(1);
      expect(findings[0].run_at).toBe("2026-04-12T10:00:00Z");
    });

    it("caches findings by fact hash + repo sha and invalidates on sha change", async () => {
      const factId = await insertFact(makeFact({
        content: "Use Redis for caching",
        source_type: "decision",
        confidence: "high",
      }));
      const facts = await getActiveFacts();
      const fact = facts.find((f) => f.id === factId)!;
      const factHash = hashFact(fact);

      expect(await getCachedDriftFinding(factHash, "sha-a")).toBeNull();

      await upsertDriftCache(factHash, "sha-a", {
        consistent: false,
        evidence: "missing redis",
        question: "where is redis?",
      });

      const hit = await getCachedDriftFinding(factHash, "sha-a");
      expect(hit).not.toBeNull();
      expect(hit!.consistent).toBe(false);
      expect(hit!.evidence).toBe("missing redis");
      expect(hit!.question).toBe("where is redis?");

      // Different repo sha → cache miss (repo state changed).
      expect(await getCachedDriftFinding(factHash, "sha-b")).toBeNull();

      // Upsert overwrites for same key.
      await upsertDriftCache(factHash, "sha-a", {
        consistent: true,
        evidence: "found it",
        question: null,
      });
      const updated = await getCachedDriftFinding(factHash, "sha-a");
      expect(updated!.consistent).toBe(true);
      expect(updated!.question).toBeNull();
    });

    it("hashFact differs when content or source_type differs", async () => {
      const a = await insertFact(makeFact({ content: "X", source_type: "decision" }));
      const b = await insertFact(makeFact({ content: "Y", source_type: "decision" }));
      const c = await insertFact(makeFact({ content: "X", source_type: "fact" }));
      const facts = await getActiveFacts();
      const fa = facts.find((f) => f.id === a)!;
      const fb = facts.find((f) => f.id === b)!;
      const fc = facts.find((f) => f.id === c)!;
      expect(hashFact(fa)).not.toBe(hashFact(fb));
      expect(hashFact(fa)).not.toBe(hashFact(fc));
    });

    it("deduplicates findings for same fact and verdict", async () => {
      const { insertDriftFinding } = await import("./storage.js");
      const factId = await insertFact(makeFact({ source_type: "decision", confidence: "high" }));

      const id1 = await insertDriftFinding({
        run_at: "2026-04-12T10:00:00Z",
        fact_id: factId,
        consistent: false,
        evidence: "missing from codebase",
        question: "Is it implemented?",
      });
      // Same fact, same verdict → should return existing id, not create new row
      const id2 = await insertDriftFinding({
        run_at: "2026-04-13T10:00:00Z",
        fact_id: factId,
        consistent: false,
        evidence: "still missing",
        question: "Is it implemented now?",
      });
      expect(id2).toBe(id1);

      const questions = await getUnansweredQuestions();
      expect(questions).toHaveLength(1);

      // Different verdict → should create new row
      const id3 = await insertDriftFinding({
        run_at: "2026-04-13T10:00:00Z",
        fact_id: factId,
        consistent: true,
        evidence: "found it",
        question: null,
      });
      expect(id3).not.toBe(id1);
    });

    it("returns unanswered questions", async () => {
      const { insertDriftFinding } = await import("./storage.js");
      const factId = await insertFact(makeFact({ source_type: "decision", confidence: "high" }));

      await insertDriftFinding({
        run_at: "2026-04-12T10:00:00Z",
        fact_id: factId,
        consistent: false,
        evidence: "missing",
        question: "Where is the config?",
      });
      await insertDriftFinding({
        run_at: "2026-04-12T10:00:00Z",
        fact_id: factId,
        consistent: true,
        evidence: "found",
        question: null,
      });

      const questions = await getUnansweredQuestions();
      expect(questions).toHaveLength(1);
      expect(questions[0].question).toBe("Where is the config?");
    });
  });
});
