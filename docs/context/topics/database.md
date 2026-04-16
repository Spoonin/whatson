# Database

> 4 active facts · See also: [api](api.md), [architecture](architecture.md), [dependencies](dependencies.md), [retrieval](retrieval.md), [search](search.md), [storage](storage.md), [tech-stack](tech-stack.md)

## Decisions

- [2026-04-16] Tech stack: Node.js/TypeScript, ChromaDB or LanceDB, SQLite temporal KG, Claude API (Sonnet for routine tasks, Opus for consolidation), MCP for integrations (Slack/Google Drive/GitHub), file-based WAL *(telegram:@DisterX, high)*

## Facts

- [2026-04-16] Dependencies include better-sqlite3 for database access *(telegram:@DisterX, high)*
- [2026-04-16] retrieval.ts module uses FTS5 and vector search *(telegram:@DisterX, high)*
- [2026-04-16] storage.ts module uses SQLite with temporal knowledge graph and sqlite-vec *(telegram:@DisterX, high)*
