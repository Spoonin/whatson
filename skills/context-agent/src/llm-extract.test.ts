import { describe, it, expect } from "vitest";
import { isDerivable } from "./llm-extract.js";

describe("isDerivable", () => {
  it("filters import statements", () => {
    expect(isDerivable("import fs from 'fs'")).toBe(true);
    expect(isDerivable("export function foo() {}")).toBe(true);
    expect(isDerivable("const x = 42")).toBe(true);
  });

  it("filters comments", () => {
    expect(isDerivable("// this is a comment")).toBe(true);
    expect(isDerivable("/* block comment */")).toBe(true);
    expect(isDerivable("# python comment")).toBe(true);
    expect(isDerivable("  * JSDoc line")).toBe(true);
  });

  it("filters file paths", () => {
    expect(isDerivable("src/index.ts")).toBe(true);
    expect(isDerivable("package.json")).toBe(true);
    expect(isDerivable("README.md")).toBe(true);
    expect(isDerivable("skills/context-agent/src/wal.ts")).toBe(true);
  });

  it("filters git output", () => {
    expect(isDerivable("a1b2c3d")).toBe(true);
    expect(isDerivable("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0")).toBe(true);
    expect(isDerivable("diff --git a/foo b/bar")).toBe(true);
    expect(isDerivable("commit abc123")).toBe(true);
    expect(isDerivable("Author: Denis <d@example.com>")).toBe(true);
  });

  it("filters package manager commands", () => {
    expect(isDerivable("npm install express")).toBe(true);
    expect(isDerivable("pnpm add better-sqlite3")).toBe(true);
    expect(isDerivable("pip install requests")).toBe(true);
  });

  it("filters pure punctuation lines", () => {
    expect(isDerivable("  {}  ")).toBe(true);
    expect(isDerivable("();")).toBe(true);
  });

  it("keeps decisions and facts", () => {
    expect(isDerivable("We decided to use PostgreSQL for the database")).toBe(false);
    expect(isDerivable("The API latency is 200ms")).toBe(false);
    expect(isDerivable("Denis prefers to use TypeScript")).toBe(false);
    expect(isDerivable("Actually, we're switching to Redis")).toBe(false);
  });

  it("keeps questions", () => {
    expect(isDerivable("What database should we use?")).toBe(false);
    expect(isDerivable("How many team members are there?")).toBe(false);
  });

  it("handles leading whitespace", () => {
    expect(isDerivable("  import foo from 'bar'")).toBe(true);
    expect(isDerivable("  We decided to use PostgreSQL")).toBe(false);
  });
});
