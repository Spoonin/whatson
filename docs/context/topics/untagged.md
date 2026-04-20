# Untagged

> 5 active facts

## Facts

- [2026-04-20] 1. Phase 6 (Audit Pass) is already in the code. 2. Tree rendering should output markdown tree with fact IDs in INDEX.md. 3. Just save context, no actions required. *(telegram:@DisterX, medium)*
- [2026-04-20] Project context tree structure design: hierarchical organization with Architecture (System Design, Data Flow, Storage) → Decisions (Technology, Process) → Implementation Details (Consolidation, Extraction, Rendering) → Gaps & Questions → Known Contradictions → Sources. Mapping to current schema: tags→hierarchy via parent_fact_id, relations table needs systematic population during consolidation, drift_findings already tracked, audit questions as fact type. Implementation path: (1) relation tracking during consolidation, (2) hierarchical tagging extraction, (3) tree rendering in render.ts using tag prefixes. *(telegram:@DisterX, medium)*
- [2026-04-20] our knowledge base is a list of facts, to me it seems a bit unnatural, as my knowledge model looks more like a tree, or even sometimes as a graph. DB is already graph-capable (relations table exists) but underutilized. Three options: (1) Wire up the graph traversal in retrieval/consolidation + populate relations systematically, (2) Hierarchical tagging/topics using taxonomy, (3) Full remodel to property graph. Preference: (1) + (2) — use existing DB structure, improve retrieval/rendering to leverage graph + organize by hierarchies. *(telegram:@DisterX, medium)*

## Corrections

- [2026-04-20] we decided to store facts in a tree structure form instead of a flat facts list *(telegram:@DisterX, high)*
  - Overrides: "Project context tree structure design: hierarchical organization with Architecture (System Design, Data Flow, Storage) → Decisions (Technology, Process) → Implementation Details (Consolidation, Extraction, Rendering) → Gaps & Questions → Known Contradictions → Sources. Mapping to current schema: tags→hierarchy via parent_fact_id, relations table needs systematic population during consolidation, drift_findings already tracked, audit questions as fact type. Implementation path: (1) relation tracking during consolidation, (2) hierarchical tagging extraction, (3) tree rendering in render.ts using tag prefixes." (2026-04-20)

## Open Questions

- [2026-04-20] what do you have in repo? *(telegram:@DisterX, medium)*
