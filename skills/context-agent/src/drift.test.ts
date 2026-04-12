import { describe, it, expect, beforeEach, vi } from "vitest";
import { _setDbForTest, insertFact, getDriftFindings, getUnansweredQuestions, type Fact } from "./storage.js";
import { buildAnalysisPrompt, parseClaudeOutput } from "./drift.js";

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

  describe("buildAnalysisPrompt", () => {
    it("includes all facts with IDs in the prompt", async () => {
      const id1 = await insertFact(makeFact({
        content: "Use PostgreSQL 16",
        source_type: "decision",
        confidence: "high",
      }));
      const id2 = await insertFact(makeFact({
        content: "API rate limit is 1000 req/min",
        source_type: "fact",
        confidence: "high",
      }));

      const { getActiveFacts } = await import("./storage.js");
      const facts = await getActiveFacts();
      const prompt = buildAnalysisPrompt(facts);

      expect(prompt).toContain(`ID=${id1}`);
      expect(prompt).toContain(`ID=${id2}`);
      expect(prompt).toContain("Use PostgreSQL 16");
      expect(prompt).toContain("API rate limit is 1000 req/min");
      expect(prompt).toContain("codebase consistency auditor");
    });

    it("includes source and date for each fact", async () => {
      await insertFact(makeFact({
        content: "Deploy to AWS",
        source: "telegram:@alice",
        source_type: "decision",
      }));

      const { getActiveFacts } = await import("./storage.js");
      const facts = await getActiveFacts();
      const prompt = buildAnalysisPrompt(facts);

      expect(prompt).toContain("telegram:@alice");
      expect(prompt).toContain("decision");
    });
  });

  describe("parseClaudeOutput", () => {
    it("parses direct JSON findings", () => {
      const raw = JSON.stringify({
        findings: [
          { fact_id: 1, consistent: true, evidence: "found in config.ts:12", question: null },
          { fact_id: 2, consistent: false, evidence: "missing from codebase", question: "Is the rate limit implemented?" },
        ],
      });
      const findings = parseClaudeOutput(raw);
      expect(findings).toHaveLength(2);
      expect(findings[0].consistent).toBe(true);
      expect(findings[1].consistent).toBe(false);
      expect(findings[1].question).toBe("Is the rate limit implemented?");
    });

    it("parses Claude --output-format json wrapper", () => {
      const inner = JSON.stringify({
        findings: [
          { fact_id: 1, consistent: true, evidence: "ok", question: null },
        ],
      });
      const raw = JSON.stringify({ result: inner });
      const findings = parseClaudeOutput(raw);
      expect(findings).toHaveLength(1);
      expect(findings[0].fact_id).toBe(1);
    });

    it("strips markdown fences from model output", () => {
      const json = JSON.stringify({
        findings: [{ fact_id: 1, consistent: true, evidence: "ok", question: null }],
      });
      const raw = "```json\n" + json + "\n```";
      const findings = parseClaudeOutput(raw);
      expect(findings).toHaveLength(1);
    });

    it("throws on malformed output", () => {
      expect(() => parseClaudeOutput("not json")).toThrow();
    });

    it("throws when findings array is missing", () => {
      expect(() => parseClaudeOutput('{"result": "no findings here"}')).toThrow("findings");
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
