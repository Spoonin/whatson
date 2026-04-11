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
import { wal_append, storage_insert, storage_query, consolidate, get_status } from "./index.js";

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
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
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
  "Run the 4-phase consolidation loop: Orient, Gather, Consolidate (dedup + contradiction resolution), Prune & Index. Call this on schedule or when the user requests /consolidate.",
  {},
  async () => {
    const result = await consolidate();
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

// ── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[context-agent-mcp] Server started on stdio");
}

main().catch((err) => {
  console.error("[context-agent-mcp] Fatal:", err);
  process.exit(1);
});
