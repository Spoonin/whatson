/**
 * Render phase — fact store → synthesized developer-oriented artifact.
 *
 * MVP: one artifact (PROJECT.md), one template, local output, citation-per-
 * content-line enforcement. No git, no remote push. No NLI fidelity check.
 *
 * Flow:
 *   1. Load template from ../templates/
 *   2. Query active facts, filter by tag/sourceType → FactPack
 *   3. Call LLM with strict citation system prompt
 *   4. Deterministic verifier: every content line has a valid <!-- fact:N -->
 *   5. On success, write to data/rendered/. On violation, return without writing.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getActiveFacts, type Fact } from "./storage.js";
import { callModel, isBackendReady, resolveBackend, type LlmBackend } from "./llm.js";
import { syncRenderedFile, type RepoSyncResult } from "./repo-sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, "../data/rendered");
const TEMPLATE_DIR = path.resolve(__dirname, "../templates");

// ── Types ───────────────────────────────────────────────────────────────────

export interface FactPackFact {
  id: string;              // "f:42"
  content: string;
  sourceType: string;
  confidence: string;
  validFrom: string;
  source: string;
  tags: string[];
}

export interface FactPack {
  artifact: string;
  template: string;
  renderedAt: string;
  facts: FactPackFact[];
}

export interface VerificationViolation {
  line: number;
  text: string;
  reason: string;
}

export interface RenderResult {
  artifact: string;
  factCount: number;
  verified: boolean;
  violations: VerificationViolation[];
  outputPath?: string;
  skipped?: string;
  backend?: LlmBackend;
  gitPush?: Pick<RepoSyncResult, "committed" | "pushed" | "commitSha" | "skipped">;
}

export interface FactQuery {
  tags?: string[];
  sourceTypes?: string[];
}

export interface RenderOptions {
  outputDir?: string;
  templateName?: string;
  tags?: string[];
  sourceTypes?: string[];
}

// ── Fact filter (pure) ──────────────────────────────────────────────────────

export function filterFacts(facts: Fact[], query: FactQuery): Fact[] {
  return facts.filter((f) => {
    if (query.tags && query.tags.length > 0) {
      const hit = f.tags.some((t) => query.tags!.includes(t));
      if (!hit) return false;
    }
    if (query.sourceTypes && query.sourceTypes.length > 0) {
      if (!query.sourceTypes.includes(f.source_type)) return false;
    }
    return true;
  });
}

function toPackFact(f: Fact): FactPackFact {
  return {
    id: `f:${f.id}`,
    content: f.content,
    sourceType: f.source_type,
    confidence: f.confidence,
    validFrom: f.valid_from.slice(0, 10),
    source: f.source,
    tags: f.tags,
  };
}

// ── Template loading ────────────────────────────────────────────────────────

export function loadTemplate(name: string): string {
  return fs.readFileSync(path.join(TEMPLATE_DIR, name), "utf-8");
}

// ── Render prompt ───────────────────────────────────────────────────────────

const RENDER_SYSTEM_PROMPT = `You are the Render phase of a context agent. You transform a set of verified facts into a single target document for developers and AI coding tools.

Hard rules:
1. Every declarative sentence MUST end with one or more citation markers of the form <!-- fact:f:N --> (where N is a numeric fact ID, e.g. <!-- fact:f:5 -->) citing the fact(s) it paraphrases. Bullet list items count as sentences and must be cited too. Multiple markers on one sentence are allowed.
2. NEVER introduce claims not present in the fact pack. If a natural-sounding sentence would require knowledge you don't have, omit it entirely.
3. If facts contradict each other, do NOT choose — emit both into the "Unresolved" section with both fact IDs.
4. Preserve the template's section headers (# and ##) exactly. Do not invent new top-level sections. Fill only the slot comments (<!-- slot: ... -->) and strip them from the output.
5. Dates must be absolute (YYYY-MM-DD), never relative.
6. Developer-grade prose only — no marketing language, no hype, no filler, no restatements of the instructions.
7. If a section has no applicable facts, output exactly one line for that section: _No facts available._ (no citation required for that sentinel).
8. Output the full rendered markdown file and nothing else. No preamble, no code fences, no trailing commentary.`;

// ── LLM call (via dispatcher) ───────────────────────────────────────────────

async function callLlm(pack: FactPack): Promise<{ text: string; backend: LlmBackend }> {
  const userMessage =
    `Template:\n\n${pack.template}\n\n---\n\n` +
    `Fact pack (JSON):\n\n` +
    JSON.stringify({ facts: pack.facts, renderedAt: pack.renderedAt }, null, 2);

  const result = await callModel({
    component: "render",
    system: RENDER_SYSTEM_PROMPT,
    user: userMessage,
    model: "claude-sonnet-4-6",
    maxTokens: 4096,
  });
  return { text: result.text, backend: result.backend };
}

// ── Verifier (deterministic) ────────────────────────────────────────────────

const CITATION_RE = /<!--\s*fact:(f:\d+)\s*-->/g;
const NO_FACTS_SENTINEL = "_No facts available._";

/**
 * Every content line in the rendered artifact must contain at least one
 * <!-- fact:N --> marker, and every referenced ID must be in the pack.
 *
 * A "content line" is any non-empty line except:
 *   - headings (# ...)
 *   - blockquote / metadata (> ...)
 *   - horizontal rules (---, ===)
 *   - pure HTML-comment lines (slot remnants should not appear, but we skip
 *     them defensively — they'll be caught as missing content instead)
 *   - the explicit no-facts sentinel
 */
export function verifyCitations(
  rendered: string,
  validIds: Set<string>
): VerificationViolation[] {
  const violations: VerificationViolation[] = [];
  const lines = rendered.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;
    if (trimmed.startsWith(">")) continue;
    if (trimmed.startsWith("---") || trimmed.startsWith("===")) continue;
    if (trimmed === NO_FACTS_SENTINEL) continue;
    // Bare HTML comment with no fact cite → skip (not a claim).
    if (/^<!--[\s\S]*-->$/.test(trimmed) && !/<!--\s*fact:/.test(trimmed)) continue;

    const matches = [...trimmed.matchAll(CITATION_RE)];
    if (matches.length === 0) {
      violations.push({ line: i + 1, text: trimmed, reason: "no citation" });
      continue;
    }
    for (const m of matches) {
      const id = m[1];
      if (!validIds.has(id)) {
        violations.push({
          line: i + 1,
          text: trimmed,
          reason: `unknown fact id ${id}`,
        });
      }
    }
  }

  return violations;
}

// ── Main entry point ────────────────────────────────────────────────────────

const DEFAULT_PROJECT_TAGS = [
  "overview",
  "objectives",
  "kpi",
  "architecture",
  "technology",
  "deployment",
  "roadmap",
  "safety",
  "security",
  "sandbox",
  "control",
  "skill-audit",
  "performance",
  "accuracy",
  "autonomy",
  "evolution",
  "learning",
  "trading",
];

export async function renderProjectDoc(
  opts: RenderOptions = {}
): Promise<RenderResult> {
  const outputDir = opts.outputDir ?? DEFAULT_OUTPUT_DIR;
  const templateName = opts.templateName ?? "project.md";
  const artifact = "PROJECT.md";

  const template = loadTemplate(templateName);
  const all = await getActiveFacts();
  const filtered = filterFacts(all, {
    tags: opts.tags ?? DEFAULT_PROJECT_TAGS,
    sourceTypes: opts.sourceTypes,
  });

  if (filtered.length === 0) {
    return {
      artifact,
      factCount: 0,
      verified: false,
      violations: [],
      skipped: "no matching facts in fact store",
    };
  }

  const readiness = isBackendReady("render");
  if (!readiness.ready) {
    return {
      artifact,
      factCount: filtered.length,
      verified: false,
      violations: [],
      backend: resolveBackend("render"),
      skipped: readiness.reason ?? "backend unavailable",
    };
  }

  const pack: FactPack = {
    artifact,
    template,
    renderedAt: new Date().toISOString(),
    facts: filtered.map(toPackFact),
  };

  const { text: rendered, backend } = await callLlm(pack);
  const validIds = new Set(pack.facts.map((f) => f.id));
  const violations = verifyCitations(rendered, validIds);

  if (violations.length > 0) {
    return {
      artifact,
      factCount: filtered.length,
      verified: false,
      violations,
      backend,
    };
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, artifact);
  fs.writeFileSync(outputPath, rendered.endsWith("\n") ? rendered : rendered + "\n");

  const sync = await syncRenderedFile(outputPath, artifact);

  return {
    artifact,
    factCount: filtered.length,
    verified: true,
    violations: [],
    outputPath,
    backend,
    gitPush: { committed: sync.committed, pushed: sync.pushed, commitSha: sync.commitSha, skipped: sync.skipped },
  };
}
