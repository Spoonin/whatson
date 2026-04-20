/**
 * MCP stdio server for the Context Agent.
 *
 * Wraps the existing tool functions (wal_append, storage_query, consolidate,
 * get_status, storage_insert) as MCP tools so OpenClaw can call them natively.
 *
 * Usage: node dist/mcp-server.js
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { wal_append, storage_insert, storage_query, consolidate_start, consolidate_status, sync_repo, get_status, retrieve_context, run_drift_analysis, get_drift_report, resolve_drift_finding, render_tree } from "./index.js";
import { backfillEmbeddings } from "./embeddings.js";

const server = new McpServer({
  name: "context-agent",
  version: "0.1.0",
});

// ── Tool: wal_append ────────────────────────────────────────────────────────

server.tool(
  "wal_append",
  "Extract facts, decisions, and corrections from a message and store them in the knowledge base. Use this for every incoming user message that contains substantive content.",
  {
    message:    z.string().describe("Raw incoming message text"),
    source:     z.string().describe("Origin: telegram:@username, web:url, doc:filename"),
    timestamp:  z.string().describe("ISO 8601 timestamp of when the message arrived"),
    message_id: z.string().optional().describe("Unique message ID for grouping multi-source facts"),
    source_url: z.string().optional().describe("URL this message was fetched from"),
    source_file: z.string().optional().describe("File path this message was extracted from"),
  },
  async (params) => {
    const result = await wal_append({
      message:     params.message,
      source:      params.source,
      timestamp:   params.timestamp,
      message_id:  params.message_id,
      source_url:  params.source_url,
      source_file: params.source_file,
    });
    const parts: Array<{ type: "text"; text: string }> = [
      { type: "text", text: JSON.stringify(result, null, 2) },
    ];
    if (result.conflicts.length > 0) {
      const alert = [
        "\n⚠️ CONFLICTS DETECTED — flag these to the user immediately:",
        ...result.conflicts.map(
          (c) =>
            `  New fact #${c.newFactId}: "${c.newText}"\n  conflicts with existing #${c.existingFactId}: "${c.existingText}" (source: ${c.existingSource})`
        ),
        "\nAsk the user: should the earlier fact be updated, or should both be kept?",
      ].join("\n");
      parts.push({ type: "text", text: alert });
    }
    return { content: parts };
  }
);

// ── Tool: storage_query ─────────────────────────────────────────────────────

server.tool(
  "storage_query",
  "Search the knowledge base for facts by keyword or tags. Use this when the user asks about previously recorded information.",
  {
    keyword: z.string().optional().describe("Search keyword (matched against fact content)"),
    tags:    z.array(z.string()).optional().describe("Topic tags to filter by"),
    limit:   z.number().optional().describe("Max results to return (default 20)"),
  },
  async (params) => {
    const result = await storage_query({
      keyword: params.keyword,
      tags:    params.tags,
      limit:   params.limit,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── Tool: storage_insert ────────────────────────────────────────────────────

server.tool(
  "storage_insert",
  "Directly insert a structured fact into the knowledge base, bypassing WAL extraction. Use for manually classified facts.",
  {
    content:     z.string().describe("Fact text"),
    source:      z.string().describe("Origin identifier"),
    source_type: z.enum(["decision", "fact", "correction", "opinion", "question", "summary"]).describe("Classification"),
    confidence:  z.enum(["low", "medium", "high"]).describe("Confidence level"),
    tags:        z.array(z.string()).describe("Topic tags"),
    raw_message: z.string().describe("Verbatim original message"),
    message_id:  z.string().optional(),
    source_url:  z.string().optional(),
    source_file: z.string().optional(),
  },
  async (params) => {
    const result = await storage_insert({
      content:     params.content,
      source:      params.source,
      source_type: params.source_type,
      confidence:  params.confidence,
      tags:        params.tags,
      raw_message: params.raw_message,
      message_id:  params.message_id,
      source_url:  params.source_url,
      source_file: params.source_file,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── Tool: consolidate ───────────────────────────────────────────────────────

server.tool(
  "consolidate",
  "Kick off the 5-phase consolidation loop (Orient, Gather, Consolidate, Prune & Index, Drift Analysis) in the background and return immediately. Consolidation can take minutes, so the MCP request would otherwise time out. Use `consolidate_status` to poll progress and read the final report. Call this on schedule or when the user requests /consolidate.",
  {},
  async () => {
    const kickoff = consolidate_start();
    const msg = kickoff.started
      ? `Consolidation started at ${kickoff.runAt}. It runs in the background — call consolidate_status in ~30s to see progress and the final report.`
      : `Consolidation not started: ${kickoff.reason}. Call consolidate_status to see the in-flight run (${kickoff.runAt}).`;
    return {
      content: [{ type: "text", text: msg }],
    };
  }
);

server.tool(
  "consolidate_status",
  "Return the state of the most recent consolidation run (idle / running / succeeded / failed) plus the formatted report if available. Call after `consolidate` to see progress and results.",
  {},
  async () => {
    const { state, report } = consolidate_status();
    const stateBlock = "```json\n" + JSON.stringify(state, null, 2) + "\n```";
    const reportBlock = report ?? "_(no report yet — consolidation has not completed)_";
    return {
      content: [
        { type: "text", text: stateBlock },
        { type: "text", text: reportBlock },
      ],
    };
  }
);

// ── Tool: sync_repo ─────────────────────────────────────────────────────────

server.tool(
  "sync_repo",
  "Export the active knowledge base to the target repo's docs/context/ directory as markdown, then commit and push. Requires TARGET_REPO env var. Call this manually or rely on the consolidation phase to trigger it automatically.",
  {},
  async () => {
    const result = await sync_repo();
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── Tool: get_status ────────────────────────────────────────────────────────

server.tool(
  "get_status",
  "Return the context agent's health snapshot: total facts, last consolidation, open questions, session fact count.",
  {},
  async () => {
    const result = await get_status();
    return {
      content: [{ type: "text", text: result.status }],
    };
  }
);

// ── Tool: retrieve_context ─────────────────────────────────────────────────

server.tool(
  "retrieve_context",
  "Answer a natural language question using the knowledge base. Extracts keywords, searches via FTS5, ranks by relevance/confidence/recency, and returns an attributed context block. Use this when the user asks a question about previously recorded project knowledge.",
  {
    question: z.string().describe("The user's question in natural language"),
    limit:    z.number().optional().describe("Max facts to consider (default 20)"),
  },
  async (params) => {
    const result = await retrieve_context({
      question: params.question,
      limit:    params.limit,
    });
    const parts: Array<{ type: "text"; text: string }> = [
      { type: "text", text: result.contextBlock },
    ];
    if (result.truncated) {
      parts.push({ type: "text", text: "\n(Results truncated to fit token budget)" });
    }
    if (result.facts.length === 0) {
      parts.push({ type: "text", text: "No matching facts found in the knowledge base." });
    }
    return { content: parts };
  }
);

// ── Tool: run_drift_analysis ───────────────────────────────────────────────

server.tool(
  "run_drift_analysis",
  "Run drift analysis: verify the target codebase against recorded decisions and facts using Claude Code. Requires WHATSON_DRIFT_ENABLED=true. Call this when the user requests /drift or wants to check codebase consistency.",
  {},
  async () => {
    const result = await run_drift_analysis();
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── Tool: get_drift_report ─────────────────────────────────────────────────

server.tool(
  "get_drift_report",
  "Return the latest drift analysis findings and any unanswered questions for stakeholders. Call when the user asks about drift, inconsistencies, or open questions.",
  {},
  async () => {
    const result = await get_drift_report();
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── Tool: resolve_drift_finding ───────────────────────────────────────────

server.tool(
  "resolve_drift_finding",
  "Mark a drift finding as addressed/resolved. Call when a stakeholder answers an open question or confirms an inconsistency has been handled.",
  {
    finding_id: z.number().describe("ID of the drift finding to resolve"),
  },
  async (params) => {
    const result = await resolve_drift_finding({ finding_id: params.finding_id });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ── Tool: render_tree ───────────────────────────────────────────────────────

server.tool(
  "render_tree",
  "Generate TREE.md: a mechanical structural overview of the knowledge base grouped by tag hierarchy, with inline relation edges, contradictions, open questions, and sources. Fast and deterministic. Call when you want a bird's-eye map of everything stored.",
  {},
  async () => {
    const result = await render_tree();
    const msg = result.skipped
      ? `TREE.md skipped: ${result.skipped}`
      : `TREE.md rendered: ${result.factCount} facts → ${result.outputPath}`;
    return {
      content: [{ type: "text", text: msg }],
    };
  }
);

// ── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[context-agent-mcp] Server started on stdio");

  // Backfill embeddings for facts that don't have them yet (non-blocking)
  backfillEmbeddings().catch((e) =>
    console.error("[context-agent-mcp] Backfill error:", e)
  );
}

main().catch((err) => {
  console.error("[context-agent-mcp] Fatal:", err);
  process.exit(1);
});
