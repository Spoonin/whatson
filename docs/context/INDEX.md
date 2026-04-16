# Project Context Index

> Maintained by Whatson. Last updated: 2026-04-16
> Active facts: 43 · Topics: 58 · Sources: 1

Read this file first. It summarizes all project context below.
Corrections override earlier facts. Open questions need stakeholder input.
See `topics/` for detail by subject, `sources/` for raw extraction logs.

## Topics

- [architecture](topics/architecture.md) — 7 facts
- [ai-agent](topics/ai-agent.md) — 7 facts
- [recent-changes](topics/recent-changes.md) — 4 facts
- [storage](topics/storage.md) — 4 facts
- [llm](topics/llm.md) — 4 facts
- [dependencies](topics/dependencies.md) — 4 facts
- [database](topics/database.md) — 4 facts
- [research](topics/research.md) — 3 facts
- [testing](topics/testing.md) — 2 facts
- [codebase](topics/codebase.md) — 2 facts
- [consolidation](topics/consolidation.md) — 2 facts
- [mcp](topics/mcp.md) — 2 facts
- [integration](topics/integration.md) — 2 facts
- [api](topics/api.md) — 2 facts
- [retrieval](topics/retrieval.md) — 2 facts
- [requirements](topics/requirements.md) — 2 facts
- [project](topics/project.md) — 2 facts
- [functionality](topics/functionality.md) — 2 facts
- [dogfooding](topics/dogfooding.md) — 1 fact
- [Whatson](topics/whatson.md) — 1 fact
- [drift analysis](topics/drift-analysis.md) — 1 fact
- [human-in-the-loop](topics/human-in-the-loop.md) — 1 fact
- [contradiction detection](topics/contradiction-detection.md) — 1 fact
- [configuration](topics/configuration.md) — 1 fact
- [optimization](topics/optimization.md) — 1 fact
- [schema](topics/schema.md) — 1 fact
- [cli](topics/cli.md) — 1 fact
- [vectors](topics/vectors.md) — 1 fact
- [embeddings](topics/embeddings.md) — 1 fact
- [external-service](topics/external-service.md) — 1 fact
- [git](topics/git.md) — 1 fact
- [sync](topics/sync.md) — 1 fact
- [search](topics/search.md) — 1 fact
- [drift-detection](topics/drift-detection.md) — 1 fact
- [analysis](topics/analysis.md) — 1 fact
- [workflow](topics/workflow.md) — 1 fact
- [logging](topics/logging.md) — 1 fact
- [metrics](topics/metrics.md) — 1 fact
- [team](topics/team.md) — 1 fact
- [stakeholder](topics/stakeholder.md) — 1 fact
- [communication](topics/communication.md) — 1 fact
- [process](topics/process.md) — 1 fact
- [platform](topics/platform.md) — 1 fact
- [messaging](topics/messaging.md) — 1 fact
- [roadmap](topics/roadmap.md) — 1 fact
- [prioritization](topics/prioritization.md) — 1 fact
- [tech-stack](topics/tech-stack.md) — 1 fact
- [runtime](topics/runtime.md) — 1 fact
- [data-quality](topics/data-quality.md) — 1 fact
- [protocol](topics/protocol.md) — 1 fact
- [identity](topics/identity.md) — 1 fact
- [memory](topics/memory.md) — 1 fact
- [problem-analysis](topics/problem-analysis.md) — 1 fact
- [documentation](topics/documentation.md) — 1 fact
- [purpose](topics/purpose.md) — 1 fact
- [interaction](topics/interaction.md) — 1 fact
- [context-management](topics/context-management.md) — 1 fact
- [data-input](topics/data-input.md) — 1 fact

## Recent Decisions

- [2026-04-16] Test and optimize the system in dogfooding mode (using Whatson to develop Whatson) *(telegram:@DisterX)*
- [2026-04-16] Human Q&A should be triggered when drift analysis finds inconsistencies *(telegram:@DisterX)*
- [2026-04-16] Work priority order: consolidation loop first (highest risk), then storage, WAL, collectors, identity, retrieval pipeline *(telegram:@DisterX)*
- [2026-04-16] Tech stack: Node.js/TypeScript, ChromaDB or LanceDB, SQLite temporal KG, Claude API (Sonnet for routine tasks, Opus for consolidation), MCP for integrations (Slack/Google Drive/GitHub), file-based WAL *(telegram:@DisterX)*
- [2026-04-16] Implement multi-stage retrieval pipeline *(telegram:@DisterX)*
- [2026-04-16] Use actor-based architecture with Cue runtime *(telegram:@DisterX)*
- [2026-04-16] Attribution and confidence scoring required on every fact *(telegram:@DisterX)*
- [2026-04-16] Raw storage is preferred over real-time summarization *(telegram:@DisterX)*
- [2026-04-16] Consolidated context is used to help AI tools implement projects *(telegram:@DisterX)*
- [2026-04-16] AI agent proactively asks questions to experts and stakeholders when facing doubts or inconsistencies *(telegram:@DisterX)*
- [2026-04-16] AI agent consolidates gathered context and checks for consistency *(telegram:@DisterX)*
- [2026-04-16] AI agent explores content and extracts context from discussions and documents *(telegram:@DisterX)*
- [2026-04-16] AI agent is fed with documents and reference sources *(telegram:@DisterX)*
- [2026-04-16] AI agent participates in and analyzes discussions *(telegram:@DisterX)*

## Key Facts

- [2026-04-16] Contradiction detection has been implemented and is currently undergoing testing *(telegram:@DisterX)*
- [2026-04-16] Codebase is confirmed to be in the target repo from settings *(telegram:@DisterX)*
- [2026-04-16] Recent work includes consolidation optimizations *(telegram:@DisterX)*
- [2026-04-16] Recent work includes storage schema v2 *(telegram:@DisterX)*
- [2026-04-16] Recent work includes CLI backend wiring *(telegram:@DisterX)*
- [2026-04-16] Recent work includes LLM dispatcher implementation *(telegram:@DisterX)*
- [2026-04-16] Dependencies include @modelcontextprotocol/sdk for MCP protocol *(telegram:@DisterX)*
- [2026-04-16] Dependencies include @anthropic-ai/sdk for Claude integration *(telegram:@DisterX)*
- [2026-04-16] Dependencies include sqlite-vec for vector operations *(telegram:@DisterX)*
- [2026-04-16] Dependencies include better-sqlite3 for database access *(telegram:@DisterX)*
- [2026-04-16] embeddings.ts module uses Voyage AI *(telegram:@DisterX)*
- [2026-04-16] mcp-server.ts module provides MCP tools *(telegram:@DisterX)*
- [2026-04-16] repo-sync.ts module handles git sync to target repository *(telegram:@DisterX)*
- [2026-04-16] retrieval.ts module uses FTS5 and vector search *(telegram:@DisterX)*
- [2026-04-16] drift.ts module performs codebase drift analysis *(telegram:@DisterX)*
- [2026-04-16] consolidation.ts module implements 5-phase process: Orient→Gather→Consolidate→Prune&Index→Drift *(telegram:@DisterX)*
- [2026-04-16] wal.ts module implements write-ahead log with regex and LLM extraction *(telegram:@DisterX)*
- [2026-04-16] storage.ts module uses SQLite with temporal knowledge graph and sqlite-vec *(telegram:@DisterX)*
- [2026-04-16] Codebase size is approximately 6100 lines of code across 23 files *(telegram:@DisterX)*
- [2026-04-16] Expert/stakeholder is @DisterX (Denis) *(telegram:@DisterX)*

## Recent Sources

- [telegram:@DisterX](sources/2026-04-16_telegram-disterx.md) — 2026-04-16
