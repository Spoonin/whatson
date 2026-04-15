import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveBackend, backendMatrix, isBackendReady } from "./llm.js";

const KEYS = [
  "LLM_BACKEND",
  "LLM_BACKEND_EXTRACT",
  "LLM_BACKEND_CONSOLIDATION",
  "LLM_BACKEND_DRIFT",
  "LLM_BACKEND_RENDER",
  "LLM_BACKEND_RETRIEVAL",
  "ANTHROPIC_API_KEY",
];

describe("resolveBackend", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("defaults render/consolidation/extract/retrieval to sdk", () => {
    expect(resolveBackend("render")).toBe("sdk");
    expect(resolveBackend("consolidation")).toBe("sdk");
    expect(resolveBackend("extract")).toBe("sdk");
    expect(resolveBackend("retrieval")).toBe("sdk");
  });

  it("defaults drift to cli (tool access required)", () => {
    expect(resolveBackend("drift")).toBe("cli");
  });

  it("global LLM_BACKEND overrides the default", () => {
    process.env.LLM_BACKEND = "cli";
    expect(resolveBackend("render")).toBe("cli");
    expect(resolveBackend("consolidation")).toBe("cli");
    expect(resolveBackend("drift")).toBe("cli");
  });

  it("component-specific var wins over global", () => {
    process.env.LLM_BACKEND = "cli";
    process.env.LLM_BACKEND_RENDER = "sdk";
    expect(resolveBackend("render")).toBe("sdk");
    expect(resolveBackend("consolidation")).toBe("cli");
  });

  it("case-insensitive env values", () => {
    process.env.LLM_BACKEND_RENDER = "CLI";
    expect(resolveBackend("render")).toBe("cli");
  });

  it("invalid values fall through to the next precedence layer", () => {
    process.env.LLM_BACKEND_RENDER = "garbage";
    expect(resolveBackend("render")).toBe("sdk");
    process.env.LLM_BACKEND = "also-garbage";
    expect(resolveBackend("render")).toBe("sdk");
  });

  it("setting LLM_BACKEND=sdk forces drift to sdk (user override)", () => {
    process.env.LLM_BACKEND = "sdk";
    expect(resolveBackend("drift")).toBe("sdk");
  });

  it("backendMatrix reports every component", () => {
    const m = backendMatrix();
    expect(Object.keys(m).sort()).toEqual([
      "consolidation",
      "drift",
      "extract",
      "render",
      "retrieval",
    ]);
  });
});

describe("isBackendReady", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("reports not-ready for sdk components when no API key", () => {
    const r = isBackendReady("render");
    expect(r.ready).toBe(false);
    expect(r.reason).toContain("ANTHROPIC_API_KEY");
  });

  it("reports ready for sdk components when API key is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(isBackendReady("render").ready).toBe(true);
  });

  it("cli backends are assumed ready (binary check deferred)", () => {
    process.env.LLM_BACKEND_RENDER = "cli";
    expect(isBackendReady("render").ready).toBe(true);
  });
});
