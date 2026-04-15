import { describe, it, expect } from "vitest";
import { verifyCitations, filterFacts } from "./render.js";
import type { Fact } from "./storage.js";

describe("verifyCitations", () => {
  const valid = new Set(["f:1", "f:2", "f:3"]);

  it("accepts a document where every content line has a valid cite", () => {
    const doc = [
      "# Project",
      "",
      "> metadata",
      "",
      "## Vision",
      "",
      "The project aims to do X. <!-- fact:f:1 -->",
      "",
      "## Objectives",
      "",
      "- Bullet goal one. <!-- fact:f:2 -->",
      "- Bullet goal two. <!-- fact:f:3 -->",
    ].join("\n");
    expect(verifyCitations(doc, valid)).toEqual([]);
  });

  it("flags a content line missing any citation", () => {
    const doc = "## Vision\n\nUnsourced claim here.\n";
    const v = verifyCitations(doc, valid);
    expect(v).toHaveLength(1);
    expect(v[0].reason).toBe("no citation");
  });

  it("flags unknown fact ids", () => {
    const doc = "## X\n\nBad cite. <!-- fact:f:999 -->\n";
    const v = verifyCitations(doc, valid);
    expect(v).toHaveLength(1);
    expect(v[0].reason).toContain("unknown fact id");
    expect(v[0].reason).toContain("f:999");
  });

  it("allows the no-facts sentinel without a citation", () => {
    const doc = "## Unresolved\n\n_No facts available._\n";
    expect(verifyCitations(doc, valid)).toEqual([]);
  });

  it("allows multiple cites on a single sentence", () => {
    const doc = "## X\n\nCombined claim. <!-- fact:f:1 --> <!-- fact:f:2 -->\n";
    expect(verifyCitations(doc, valid)).toEqual([]);
  });

  it("skips headings and blockquotes", () => {
    const doc = [
      "# Title",
      "## Sub",
      "### Nested",
      "> blockquote metadata line",
      "",
      "Real claim. <!-- fact:f:1 -->",
    ].join("\n");
    expect(verifyCitations(doc, valid)).toEqual([]);
  });

  it("reports line numbers of violations", () => {
    const doc = ["# Title", "", "Cited claim. <!-- fact:f:1 -->", "Uncited claim."].join("\n");
    const v = verifyCitations(doc, valid);
    expect(v).toHaveLength(1);
    expect(v[0].line).toBe(4);
  });

  it("flags even when the citation syntax is malformed (e.g. wrong prefix)", () => {
    const doc = "## X\n\nBad form. <!-- citation:1 -->\n";
    const v = verifyCitations(doc, valid);
    expect(v).toHaveLength(1);
    expect(v[0].reason).toBe("no citation");
  });
});

describe("filterFacts", () => {
  const mk = (
    id: number,
    tags: string[],
    type: Fact["source_type"] = "fact"
  ): Fact => ({
    id,
    content: "x",
    source: "s",
    source_type: type,
    confidence: "high",
    valid_from: "2026-04-14",
    valid_to: null,
    created_at: "2026-04-14",
    updated_at: "2026-04-14",
    superseded_by: null,
    tags,
    raw_message: null,
    message_id: null,
    source_url: null,
    source_file: null,
  });

  it("filters by any matching tag (OR semantics)", () => {
    const facts = [
      mk(1, ["overview"]),
      mk(2, ["other"]),
      mk(3, ["kpi", "other"]),
    ];
    const out = filterFacts(facts, { tags: ["overview", "kpi"] });
    expect(out.map((f) => f.id)).toEqual([1, 3]);
  });

  it("filters by sourceType when provided", () => {
    const facts = [
      mk(1, ["overview"], "decision"),
      mk(2, ["overview"], "fact"),
    ];
    const out = filterFacts(facts, {
      tags: ["overview"],
      sourceTypes: ["decision"],
    });
    expect(out.map((f) => f.id)).toEqual([1]);
  });

  it("returns all when no query constraints given", () => {
    const facts = [mk(1, ["a"]), mk(2, ["b"])];
    expect(filterFacts(facts, {})).toHaveLength(2);
  });
});
