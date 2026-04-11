import { describe, it, expect } from "vitest";
import { extractEntries } from "./wal.js";

const SRC = "telegram:@denis";
const TS = "2026-04-11T14:30:00.000Z";

describe("extractEntries", () => {
  // ── Decisions ─────────────────────────────────────────────────────────────

  it("detects 'decided' keyword", () => {
    const entries = extractEntries("We decided to use Docker", SRC, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe("decision");
  });

  it("detects 'we will' keyword", () => {
    const entries = extractEntries("We will deploy on Friday", SRC, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe("decision");
  });

  it("detects 'chose' keyword", () => {
    const entries = extractEntries("Team chose PostgreSQL over MySQL", SRC, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe("decision");
  });

  it("detects 'rejected' keyword", () => {
    const entries = extractEntries("We rejected the microservices approach", SRC, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe("decision");
  });

  // ── Corrections ───────────────────────────────────────────────────────────

  it("detects 'actually' correction", () => {
    const entries = extractEntries("Actually, the deadline is May, not April", SRC, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe("correction");
  });

  it("detects 'instead of' correction", () => {
    const entries = extractEntries("We use LanceDB instead of ChromaDB", SRC, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe("correction");
  });

  it("detects 'not true' correction", () => {
    const entries = extractEntries("That is not true, the API limit is 1000", SRC, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe("correction");
  });

  // ── Questions ─────────────────────────────────────────────────────────────

  it("detects question mark", () => {
    const entries = extractEntries("What runtime should we use?", SRC, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe("question");
  });

  it("detects 'need to clarify'", () => {
    const entries = extractEntries("Need to clarify the deployment strategy", SRC, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe("question");
  });

  // ── Facts (fallback for long lines) ───────────────────────────────────────

  it("classifies long lines without keywords as facts", () => {
    const entries = extractEntries("The server runs on port 18789 in production", SRC, TS);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe("fact");
  });

  // ── Short / empty lines ───────────────────────────────────────────────────

  it("ignores short lines (≤20 chars) without keywords", () => {
    const entries = extractEntries("Hello world", SRC, TS);
    expect(entries).toHaveLength(0);
  });

  it("returns empty for empty input", () => {
    const entries = extractEntries("", SRC, TS);
    expect(entries).toHaveLength(0);
  });

  it("ignores blank lines", () => {
    const entries = extractEntries("\n\n  \n", SRC, TS);
    expect(entries).toHaveLength(0);
  });

  // ── Priority: correction > decision ───────────────────────────────────────

  it("correction keyword wins over decision keyword", () => {
    // "actually" + "decided" in the same line — correction regex checked first
    const entries = extractEntries(
      "Actually, we decided to change the approach",
      SRC,
      TS
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe("correction");
  });

  // ── Multi-line messages ───────────────────────────────────────────────────

  it("extracts multiple entries from a multi-line message", () => {
    const msg = [
      "We decided to use OpenClaw as the runtime",
      "The database will be SQLite with temporal validity",
      "What about the deployment timeline?",
    ].join("\n");

    const entries = extractEntries(msg, SRC, TS);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.type)).toEqual(["decision", "fact", "question"]);
  });

  // ── Metadata propagation ──────────────────────────────────────────────────

  it("propagates source and timestamp to all entries", () => {
    const entries = extractEntries("We decided to ship v2", SRC, TS);
    expect(entries[0]!.source).toBe(SRC);
    expect(entries[0]!.timestamp).toBe(TS);
  });

  it("preserves original line text", () => {
    const line = "We decided to use Docker for deployment";
    const entries = extractEntries(line, SRC, TS);
    expect(entries[0]!.text).toBe(line);
  });
});
