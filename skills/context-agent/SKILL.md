---
name: context-agent
description: "Collects, structures, and consolidates knowledge from conversations and documents. Maintains a temporal knowledge graph with source attribution and conflict resolution."
---

# context-agent

Context Agent collects, structures, and consolidates knowledge from conversations and documents. It maintains a temporal knowledge graph with source attribution and conflict resolution.

## Tools

### wal_append
Append extracted facts/decisions/corrections from a message to the Write-Ahead Log.

**Input:**
- `message` (string) — raw incoming message text
- `source` (string) — origin: `telegram:@username`, `doc:filename`, etc.
- `timestamp` (string, ISO 8601) — when the message arrived

**Output:** list of extracted entries written to SESSION-STATE.md

---

### storage_insert
Persist a structured fact into the SQLite knowledge base.

**Input:**
- `content` (string) — fact text
- `source` (string) — origin identifier
- `source_type` (enum: `decision | fact | correction | opinion`)
- `confidence` (enum: `low | medium | high`)
- `tags` (string[]) — topic tags
- `raw_message` (string) — verbatim original

**Output:** inserted fact `id`

---

### storage_query
Query current (non-expired) facts by keyword or tag.

**Input:**
- `keyword` (string, optional)
- `tags` (string[], optional)
- `limit` (number, default 20)

**Output:** array of matching facts with id, content, source, confidence, created_at

---

### consolidate
Run the 4-phase consolidation loop.

**Input:** none (reads from DB and session logs)

**Output:** consolidation summary — facts merged, contradictions found, INDEX.md updated

---

### get_status
Return agent health snapshot.

**Output:**
- total facts (active / expired)
- last consolidation timestamp
- open questions from SESSION-STATE.md
- session fact count

## Slash Commands

Registered with OpenClaw runtime:
- `/consolidate` → invokes `consolidate` tool
- `/facts [keyword]` → invokes `storage_query`
- `/status` → invokes `get_status`
