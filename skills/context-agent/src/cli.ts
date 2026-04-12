#!/usr/bin/env node
/**
 * CLI entry point for context-agent tools.
 * Called by OpenClaw agent via exec tool.
 *
 * Usage:
 *   node cli.js wal_append --message "..." --source "telegram:@denis" --timestamp "..."
 *   node cli.js storage_query --keyword "postgres"
 *   node cli.js consolidate
 *   node cli.js get_status
 */

import { wal_append, storage_insert, storage_query, consolidate, sync_repo, get_status } from "./index.js";

const [,, command, ...rest] = process.argv;

function parseArgs(args: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, "");
    const value = args[i + 1];
    if (key && value !== undefined) {
      // Handle JSON arrays
      if (value.startsWith("[")) {
        try { result[key] = JSON.parse(value); } catch { result[key] = value; }
      } else if (value === "true") {
        result[key] = true;
      } else if (value === "false") {
        result[key] = false;
      } else if (/^\d+$/.test(value)) {
        result[key] = parseInt(value, 10);
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

async function main() {
  const args = parseArgs(rest) as Record<string, any>;

  let result;
  switch (command) {
    case "wal_append":
      result = await wal_append({
        message:     args.message ?? "",
        source:      args.source ?? "unknown",
        timestamp:   args.timestamp ?? new Date().toISOString(),
        message_id:  args.message_id,
        source_url:  args.source_url,
        source_file: args.source_file,
      });
      break;

    case "storage_query":
      result = await storage_query({
        keyword: args.keyword,
        tags:    args.tags,
        limit:   args.limit,
      });
      break;

    case "storage_insert":
      result = await storage_insert({
        content:     args.content ?? "",
        source:      args.source ?? "unknown",
        source_type: args.source_type ?? "fact",
        confidence:  args.confidence ?? "medium",
        tags:        args.tags ?? [],
        raw_message: args.raw_message ?? "",
        message_id:  args.message_id,
        source_url:  args.source_url,
        source_file: args.source_file,
      });
      break;

    case "consolidate":
      result = await consolidate();
      break;

    case "sync_repo":
      result = await sync_repo();
      break;

    case "get_status":
      result = await get_status();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Available: wal_append, storage_query, storage_insert, consolidate, sync_repo, get_status");
      process.exit(1);
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
