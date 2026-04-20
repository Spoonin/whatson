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
import { getActiveFacts, getFactRelations, getDriftFindings, type Fact, type DriftFinding, type RelationType } from "./storage.js";
import { callModel, isBackendReady, resolveBackend, type LlmBackend } from "./llm.js";
import { syncRenderedFile, type RepoSyncResult } from "./repo-sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, "../data/rendered");
const TEMPLATE_DIR = path.resolve(__dirname, "../templates");

// ── Types ───────────────────────────────────────────────────────────────────

export interface ArtifactConfig {
  artifact: string;             // output filename, e.g. "PROJECT.md"
  templateName: string;         // template file under templates/
  defaultTags: string[];        // fact tag filter (OR semantics)
  defaultSourceTypes?: string[]; // fact source_type filter (OR semantics)
}

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

export interface TreeRenderOptions {
  outputDir?: string;
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

// ── Artifact configs ─────────────────────────────────────────────────────────

const PROJECT_CONFIG: ArtifactConfig = {
  artifact: "PROJECT.md",
  templateName: "project.md",
  defaultTags: [
    "overview", "objectives", "kpi", "architecture", "technology",
    "deployment", "roadmap", "safety", "security", "sandbox", "control",
    "skill-audit", "performance", "accuracy", "autonomy", "evolution",
    "learning", "trading",
  ],
};

const ARCHITECTURE_CONFIG: ArtifactConfig = {
  artifact: "ARCHITECTURE.md",
  templateName: "architecture.md",
  defaultTags: ["architecture", "technology", "deployment"],
};

const DECISIONS_CONFIG: ArtifactConfig = {
  artifact: "DECISIONS.md",
  templateName: "decisions.md",
  defaultTags: [],
  defaultSourceTypes: ["decision", "correction"],
};

const QUESTIONS_CONFIG: ArtifactConfig = {
  artifact: "QUESTIONS.md",
  templateName: "questions.md",
  defaultTags: [],
  defaultSourceTypes: ["question"],
};

const REQUIREMENTS_CONFIG: ArtifactConfig = {
  artifact: "REQUIREMENTS.md",
  templateName: "requirements.md",
  defaultTags: ["objectives", "kpi", "performance", "accuracy", "trading"],
};

const STATUS_CONFIG: ArtifactConfig = {
  artifact: "STATUS.md",
  templateName: "status.md",
  defaultTags: ["overview", "roadmap", "deployment"],
};

// ── Generic render ────────────────────────────────────────────────────────────

async function renderArtifact(
  config: ArtifactConfig,
  opts: RenderOptions = {}
): Promise<RenderResult> {
  const outputDir = opts.outputDir ?? DEFAULT_OUTPUT_DIR;
  const templateName = opts.templateName ?? config.templateName;
  const artifact = config.artifact;

  const template = loadTemplate(templateName);
  const all = await getActiveFacts();
  const filtered = filterFacts(all, {
    tags: opts.tags ?? config.defaultTags,
    sourceTypes: opts.sourceTypes ?? config.defaultSourceTypes,
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
    return { artifact, factCount: filtered.length, verified: false, violations, backend };
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

// ── Public render functions ───────────────────────────────────────────────────

export async function renderProjectDoc(opts: RenderOptions = {}): Promise<RenderResult> {
  return renderArtifact(PROJECT_CONFIG, opts);
}

export async function renderArchitectureDoc(opts: RenderOptions = {}): Promise<RenderResult> {
  return renderArtifact(ARCHITECTURE_CONFIG, opts);
}

export async function renderDecisionsDoc(opts: RenderOptions = {}): Promise<RenderResult> {
  return renderArtifact(DECISIONS_CONFIG, opts);
}

export async function renderQuestionsDoc(opts: RenderOptions = {}): Promise<RenderResult> {
  return renderArtifact(QUESTIONS_CONFIG, opts);
}

export async function renderRequirementsDoc(opts: RenderOptions = {}): Promise<RenderResult> {
  return renderArtifact(REQUIREMENTS_CONFIG, opts);
}

export async function renderStatusDoc(opts: RenderOptions = {}): Promise<RenderResult> {
  return renderArtifact(STATUS_CONFIG, opts);
}

// ── Tree Renderer ────────────────────────────────────────────────────────────
// Mechanical renderer (no LLM). Groups facts by tag hierarchy, shows relation
// edges inline, surfaces contradictions and open questions.

function groupFactsByTag(facts: Fact[]): Map<string, Map<string, Fact[]>> {
  const groups = new Map<string, Map<string, Fact[]>>();

  for (const f of facts) {
    const primary = f.tags[0] ?? "untagged";
    const secondary = f.tags[1] ?? "_root";

    if (!groups.has(primary)) {
      groups.set(primary, new Map());
    }
    const secondary_map = groups.get(primary)!;
    if (!secondary_map.has(secondary)) {
      secondary_map.set(secondary, []);
    }
    secondary_map.get(secondary)!.push(f);
  }

  const sorted = new Map<string, Map<string, Fact[]>>();
  const primaryKeys = Array.from(groups.keys()).sort((a, b) => {
    if (a === "untagged") return 1;
    if (b === "untagged") return -1;
    return a.localeCompare(b);
  });

  for (const primary of primaryKeys) {
    const secondaryMap = groups.get(primary)!;
    const sorted_secondary = new Map<string, Fact[]>();
    const secondaryKeys = Array.from(secondaryMap.keys()).sort((a, b) => {
      if (a === "_root") return -1;
      if (b === "_root") return 1;
      return a.localeCompare(b);
    });
    for (const secondary of secondaryKeys) {
      sorted_secondary.set(secondary, secondaryMap.get(secondary)!);
    }
    sorted.set(primary, sorted_secondary);
  }

  return sorted;
}

function formatFactLine(
  fact: Fact,
  relations: Array<{ relatedFactId: number; relationType: RelationType }> | undefined,
  factIndex: Map<number, Fact>
): string {
  const content = fact.content.length > 80 ? fact.content.slice(0, 80) + "…" : fact.content;
  let line = `- [f:${fact.id}] **${content}** \`${fact.confidence}\` *${fact.source}*`;

  if (relations && relations.length > 0) {
    for (const edge of relations) {
      if (factIndex.has(edge.relatedFactId)) {
        line += `\n  - ${edge.relationType} → [f:${edge.relatedFactId}]`;
      }
    }
  }

  return line;
}

function formatContradictions(
  all: Fact[],
  relationsMap: Map<number, Array<{ relatedFactId: number; relationType: RelationType }>>,
  driftFindings: DriftFinding[]
): string {
  const lines: string[] = [];
  const emitted = new Set<string>();

  // From relations
  for (const [factId, edges] of relationsMap) {
    for (const edge of edges) {
      if (edge.relationType === "contradicts") {
        const pair = `${Math.min(factId, edge.relatedFactId)},${Math.max(factId, edge.relatedFactId)}`;
        if (!emitted.has(pair)) {
          emitted.add(pair);
          const factA = all.find((f) => f.id === factId);
          const factB = all.find((f) => f.id === edge.relatedFactId);
          if (factA && factB) {
            const contentA = factA.content.length > 60 ? factA.content.slice(0, 60) + "…" : factA.content;
            const contentB = factB.content.length > 60 ? factB.content.slice(0, 60) + "…" : factB.content;
            lines.push(`- [f:${factA.id}] "${contentA}" ←contradicts→ [f:${factB.id}] "${contentB}"`);
          }
        }
      }
    }
  }

  // From drift
  for (const finding of driftFindings) {
    if (!finding.consistent && !finding.addressed) {
      const fact = all.find((f) => f.id === finding.fact_id);
      if (fact) {
        const content = fact.content.length > 60 ? fact.content.slice(0, 60) + "…" : fact.content;
        const evidence = finding.evidence || "inconsistency detected";
        lines.push(`- [f:${fact.id}] "${content}" *(drift: ${evidence})*`);
      }
    }
  }

  return lines.length > 0 ? lines.join("\n") : "";
}

function formatOpenQuestions(facts: Fact[]): string {
  const questions = facts.filter((f) => f.source_type === "question");
  if (questions.length === 0) return "";

  return questions
    .map((q) => `- [f:q:${q.id}] ${q.content} *(${q.source})*)`)
    .join("\n");
}

function buildSourcesFooter(facts: Fact[]): string {
  const sourceMap = new Map<string, number>();
  for (const f of facts) {
    sourceMap.set(f.source, (sourceMap.get(f.source) ?? 0) + 1);
  }

  const sorted = Array.from(sourceMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([source, count]) => `- \`${source}\` — ${count} fact${count === 1 ? "" : "s"}`);

  return sorted.join("\n");
}

export async function renderTreeDoc(opts: TreeRenderOptions = {}): Promise<RenderResult> {
  const outputDir = opts.outputDir ?? DEFAULT_OUTPUT_DIR;
  const all = await getActiveFacts();

  if (all.length === 0) {
    return {
      artifact: "TREE.md",
      factCount: 0,
      verified: false,
      violations: [],
      skipped: "no active facts in fact store",
    };
  }

  const relationsMap = await getFactRelations(all.map((f) => f.id!));
  const driftFindings = await getDriftFindings();

  // Build fact index for quick lookup
  const factIndex = new Map(all.map((f) => [f.id!, f]));

  // Group by tag hierarchy
  const grouped = groupFactsByTag(all);

  // Render tag sections
  const sections: string[] = [];
  for (const [primary, secondaryMap] of grouped) {
    const primaryCount = Array.from(secondaryMap.values()).reduce((sum, arr) => sum + arr.length, 0);
    sections.push(`## ${primary} (${primaryCount})`);

    for (const [secondary, facts] of secondaryMap) {
      if (secondary !== "_root") {
        sections.push(`### ${secondary} (${facts.length})`);
      }

      for (const fact of facts) {
        const edges = relationsMap.get(fact.id!);
        sections.push(formatFactLine(fact, edges, factIndex));
      }
    }
  }

  // Build contradictions section
  const contradictions = formatContradictions(all, relationsMap, driftFindings);
  const contraSection = contradictions ? [`---`, `\n## ⚠️ Contradictions`, contradictions] : [];

  // Build open questions section
  const questions = formatOpenQuestions(all);
  const questionsSection = questions ? [`\n## ⚠️ Open Questions`, questions] : [];

  // Build sources footer
  const sourcesFooter = buildSourcesFooter(all);
  const sourcesSection = [`\n---\n## Sources`, sourcesFooter];

  // Assemble document
  const now = new Date().toISOString().slice(0, 10);
  const relCount = relationsMap.size > 0
    ? Array.from(relationsMap.values()).reduce((sum, arr) => sum + arr.length, 0)
    : 0;

  const output = [
    `# Knowledge Tree`,
    `> Generated by Whatson • ${now} • ${all.length} active facts • ${relCount} relations`,
    ``,
    ...sections,
    ...contraSection,
    ...questionsSection,
    ...sourcesSection,
  ].join("\n");

  // Write file
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "TREE.md");
  fs.writeFileSync(outputPath, output, "utf-8");

  // Sync to repo
  const sync = await syncRenderedFile(outputPath, "TREE.md");

  return {
    artifact: "TREE.md",
    factCount: all.length,
    verified: true,
    violations: [],
    outputPath,
    gitPush: {
      committed: sync.committed,
      pushed: sync.pushed,
      commitSha: sync.commitSha,
      skipped: sync.skipped,
    },
  };
}

export async function renderAll(opts: RenderOptions = {}): Promise<RenderResult[]> {
  return Promise.all([
    renderProjectDoc(opts),
    renderArchitectureDoc(opts),
    renderDecisionsDoc(opts),
    renderQuestionsDoc(opts),
    renderRequirementsDoc(opts),
    renderStatusDoc(opts),
    renderTreeDoc(opts),
  ]);
}
