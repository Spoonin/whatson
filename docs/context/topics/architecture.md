# Architecture

> 7 active facts · See also: [consolidation](consolidation.md), [database](database.md), [llm](llm.md), [logging](logging.md), [retrieval](retrieval.md), [runtime](runtime.md), [storage](storage.md), [workflow](workflow.md)

## Decisions

- [2026-04-16] Implement multi-stage retrieval pipeline *(telegram:@DisterX, high)*
- [2026-04-16] Use actor-based architecture with Cue runtime *(telegram:@DisterX, high)*
- [2026-04-16] Raw storage is preferred over real-time summarization *(telegram:@DisterX, high)*

## Facts

- [2026-04-16] consolidation.ts module implements 5-phase process: Orient→Gather→Consolidate→Prune&Index→Drift *(telegram:@DisterX, high)*
- [2026-04-16] wal.ts module implements write-ahead log with regex and LLM extraction *(telegram:@DisterX, high)*
- [2026-04-16] storage.ts module uses SQLite with temporal knowledge graph and sqlite-vec *(telegram:@DisterX, high)*
- [2026-04-16] Architecture comprises five layers: Identity/Soul, Storage (MemPalace wings/rooms/KG), WAL/Session state, Consolidation (4-phase), Execution (plan mode), and Active collection (MCP) *(telegram:@DisterX, high)*
