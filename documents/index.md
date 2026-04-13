# Context Agent — Setup & Development Guide

> Working documentation for running the POC in Claude Code.
> Created: 2026-04-11

---

## Project Goal

Build a continuously operating agent that:

* Collects context from heterogeneous sources (code, Teams, documents, human interviews).
* Structures and organizes the gathered knowledge.
* Maintains coherence at scale (resolves contradictions, invalidates outdated info).
* Provides the LLM with relevant context for specific tasks.
* Operates autonomously with periodic human-in-the-loop interaction.

---

## Part 1: Infrastructure — OpenClaw in Docker

### 1.1 Prerequisites

- Docker and Docker Compose
- Git
- Anthropic API key (`ANTHROPIC_API_KEY`)
- Telegram account (for creating a bot)

### 1.2 Creating the Telegram bot

1. Open Telegram, find `@BotFather`
2. Send `/newbot`
3. Choose a name (e.g. `Context Agent`) and username (e.g. `context_agent_dev_bot`)
4. **Save the token** — it will be needed in the config

### 1.3 Configure

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

```env
ANTHROPIC_API_KEY=sk-ant-YOUR_KEY_HERE
OPENCLAW_GATEWAY_TOKEN=context-agent-dev-token-change-me
OPENCLAW_GATEWAY_PORT=18789
TELEGRAM_BOT_TOKEN=123456:ABCDEF_YOUR_TOKEN
```

> No cloning needed — the gateway image is pulled from `openclaw/gateway:latest` via Docker.

### 1.4 Start

```bash
docker compose up -d openclaw-gateway
```

On first run `entrypoint.sh` automatically:
1. Runs `onboard --mode local`
2. Applies gateway config (mode, bind, CORS origins)
3. Registers the Telegram channel (if `TELEGRAM_BOT_TOKEN` is set)
4. Touches `.initialized` sentinel — subsequent restarts skip setup

### 1.5 Alternative: manual config

If CLI configuration does not work, create `~/.openclaw/openclaw.json` manually:

```json5
{
  agent: {
    model: "anthropic/claude-opus-4-6",
  },
  channels: {
    telegram: {
      enabled: true,
      botToken: "123456:ABCDEF_YOUR_TOKEN",
      dmPolicy: "pairing",
      allowFrom: [],
    },
  },
}
```

### 1.6 Verification (Hello World)

```bash
# Check gateway status
docker compose logs openclaw-gateway --tail 50

# Open Control UI
# http://127.0.0.1:18789/

# Message the bot in Telegram — a pairing code will arrive
# Approve it:
docker compose run --rm openclaw-cli pairing approve telegram <code>

# After approval — the bot should respond to messages
```

**Success criterion:** bot replies to "Hello" in Telegram.

### 1.7 Useful commands

```bash
# Status
docker compose ps
docker compose logs openclaw-gateway -f

# Restart
docker compose restart openclaw-gateway

# Diagnostics
docker compose run --rm openclaw-cli doctor

# Stop
docker compose down
```

---

## Part 2: Context Agent Skill Structure

After a working hello world — create the skill for Context Agent.

### 2.1 File layout

```
~/.openclaw/workspace/
├── AGENTS.md              # Agent operational instructions
├── SOUL.md                # Identity, priorities, style
├── skills/
│   └── context-agent/
│       ├── SKILL.md        # Skill description for OpenClaw
│       ├── src/
│       │   ├── wal.ts           # Write-Ahead Log (module 1)
│       │   ├── storage.ts       # SQLite storage + temporal KG (module 2)
│       │   ├── consolidation.ts # 4-phase consolidation loop (module 3)
│       │   └── retrieval.ts     # Search and context preparation (module 4)
│       ├── data/
│       │   ├── context.db       # SQLite database
│       │   ├── INDEX.md         # Knowledge index (~200 line budget)
│       │   ├── SESSION-STATE.md # WAL for current session
│       │   └── raw/             # Raw data (verbatim)
│       └── package.json
└── tools/                  # Custom tools (if needed)
```

### 2.2 SOUL.md — agent identity

```markdown
# Context Agent — Soul Document

## Purpose
I am the Context Agent. My responsibilities:
- Collect facts, decisions, and context from conversations and documents
- Structure and store knowledge with temporal validity
- Resolve contradictions between sources
- Provide relevant context for tasks

## Priorities (when in conflict)
1. Never lose data (WAL first)
2. Accuracy > completeness (better to say "I don't know")
3. Recent > old (temporal validity)
4. Corroborated > single-source (corroboration)

## Handling uncertainty
- If a fact comes from a single source — mark confidence: low
- If there is a contradiction — keep both versions, mark conflict
- If outdated — mark stale, do not delete immediately

## Communication style
- Concise, structured responses
- Always state the source and date of each fact
- When uncertain — ask
```

---

## Part 3: Development Modules (in order)

### Module 1: WAL (Write-Ahead Log)

**Priority:** High — simple, high impact.
**Pattern:** from Echo Libero (SESSION-STATE.md)

**Three input paths:**

1. **Plain text** — user sends a message in Telegram
2. **URLs** — message contains one or more URLs → each URL fetched independently, text extracted
3. **File uploads** — user attaches a file (PDF, DOCX, image, text) → saved to `data/raw/`, text extracted

**Input processing pipeline:**
```
Telegram message
  ├─→ detect URLs → for each URL:
  │     └─→ fetch page → strip HTML → extract readable text
  ├─→ detect file attachments → for each file:
  │     ├─→ size > 10MB? → reject ("file too large, max 10MB")
  │     ├─→ save to data/raw/{timestamp}_{filename}
  │     └─→ extract text (PDF parser / DOCX parser / OCR for images)
  ├─→ plain message text (always processed)
  └─→ all extracted text → LLM classification → SESSION-STATE.md + SQLite
```

**Multi-URL handling:** one message can produce facts from multiple sources. All facts from the same message share a `message_id` for cross-referencing during consolidation.

**Behaviour:**
- On every incoming message — process all input paths, then:
  - Classify via LLM (regex as pre-filter, LLM for final classification):
    - Decisions (confidence: high)
    - Facts (confidence: medium)
    - Corrections (confidence: high, supersedes previous)
    - Opinions (confidence: low)
  - For file uploads — generate a detailed description (stored as a `summary` fact)
  - Immediately write to SESSION-STATE.md
  - Only then — respond

**SESSION-STATE.md format:**
```markdown
# Session State — 2026-04-11

## Decisions
- [2026-04-11 14:30] Chose OpenClaw as the runtime for the POC
- [2026-04-11 14:45] Starting with Telegram, Teams later

## Facts
- [2026-04-11 14:30] Runtime: OpenClaw in Docker
- [2026-04-11 14:30] Vector DB deferred until after POC

## Files
- [2026-04-11 18:30] architecture-review.pdf (from @denis)
  Description: Architecture review for Project X. Covers microservices
  decomposition, database choice (PostgreSQL), deployment strategy (K8s).
  Recommends splitting auth into a separate service. Dated 2026-03-28.
  Raw: data/raw/2026-04-11_architecture-review.pdf

## URLs
- [2026-04-11 18:45] https://wiki.company.com/arch-decisions
  Description: Architecture decision records for Q1 2026. 3 ADRs:
  ADR-012 (PostgreSQL over MongoDB), ADR-013 (K8s deployment),
  ADR-014 (event-driven auth service).

## Corrections
- (empty for now)

## Open Questions
- Trigger for consolidation loop — what cadence?
```

**Success criteria:**
- Sending "We decided to use LanceDB instead of ChromaDB" → fact appears in SESSION-STATE.md
- Sending "Check https://wiki.com/arch and https://jira.com/PROJ-42" → both URLs fetched, facts extracted independently, linked by `message_id`
- Uploading a PDF → file saved to `data/raw/`, description + facts in SESSION-STATE.md

---

### Module 2: Storage (SQLite + Temporal KG)

**Priority:** High — the foundation.
**Pattern:** from MemPalace (temporal knowledge graph)

**SQLite schema:**

```sql
-- Main facts table
CREATE TABLE facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,            -- fact text
    source TEXT NOT NULL,             -- origin (telegram:@denis, web:https://wiki.com/arch)
    source_type TEXT NOT NULL,        -- type: decision | fact | correction | opinion | summary
    confidence TEXT DEFAULT 'medium', -- low | medium | high
    valid_from TEXT NOT NULL,         -- ISO datetime start of validity
    valid_to TEXT,                    -- ISO datetime end (NULL = currently valid)
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    superseded_by INTEGER,            -- ID of the replacement fact (for corrections)
    tags TEXT,                        -- JSON array of tags ["architecture", "storage"]
    raw_message TEXT,                 -- original Telegram message text (verbatim)
    message_id TEXT,                  -- groups facts from the same inbound message
    source_url TEXT,                  -- URL this fact was extracted from (NULL for plain text)
    source_file TEXT                  -- path to raw file in data/raw/ (NULL for text/URL)
);

-- Indexes
CREATE INDEX idx_facts_valid ON facts(valid_from, valid_to);
CREATE INDEX idx_facts_source ON facts(source_type);
CREATE INDEX idx_facts_tags ON facts(tags);
CREATE INDEX idx_facts_message ON facts(message_id);

-- Relations between facts
CREATE TABLE fact_relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fact_id INTEGER NOT NULL,
    related_fact_id INTEGER NOT NULL,
    relation_type TEXT NOT NULL,      -- contradicts | supports | supersedes | related
    created_at TEXT NOT NULL,
    FOREIGN KEY (fact_id) REFERENCES facts(id),
    FOREIGN KEY (related_fact_id) REFERENCES facts(id)
);

-- Consolidation log
CREATE TABLE consolidation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at TEXT NOT NULL,
    phase TEXT NOT NULL,              -- orient | gather | consolidate | prune
    facts_processed INTEGER,
    facts_merged INTEGER,
    facts_invalidated INTEGER,
    contradictions_found INTEGER,
    duration_ms INTEGER,
    notes TEXT
);
```

**Success criterion:** WAL writes facts to SQLite with correct fields. `SELECT * FROM facts WHERE valid_to IS NULL` returns current facts.

---

### Module 3: Consolidation Loop

**Priority:** Critical — the riskiest component.
**Pattern:** from Auto Dream (4 phases), adapted.

**4 phases:**

1. **Orient** — read INDEX.md, build a map of current state
   - How many facts? On which topics? When was the last consolidation?
   - Output: snapshot of current state

2. **Gather Signal** — targeted search for new data since last consolidation
   - Priority: user corrections > explicit saves > decisions > recurring themes
   - Do not read everything — grep narrowly against session logs
   - Output: list of new/changed facts

3. **Consolidate** — main work
   - Merge duplicate facts
   - Resolve contradictions (mark old one as superseded)
   - Convert relative → absolute dates ("yesterday" → "2026-04-10")
   - Cross-reference between sources
   - Output: updated fact base

4. **Prune & Index** — update INDEX.md
   - Remove stale data (valid_to < now - 30 days)
   - Update INDEX.md (~200 line budget)
   - Write log to consolidation_log
   - Output: clean, current index

**Trigger:** cron job via OpenClaw. Start with `24h` interval. Dual-gate (like Auto Dream): 24h + N sessions.

**Cron configuration in OpenClaw:**
```json5
{
  cron: {
    jobs: [
      {
        id: "consolidation",
        schedule: "0 3 * * *",  // every day at 03:00
        message: "/consolidate",
        channel: "internal",
      }
    ]
  }
}
```

**Success criterion:** after recording 20+ facts over a week — consolidation finds duplicates and contradictions, INDEX.md contains an up-to-date summary.

---

### Module 4: Retrieval

**Priority:** Medium — after data has accumulated.
**Pattern:** simple (no vector search in POC).

**Pipeline:**
1. Incoming question → extract keywords and tags
2. SQL query: `SELECT * FROM facts WHERE valid_to IS NULL AND tags LIKE '%keyword%'`
3. Rank by: confidence DESC, created_at DESC
4. Build context block for LLM (~2000 token budget)
5. LLM generates answer with attribution (source of each fact)

**Success criterion:** for the question "What runtime did we choose for the project?" the agent answers "OpenClaw in Docker (source: telegram, 2026-04-11)".

---

## Part 4: Open Questions for POC

- [ ] LanceDB vs ChromaDB — deferred until after POC
- [ ] Confidence scoring for different source types — start simple (decision=high, fact=medium, opinion=low)
- [ ] Expert polling UX — deferred
- [ ] Microsoft Teams integration — after Telegram
- [ ] Cue actor runtime — deferred, single-process for now
- [ ] Storage granularity — start with per-message, consolidate into per-decision

---

## Part 5: Progress Checklist

### Infrastructure
- [ ] Docker + OpenClaw running
- [ ] Telegram bot created and connected
- [ ] Hello world — bot responds to messages
- [ ] Control UI accessible at localhost:18789

### Module 1: WAL
- [ ] SKILL.md created in `skills/context-agent/`
- [ ] SESSION-STATE.md updated on every message
- [ ] Decisions/facts/corrections extracted correctly

### Module 2: Storage
- [ ] SQLite schema created
- [ ] Facts from WAL written to SQLite
- [ ] Temporal validity working (valid_from, valid_to)
- [ ] Raw messages stored (verbatim)

### Module 3: Consolidation
- [ ] Cron job configured
- [ ] Orient phase working
- [ ] Gather Signal finds new data
- [ ] Consolidate merges duplicates and resolves contradictions
- [ ] INDEX.md updated and stays within 200-line budget

### Module 4: Retrieval
- [ ] Keyword-based search over facts
- [ ] Responses include attribution (source + date)
- [ ] Context block formed within ~2000 token budget

### Teams Integration (after POC)
- [ ] Teams channel connected to OpenClaw
- [ ] Facts from Teams recorded on par with Telegram

---

## Part 6: Claude Code Source Analysis — Context Management Architecture

> Analysis based on reading the actual source code in `claude-code-sources/src/`.
> Date: 2026-04-11

### 6.1 Five-layer system overview

Claude Code manages context through five interconnected systems, orchestrated by post-sampling hooks:

| System | Location | When it fires | What it does |
|--------|----------|--------------|-------------|
| **Persistent Memory** | `memdir/` | Always loaded | File-based memory in `~/.claude/projects/<root>/memory/` |
| **Extract Memories** | `services/extractMemories/` | Post-sampling hook, every eligible turn | Forked subagent extracts facts → writes to memory files |
| **Auto Dream** | `services/autoDream/` | Post-sampling hook, dual-gate (24h + 5 sessions) | 4-phase consolidation of memory files via forked agent |
| **Compact** | `services/compact/` | Token threshold (context_window − 13k) | Streaming summarization, re-injects attachments after |
| **Session Memory** | `services/compact/sessionMemoryCompact.ts` | 10k tokens init; +8k + 5 tool calls update | Per-session working notes in `sessions/<id>/notes.md` |

### 6.2 Information lifecycle

```
User message
  → Main loop (MEMORY.md injected into system prompt)
  → API streaming response
  → Post-sampling hooks fire (in order):
      1. Session memory extraction (if token thresholds met)
      2. Extract memories (unless main agent already wrote to memory)
      3. Auto Dream consolidation (if time + session gates pass)
  → Auto-compact check (if approaching token limit)
  → Next turn
```

### 6.3 Persistent memory (`memdir/`)

**Directory structure:**
```
~/.claude/projects/<sanitized-git-root>/memory/
├── MEMORY.md                   # Index file (≤200 lines, ≤25KB)
├── user_preferences.md         # Frontmatter: name/description/type
├── feedback_testing.md         # feedback type → rule + Why + How to apply
├── project_deadline.md         # project type
├── reference_linear.md         # reference type → external pointers
├── logs/YYYY/MM/YYYY-MM-DD.md # Daily append-only logs (KAIROS mode only)
└── .consolidate-lock           # mtime = lastConsolidatedAt, body = PID
```

**4-type taxonomy (non-derivable only):**
- **user** — Role, preferences, knowledge, goals (always private)
- **feedback** — Guidance on approach ("don't mock DB", "terse responses")
- **project** — Deadlines, incidents, decisions, rationale
- **reference** — External system pointers (Linear, Grafana, Slack channels)

**Explicitly excluded from memory:**
- Code patterns, architecture, file paths, project structure
- Git history, blame, recent changes
- Debugging solutions, fix recipes
- Content already in CLAUDE.md
- Ephemeral task details, current conversation context

### 6.4 Extract Memories service

**Key design:** runs as a **forked subagent** (perfect fork of main conversation → prompt cache hit).

**Tool permissions:**
- ✅ Read, Grep, Glob (unrestricted)
- ✅ Read-only Bash (`ls`, `find`, `grep`, `cat`, `stat`, `wc`, `head`, `tail`)
- ✅ Edit/Write **only** to auto-memory directory
- ❌ Everything else denied

**Logic:**
1. Skip if: not main agent, gate disabled, auto-memory disabled, remote mode, or main agent already wrote to memory
2. **Cursor tracking:** `lastMemoryMessageUuid` — only processes messages after last extraction point
3. **Pre-injection:** scans memory files → injects manifest into prompt (agent doesn't waste turns on `ls`)
4. **Throttle:** every N eligible turns (configurable, default=1)
5. **Coalescing:** if extraction in-progress, stash context; run ONE trailing extraction after
6. Max 5 turns; Sonnet model; streaming
7. Display: "Saved N memories" inline in conversation

### 6.5 Auto Dream — 4-phase consolidation

**Trigger: dual-gate (cheapest check first)**
1. Time gate: hours since `lastConsolidatedAt` ≥ 24h (one `stat()` call)
2. Session gate: transcripts with `mtime > lastConsolidatedAt` ≥ 5 (directory scan)
3. Lock gate: no other process mid-consolidation (PID in `.consolidate-lock`)
4. Scan throttle: if time-gate passes but session-gate doesn't → 10-minute cooldown before re-scanning

**4 phases (from actual consolidation prompt):**

1. **Orient**
   - `ls` memory directory
   - Read MEMORY.md
   - Skim existing topic files
   - Review `logs/` or `sessions/` if present
   - Output: map of current memory state

2. **Gather Recent Signal**
   - Daily logs (`logs/YYYY/MM/DD.md`) — append-only stream
   - Existing memories that drifted — facts contradicting current codebase
   - Transcript search — grep narrow terms in JSONL transcripts (**no exhaustive reads**)
   - Priority: user corrections > explicit saves > recurring themes > decisions

3. **Consolidate**
   - Write/update memory files
   - Merge new signal into existing files (avoid near-duplicates)
   - Convert relative dates → absolute (persist-proof: "yesterday" → "2026-04-10")
   - Delete contradicted facts

4. **Prune & Index**
   - Update MEMORY.md (stay <200 lines, ~25KB)
   - Remove pointers to stale memories
   - Demote verbose entries (>200 chars → move detail to topic file)
   - Add pointers to new memories
   - Resolve contradictions

**Execution:** forked subagent with read-only Bash; grep for transcripts; tool restrictions prevent writes outside memory directory.

**Lock mechanism:** `.consolidate-lock` file — mtime serves as `lastConsolidatedAt`, body contains PID for stale lock reclamation. On failure, lock is rolled back (mtime rewound).

### 6.6 Context compaction

**Full compaction:**
- Trigger: token count ≥ (context_window − 13k buffer)
- Streaming summarization with Sonnet (no-tools preamble)
- 9-section prompt: request, concepts, files, errors, work done, next steps, ...
- Creates boundary marker with pre-compact token count + tool metadata
- Re-injects after compaction: files (5 files, 50k budget), tools (delta), MCP, skills, plan
- PTL retry: drop oldest API rounds, max 3 attempts

**Micro-compaction (time-based):**
- Trigger: gap since last assistant message ≥ threshold (~60 min)
- Action: content-clear all but last N compactable tool results
- Reason: server cache is cold — prefix will be rewritten anyway

**Micro-compaction (cached):**
- Trigger: tool results exceed keep threshold
- Action: queue `cache_edits` block for API layer (no local message mutation)
- Reason: preserve warm cache prefix

### 6.7 Key design patterns

| Pattern | How Claude Code uses it | Relevance to Context Agent |
|---------|------------------------|---------------------------|
| **Forked subagents** | All background work (extract, dream, session memory) runs as forked subagent — isolated tools, prompt cache hit, no state pollution | Our consolidation should use LLM, not just string matching |
| **Cursor-based delta** | `lastMemoryMessageUuid` — only process messages after last cursor | WAL needs message dedup / cursor tracking |
| **Pre-injection** | Scan memory dir → inject manifest into prompt before agent runs | Retrieval should pre-build context blocks |
| **Mutual exclusion** | Extract skips if main agent already wrote; Dream skips if lock held | Need locking for concurrent consolidation |
| **Closure-scoped state** | `initAutoDream()` creates fresh closure; tests call it in `beforeEach` | Already applied in test setup |
| **Dual-gate triggers** | Time + session count; cheapest gate first | Consolidation should use similar gating |
| **Scan throttle** | When time-gate passes but session-gate doesn't, 10-min cooldown | Prevents wasteful re-scanning |
| **Non-derivable taxonomy** | Only store knowledge that can't be re-derived from code/docs | Current WAL stores everything >20 chars — too noisy |

### 6.8 Gap analysis: our implementation vs Claude Code

| Aspect | Claude Code | Our current implementation | Gap |
|--------|-------------|---------------------------|-----|
| **Extraction** | LLM subagent with tool permissions | Regex keyword matching + length heuristic | Critical — need LLM-based extraction |
| **Consolidation** | LLM subagent with 4-phase prompt | Deterministic `normalize()` string comparison | Critical — can't detect semantic duplicates |
| **Contradiction detection** | LLM understands semantic conflict | Word overlap ≥ 2 (length >4) | High — too many false positives/negatives |
| **Memory taxonomy** | 4-type closed taxonomy, non-derivable only | No type filter, any line >20 chars = fact | Medium — noise will accumulate |
| **Cursor tracking** | `lastMemoryMessageUuid` | None — processes each message once at input | Medium — no delta processing |
| **Lock mechanism** | `.consolidate-lock` with mtime + PID | None | Medium — needed for cron-triggered runs |
| **Compaction** | Streaming summarization + micro-compact | Not implemented | Low priority for POC |
| **Pre-injection** | Memory manifest injected into prompt | Direct SQLite query in retrieval | Low — current approach is fine for POC |

### 6.9 Implementation priorities (revised after source analysis)

1. **Add LLM to extraction** — replace regex WAL with LLM-based classification (can still use regex as fast pre-filter, but final classification should be LLM)
2. **Add LLM to consolidation** — the 4-phase consolidation prompt should call an LLM for semantic dedup and contradiction resolution, not just string matching
3. **Implement non-derivable filter** — stop recording everything >20 chars; use the 4-type taxonomy
4. **Add consolidation lock** — `.consolidate-lock` with mtime for scheduling, PID for reclamation
5. **Add cursor tracking** — track last processed message ID to enable delta extraction
6. **Compaction** — defer to after POC; not needed until context window fills up

---

## Part 7: Target Repo Integration

### 7.1 Problem

Whatson collects knowledge locally (SQLite + markdown). But the value of that knowledge is only realized when **other AI agents working on the project can read it**. Facts, decisions, and source summaries must be committed to the target project's repository in a format that agents discover naturally.

### 7.2 Storage model: local working DB + committed knowledge layer

| Artifact | Where | Committed? | Why |
|----------|-------|------------|-----|
| `context.db` (SQLite) | Whatson container | ❌ | Binary, merge conflicts, bloats git |
| `data/raw/` (uploaded files) | Whatson container | ❌ | Large binaries don't belong in git |
| `SESSION-STATE.md` | Whatson container | ❌ | Ephemeral working state |
| `docs/context/INDEX.md` | Target repo | ✅ | Top-level summary (≤200 lines) |
| `docs/context/topics/*.md` | Target repo | ✅ | Per-topic fact summaries |
| `docs/context/sources/*.md` | Target repo | ✅ | Per-source extraction summaries |

Raw files stay local. Extracted knowledge is committed as structured markdown.

### 7.3 Repository structure

In the target project:

```
<target-repo>/
├── CLAUDE.md              ← pointer: "Read docs/context/INDEX.md for project context"
├── AGENTS.md              ← pointer (same)
├── docs/
│   └── context/           ← Whatson's shared knowledge layer
│       ├── INDEX.md        # Top-level summary, updated on each consolidation
│       ├── topics/         # Per-topic fact summaries
│       │   ├── architecture.md
│       │   ├── database.md
│       │   └── deployment.md
│       └── sources/        # Per-source extraction summaries
│           ├── 2026-04-11_architecture-review.md
│           ├── 2026-04-11_wiki-arch-decisions.md
│           └── 2026-04-12_jira-PROJ-42.md
└── src/                    ← rest of the project (read-only for Whatson)
```

### 7.4 Source summaries format

When a file or URL is ingested, the extracted knowledge is committed as a structured markdown file:

```markdown
# architecture-review.pdf

> Ingested: 2026-04-11 | Source: telegram:@denis | Confidence: high

## Summary
Architecture review for Project X. Covers microservices decomposition,
database choice (PostgreSQL), deployment strategy (K8s).
Recommends splitting auth into a separate service.

## Extracted Facts
- Database: PostgreSQL (decision, high confidence)
- Deployment: Kubernetes (decision, high confidence)
- Auth service: recommended to split out (opinion, medium confidence)

## Original
File: architecture-review.pdf (420KB, uploaded 2026-04-11)
```

### 7.5 Agent discovery

Other AI agents find the context automatically via two mechanisms:

**1. Natural discovery** — `docs/context/` is inside `docs/`, which agents already scan.

**2. Explicit pointer** — add to the target project's instruction files:

```markdown
# In CLAUDE.md or AGENTS.md of the target repo
## Project Context
Structured project context maintained by Whatson is in `docs/context/INDEX.md`.
Read it before starting work — it contains current decisions, facts, and source summaries.
```

### 7.6 Commit flow

Consolidation (Phase 4) exports knowledge to the target repo:

```
Consolidation runs (daily cron or manual)
  ├─→ Phase 1-3: normal (local SQLite)
  └─→ Phase 4: Prune & Index
        ├─→ Update docs/context/INDEX.md
        ├─→ Export per-topic summaries to docs/context/topics/*.md
        ├─→ Export per-source summaries to docs/context/sources/*.md
        ├─→ git add docs/context/
        ├─→ git commit -m "whatson: consolidation 2026-04-11"
        └─→ git push origin main (or open PR)
```

### 7.7 Access control

GitHub does not support folder-level permissions. Options by maturity:

| Stage | Approach | How |
|-------|----------|-----|
| **POC** | Convention + trust | Fine-grained PAT scoped to the repo. Agent instructed to only write to `docs/context/`. Enforcement in AGENTS.md |
| **Production** | GitHub App + PR flow | Whatson pushes to a branch, opens PR. Humans or CI merge. Auditable, safe |

### 7.8 Configuration

```env
# In Whatson's .env
TARGET_REPO=git@github.com:org/project.git
WHATSON_CONTEXT_DIR=docs/context
GITHUB_TOKEN=ghp_...
```

The target repo is cloned/pulled into a working directory inside the container. Whatson reads the full repo for context, writes only to `docs/context/`.

---

## Part 8: Drift Analysis — Implementation vs. Decisions Consistency

> Added: 2026-04-12
> Status: Planned (POC uses Claude Code CLI; production path documented below)

### 8.1 Goal

After each consolidation, automatically analyze the target codebase against recorded decisions and facts. When the model finds inconsistencies (e.g. a decision says "use PostgreSQL 16" but the code uses SQLite, or a task tracker says "done" but the feature is missing), it produces structured questions for stakeholders.

### 8.2 POC approach — Claude Code CLI

Install `claude` (or `@anthropic-ai/claude-code` npm package) in the container. Add a Phase 5 to consolidation that shells out:

```
claude -p "<analysis prompt with facts>" \
  --model claude-opus-4-6 \
  --allowedTools "Read,Grep,Glob,Bash(git log:*),Bash(ls:*)" \
  --output-format json
```

Each run:
1. Export high-confidence decisions + recent facts as context
2. Claude Code explores the cloned target repo (already at `data/target-repo/`)
3. Collect findings as `{ fact_id, consistent: bool, evidence, question? }`
4. Store in DB, surface via Telegram + MCP tool

**Cost estimate:** ~$0.50–2.00/run with Opus. Daily = ~$15–60/month.

### 8.3 Production path — what it takes to replace Claude Code with a native loop

Analysis of Claude Code's source (see Part 6) reveals four components needed:

#### What we already have (via OpenClaw)

| Component | Status |
|-----------|--------|
| Agent loop (model → tool calls → execute → repeat) | OpenClaw provides this natively |
| Tool protocol | MCP — proven with context-agent |
| Model access | Anthropic API (Opus, Sonnet, Haiku) |
| Session management | OpenClaw isolated sessions |
| Knowledge base | context-agent (facts, consolidation, sync) |

#### What's missing — three gaps

**Gap 1: Filesystem MCP server for the target repo (~150 LOC, small effort)**

The agent needs tools to explore code. Minimal tool set:

| Tool | Purpose |
|------|---------|
| `read_file({ path })` | Read file contents |
| `search({ pattern, path, glob? })` | Grep for patterns |
| `find_files({ glob })` | Find files by name pattern |
| `list_dir({ path })` | Directory listing |

Options: write a thin MCP server (~150 LOC), or use `@modelcontextprotocol/server-filesystem`. Point it at the cloned target repo.

**Gap 2: Context window management (large effort, the hard part)**

This is Claude Code's core differentiator (see §6.4 Compact service). An analysis session may read 30+ files, overflowing the context window. Claude Code handles this with:

- Token counting per message
- Streaming summarization of old tool results when approaching the limit
- Re-injection of system prompt + attachments after compression
- Allowing re-reads of files post-compression

**POC workaround:** Run N short, focused agent turns instead of one long session. Each turn analyzes one fact/decision against the code:

```
for each fact in high_confidence_decisions:
  result = openclaw_agent_turn(
    prompt: "Verify: '{fact.content}'. Search the codebase for evidence.",
    tools: [filesystem-mcp, context-agent],
    model: opus,
    timeout: 60s
  )
  collect result.findings
```

Each turn stays within context limits. Trades cross-fact reasoning for reliability. Good enough for 80% of drift detection.

**Production solution:** Implement a compact/summarization service inspired by Claude Code's `services/compact/` (see §6.4). This enables long multi-file reasoning chains. Estimated effort: 2-3 days, requires careful token counting and prompt engineering for summaries.

**Gap 3: Analysis prompt (small effort, iterative)**

System instructions specialized for drift detection:

```markdown
You are verifying whether a codebase matches stated project decisions.

For the decision you're given:
1. Search the codebase for related files (grep keywords, domain terms)
2. Read relevant files (configs, schemas, code)
3. Compare implementation vs. the stated decision
4. Check for partial implementations or contradictions

Output JSON:
{ "consistent": bool, "evidence": "file:line — what you found", "question": "..." }

Be specific. Cite file:line. Ignore style — only flag semantic drift.
```

### 8.4 Phased rollout

| Phase | Approach | Effort | Quality |
|-------|----------|--------|---------|
| **POC (now)** | Claude Code CLI shelled out from Phase 5 | 1 day | High (full agentic loop) |
| **v1** | Filesystem MCP + per-fact OpenClaw agent turns | 2-3 days | Good (80%, no cross-fact) |
| **v2** | Add compact service for long reasoning chains | 3-5 days | High (matches Claude Code) |
| **v3** | Task tracker integration (Linear/Jira MCP) | 1-2 days | Full coverage |

### 8.5 Output schema

```sql
CREATE TABLE drift_findings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at          TEXT NOT NULL,
  fact_id         INTEGER NOT NULL REFERENCES facts(id),
  consistent      BOOLEAN NOT NULL,
  evidence        TEXT,
  question        TEXT,          -- NULL if consistent
  addressed       BOOLEAN DEFAULT FALSE,
  addressed_at    TEXT,
  FOREIGN KEY (fact_id) REFERENCES facts(id)
);
```

Surfaced via:
- `context-agent__get_drift_report` MCP tool
- Telegram message after consolidation (summary of inconsistencies)
- Written to `docs/context/DRIFT.md` in the target repo on sync

---

## Part 9: Operational Findings & Next Steps

> Added: 2026-04-13

### 9.1 Telegram poller stall — diagnosis and partial mitigation

**Symptom:** `getUpdates` long-polls hang for 750s–5500s while the gateway HTTP stays up, so Docker reported the container `healthy` through the entire failure. Worst observed stall: 73 minutes.

**Root cause:** network-level flakiness between the Docker bridge and `api.telegram.org`, surfacing as `UND_ERR_SOCKET` in undici. The Telegram plugin (inside the OpenClaw base image, not this repo) already has a stall detector and self-restart logic, but its recovery itself gets stuck (`Polling runner stop timed out after 15s`).

**Mitigation shipped — observability only:**
- [tools/gateway-healthcheck.sh](tools/gateway-healthcheck.sh) — local `/healthz` + `api.telegram.org` reachability check.
- [docker-compose.yml](docker-compose.yml) — wired as the gateway healthcheck (60s interval, 15s timeout, 3 retries).
- **Does not auto-recycle.** Docker's `restart: unless-stopped` doesn't act on `unhealthy` alone. During a stall, `docker ps` now correctly shows `unhealthy`; a human still runs `docker compose restart openclaw-gateway`.

**Deferred:** auto-recycling via `willfarrell/autoheal` sidecar was prototyped and reverted — it added a new service + docker-socket mount for a feature that isn't critical yet. Revisit if manual recycling becomes a burden.

**Not yet investigated:** the underlying network/DNS/IPv6 issue. Lower urgency now that unhealthy state is at least visible.

### 9.2 Storage migration — sql.js → better-sqlite3 + FTS5

**Motivation — two real smells in [skills/context-agent/src/storage.ts](skills/context-agent/src/storage.ts):**
1. `saveDb()` rewrites the entire database on every mutation ([storage.ts:121-127](skills/context-agent/src/storage.ts#L121-L127)). sql.js has no incremental persistence — O(db size) per write, will get painful as the fact corpus grows.
2. `searchFacts` uses `LIKE '%kw%'` ([storage.ts:314-333](skills/context-agent/src/storage.ts#L314-L333)). No tokenization, no ranking — the retrieval ceiling.

**Decision: migrate to better-sqlite3 + FTS5 (no vector search in phase 1).**

- Schema unchanged. All existing tables, types, and bitemporal semantics survive verbatim.
- Drop `async` from storage functions. sql.js was only async because of WASM init; SQLite is synchronous. A simplification, not a refactor.
- Fixes the whole-file-rewrite problem (better-sqlite3 does real incremental writes).
- FTS5 is compiled into better-sqlite3 by default — no extension loading, no Docker wrinkle. Replaces `LIKE` with ranked keyword search.
- Native addon concern is bounded: better-sqlite3 ships prebuilt binaries for linux x64/arm64; `npm install` works without a build toolchain.

**Options considered and rejected:**

| Option | Why rejected |
|---|---|
| Keep sql.js | The two smells above are the bottlenecks blocking the next roadmap items |
| libSQL (embedded) | TypeScript client panics on parameterized FTS5 inserts — [tursodatabase/libsql#1811](https://github.com/tursodatabase/libsql/issues/1811), open since Dec 2024, no maintainer triage in 16+ months. External-content FTS5 via triggers might sidestep it, but building on an untriaged crash bug in our exact codepath is a code smell, and the maintainer silence is a priority signal about the embedded TS surface. |
| PGLite + pgvector | New runtime dep, schema migration, overkill for current scale. Revisit when multi-agent writes or ≫10M facts become real. |
| GBrain as storage | See §9.3 — different schema, different domain. |

### 9.3 GBrain evaluation — pattern, not dependency

[github.com/garrytan/gbrain](https://github.com/garrytan/gbrain): agent knowledge base on Postgres + pgvector, hybrid search via reciprocal rank fusion (RRF), explicit OpenClaw support.

**Overlap:** both are agent memory on markdown + OpenClaw. **Divergence:** Whatson is project-context-centric (bitemporal facts, decisions, drift, typed relations). GBrain is person/meeting-centric (personal knowledge, voice, email/calendar). Schemas don't align — adopting GBrain as storage means either forking it or running two schemas in one DB, which is worse than the current sql.js.

**Conclusion: adopt the pattern, not the project.**

- Borrow the hybrid-search approach (keyword + vector + RRF) when we implement vector search in Phase 2.
- Do not depend on GBrain as a library or storage backend — couples our roadmap to another project's release cadence for no structural gain.

**Phase 2 (deferred, separate change):** add vector search via the `sqlite-vec` loadable extension + ~30 lines of RRF fusion in TypeScript. Sequenced after Phase 1 so each change is independently verifiable.

### 9.4 Revised near-term roadmap

1. ~~**Storage: sql.js → better-sqlite3 + FTS5** (§9.2).~~ **Done** (2026-04-13). Incremental writes + FTS5 BM25 keyword search.
2. **LLM-powered consolidation** (Part 11) — the primary-goal blocker. Semantic duplicate detection + contradiction resolution. FTS5 retrieval is sufficient to find candidate clusters.
3. **Vector search via sqlite-vec + RRF** (Part 10) — improves retrieval quality, but not blocking. Detailed plan in §10.
4. **Proactive gap detection** — unblocked by (1) + (2).
5. **Multi-source ingestion** (GitHub PRs/issues, repo markdown) — after retrieval quality is solid.
6. **Telegram network root-cause investigation** (§9.1) — deprioritized now that unhealthy state is visible.

---

## Part 10: Vector Search — sqlite-vec + Embeddings + RRF

> Added: 2026-04-13
> Status: Planned (Phase 2 of retrieval upgrade; Phase 1 = FTS5, done)
> Depends on: §9.2 better-sqlite3 migration (done)

### 10.1 Goal

Add semantic (vector) search to the fact corpus. Combine it with the existing FTS5 keyword search using Reciprocal Rank Fusion (RRF), borrowing the hybrid-search pattern from GBrain (§9.3). This upgrades retrieval from "exact keyword match" to "meaning-aware search" — critical for LLM-powered consolidation (finding semantic duplicates) and drift detection (matching decisions to code patterns).

### 10.2 Architecture overview

```
Query: "What database did we choose?"
  │
  ├─→ FTS5 MATCH (keyword, BM25 ranked)  ──→ ranked list A
  │
  ├─→ sqlite-vec KNN (cosine, k=20)      ──→ ranked list B
  │
  └─→ RRF fusion (merge A + B)           ──→ final ranked list
        │
        └─→ confidence + recency tiebreak ──→ returned to caller
```

Both search paths query the same `facts` table. FTS5 via the existing `facts_fts` virtual table; vector via a new `fact_embeddings` vec0 virtual table. Fusion happens in TypeScript (~30 lines), not SQL.

### 10.3 Embedding model selection

**Decision: Voyage AI `voyage-3-lite` (512 dimensions)**

| Option | Dims | Cost/1M tokens | SDK | Verdict |
|--------|------|----------------|-----|---------|
| Voyage `voyage-3-lite` | 512 | $0.02 | `voyageai` npm | **Selected** |
| Voyage `voyage-3` | 1024 | $0.06 | `voyageai` npm | Overkill for short facts |
| OpenAI `text-embedding-3-small` | 1536 (or 512 via `dimensions`) | $0.02 | `openai` npm | Adds second AI vendor dependency |
| Ollama `nomic-embed-text` | 768 | Free | HTTP to localhost | Adds infra (sidecar container) |
| Jina `jina-embeddings-v3` | 1024 | $0.02 (free tier: 1M) | HTTP | Less mature ecosystem |

**Why Voyage:**
- Anthropic's recommended embedding partner — stays in the same vendor ecosystem as our Haiku/Opus usage.
- 512 dimensions is optimal for our corpus (short text snippets, hundreds to low thousands of facts). Higher dims waste storage with no retrieval benefit at this scale.
- Cost is negligible: ~100 facts × ~50 tokens each = 5,000 tokens per embedding batch. At $0.02/1M tokens, that's effectively free.
- The `voyageai` npm package follows the OpenAI API shape (`POST /v1/embeddings`), so swapping providers later is trivial.

**Configuration:**
```env
# In .env
VOYAGE_API_KEY=pa-...
WHATSON_EMBEDDING_MODEL=voyage-3-lite    # default
WHATSON_EMBEDDING_DIMS=512               # default, must match vec0 table
```

**Fallback behavior:** If `VOYAGE_API_KEY` is not set, embedding is skipped entirely. FTS5 keyword search continues to work alone. No crash, no degradation of existing functionality.

### 10.4 Schema changes

**New vec0 virtual table** (created in `migrateSqliteVec()`, called from `migrate()`):

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS fact_embeddings USING vec0(
  fact_id INTEGER PRIMARY KEY,
  embedding float[512]
);
```

- `fact_id` maps to `facts.id` (not a FOREIGN KEY — vec0 doesn't support them, enforced in application code).
- `float[512]` = 512 × 4 bytes = 2KB per fact. At 10,000 facts = 20MB — trivial.
- No triggers needed (unlike FTS5 external-content mode). Embeddings are inserted explicitly after the fact is saved + embedded.

**No changes to existing tables.** The `facts`, `facts_fts`, `fact_relations`, `consolidation_log`, `drift_findings` tables are untouched.

### 10.5 Extension loading

sqlite-vec is a loadable SQLite extension. The `sqlite-vec` npm package exports a `load()` helper:

```typescript
import * as sqliteVec from "sqlite-vec";
import Database from "better-sqlite3";

const db = new Database("context.db");
sqliteVec.load(db);  // registers vec0, vec_distance_cosine, etc.
```

**When to load:** In `getDb()` after opening the database, before `migrate()`. Guarded by a try/catch — if sqlite-vec is not installed (e.g., in a test environment that doesn't need it), log a warning and skip. Vector search returns empty results; FTS5 still works.

**Docker:** sqlite-vec ships prebuilt binaries for linux-x64 via npm. The extension is pure C with zero dependencies, so Debian Bookworm compatibility is not a concern. `pnpm install` in the entrypoint handles it — same pattern as better-sqlite3.

### 10.6 Embedding pipeline

**When embeddings are generated:**

1. **On `insertFact()`** — after the fact is inserted into SQLite, embed it asynchronously. If the API call fails, the fact is saved without an embedding (logged, not fatal). A background backfill can catch up later.

2. **On startup (backfill)** — query for facts that exist in `facts` but not in `fact_embeddings`. Embed in batches of 50. This handles:
   - Existing facts from before sqlite-vec was added (migration path).
   - Facts where the embedding API call failed on insert.
   - Re-embedding after a model change (delete all from `fact_embeddings`, restart).

3. **On consolidation** — when facts are merged/superseded, delete the expired fact's embedding. The surviving fact's embedding is already present.

**Embedding function:**

```typescript
// In a new file: src/embeddings.ts (~80 lines)

export async function embedText(text: string): Promise<Float32Array | null> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) return null;
  
  const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.WHATSON_EMBEDDING_MODEL ?? "voyage-3-lite",
      input: [text],
      output_dimension: Number(process.env.WHATSON_EMBEDDING_DIMS ?? 512),
    }),
  });
  
  const json = await resp.json();
  return new Float32Array(json.data[0].embedding);
}

export async function embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
  // Voyage supports batch embedding (up to 128 inputs per call)
  // Chunk into batches of 50 to stay well under limits
}
```

**Why `fetch` instead of the `voyageai` npm package:** One less dependency. The API is a single POST endpoint. The package adds type safety we can get with 5 lines of interface.

### 10.7 Vector search

**KNN query via vec0:**

```sql
SELECT fact_id, distance
FROM fact_embeddings
WHERE embedding MATCH ?  -- Float32Array of the query embedding
  AND k = ?              -- number of nearest neighbors
ORDER BY distance
```

**Important vec0 constraints:**
- `k = N` goes in the WHERE clause, not LIMIT.
- Distance metric is L2 (Euclidean) by default. For cosine similarity, use `vec_distance_cosine()` as a scalar reranker, or normalize vectors before insertion (unit vectors make L2 ≈ cosine ranking).
- Metadata WHERE operators: `=`, `!=`, `>`, `>=`, `<`, `<=` only. No LIKE, no IS NULL, no functions.

**Decision: normalize to unit vectors at insert time.** This makes L2 distance equivalent to cosine distance ranking, avoiding a post-hoc rerank step. The normalization is 3 lines in TypeScript.

### 10.8 Reciprocal Rank Fusion (RRF)

The GBrain pattern for combining keyword and vector results:

```typescript
// In retrieval.ts — replaces the current keyword-only search

function reciprocalRankFusion(
  ftsResults: { id: number; rank: number }[],
  vecResults: { id: number; rank: number }[],
  k: number = 60  // RRF constant (standard value)
): Map<number, number> {
  const scores = new Map<number, number>();
  
  for (const { id, rank } of ftsResults) {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
  }
  for (const { id, rank } of vecResults) {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
  }
  
  return scores;  // sort by score DESC to get final ranking
}
```

**How it's used in `retrieve()`:**

1. Run FTS5 search (existing `searchFacts()`) → ranked list A.
2. Embed the query → run vec0 KNN → ranked list B.
3. RRF-merge A and B → combined scores.
4. Fetch full `Fact` rows for the top N IDs.
5. Apply confidence + recency tiebreak (existing logic).
6. Build context block (existing logic).

**Graceful degradation:**
- If `VOYAGE_API_KEY` not set → vector search skipped, FTS5 only (current behavior).
- If sqlite-vec not loaded → vector search skipped, FTS5 only.
- If embedding API fails → vector search skipped for that query, FTS5 only.
- FTS5 is always the baseline. Vector search only improves results, never degrades them.

### 10.9 Files changed

| File | Change | Lines (est.) |
|------|--------|-------------|
| `package.json` | Add `sqlite-vec` dependency | +1 |
| `src/embeddings.ts` | **New file.** `embedText()`, `embedBatch()`, `backfillEmbeddings()`, vector normalization | ~80 |
| `src/storage.ts` | Load sqlite-vec extension in `getDb()`. Add `migrateSqliteVec()`. Add `insertFactEmbedding()`, `searchFactsByVector()`, `deleteFactEmbedding()` | ~50 |
| `src/retrieval.ts` | Add `reciprocalRankFusion()`. Update `retrieve()` to run both searches and merge. | ~40 |
| `src/consolidation.ts` | Call `deleteFactEmbedding()` when expiring a fact | +2 |
| `.env.example` | Add `VOYAGE_API_KEY`, `WHATSON_EMBEDDING_MODEL`, `WHATSON_EMBEDDING_DIMS` | +3 |
| `docker-compose.yml` | Pass `VOYAGE_API_KEY` to container | +1 |

**Not changed:** `wal.ts`, `llm-extract.ts`, `mcp-server.ts`, `drift.ts`, `repo-sync.ts`, `cli.ts`, `index.ts`, test files (except new `embeddings.test.ts`).

### 10.10 Testing strategy

1. **Unit tests (`embeddings.test.ts`):**
   - `embedText()` with mocked fetch → returns Float32Array of correct dimensions.
   - `embedText()` without `VOYAGE_API_KEY` → returns null.
   - Vector normalization → unit length.
   - `embedBatch()` chunking logic.

2. **Integration tests (`storage.ts` additions to existing test file):**
   - `insertFactEmbedding()` → row appears in `fact_embeddings`.
   - `searchFactsByVector()` → returns nearest neighbors in distance order.
   - `deleteFactEmbedding()` → row removed.
   - sqlite-vec not loaded → `searchFactsByVector()` returns `[]`.

3. **RRF tests (`retrieval.ts`):**
   - Two ranked lists → fusion produces expected order.
   - One list empty → other list's ranking preserved.
   - Overlapping IDs → boosted in combined ranking.

4. **Backfill test:**
   - Insert 3 facts without embeddings → `backfillEmbeddings()` fills them.
   - Insert 3 facts, 1 already embedded → backfill skips the existing one.

### 10.11 Migration path for existing data

1. On first startup after deploy, `migrateSqliteVec()` creates the `fact_embeddings` table (empty).
2. `backfillEmbeddings()` runs on startup — detects facts missing from `fact_embeddings`, embeds in batches.
3. Until backfill completes, vector search returns partial results; FTS5 covers the gap.
4. For the current corpus (~1 fact in the existing `context.db`), backfill is instant.

### 10.12 Cost projection

| Scenario | Facts | Tokens | Cost |
|----------|-------|--------|------|
| Current POC | ~10 | ~500 | < $0.01 |
| After 1 month | ~200 | ~10,000 | < $0.01 |
| After 1 year | ~2,000 | ~100,000 | < $0.01 |
| Re-embed all (model change) | 2,000 | ~100,000 | < $0.01 |
| Query embeddings (100/day) | — | ~5,000/day | < $0.01/day |

At $0.02/1M tokens, embedding costs are negligible for this project's scale.

### 10.13 Implementation order

1. Add `sqlite-vec` dependency, load extension in `getDb()`, create vec0 table in migration. Verify: `SELECT vec_version()` works.
2. Create `src/embeddings.ts` — `embedText()`, `embedBatch()`, normalization. Verify: unit tests with mocked fetch.
3. Add `insertFactEmbedding()`, `searchFactsByVector()`, `deleteFactEmbedding()` to storage.ts. Verify: integration tests with real sqlite-vec.
4. Update `retrieval.ts` — add RRF, update `retrieve()`. Verify: RRF unit tests + end-to-end with query embedding.
5. Wire `insertFact()` → embed → `insertFactEmbedding()` flow. Verify: inserting a fact with `VOYAGE_API_KEY` set produces an embedding row.
6. Add `backfillEmbeddings()` to startup. Verify: existing facts get embedded.
7. Update `.env.example`, `docker-compose.yml`. Verify: container starts cleanly.

### 10.14 Open questions

- **Voyage model version:** `voyage-3-lite` is listed as an older model. Should we use `voyage-3` (1024d, $0.06/1M) instead for better quality? At our scale the cost difference is irrelevant. **Recommendation:** start with `voyage-3-lite` at 512d; switchable via env var, no schema migration needed (just rebuild embeddings).
- **Embedding on insert vs. batch-only:** Inline embedding on `insertFact()` adds ~100ms latency per fact insert (API round trip). For Telegram ingestion this is fine (user doesn't notice). For bulk imports, batch mode would be faster. **Recommendation:** inline first, add batch endpoint if bulk import becomes a use case.
- **Query embedding caching:** Should we cache query embeddings for repeated searches? **Recommendation:** no — queries are rare, the API is fast (<100ms), and caching adds complexity. Revisit if query volume grows.

---

## Part 11: LLM-Powered Consolidation

> Added: 2026-04-13
> Status: Planned (roadmap item #2, primary-goal blocker)
> Depends on: §9.2 better-sqlite3 + FTS5 (done)

### 11.1 Goal

Replace the heuristic Phase 3 (`consolidate()` in `consolidation.ts:118-174`) with LLM-based semantic analysis. The current implementation has two ceilings:

1. **Duplicate detection** uses `normalize()` exact string match (`consolidation.ts:132-134`). "We chose Postgres" and "Database decision: PostgreSQL" are not detected as duplicates.
2. **Contradiction detection** uses `contentOverlaps()` word-overlap heuristic (`consolidation.ts:180-184`). Two words of length >4 matching is both too loose (false positives on unrelated facts sharing common domain words) and too tight (misses semantic contradictions with different vocabulary).

The gap analysis in §6.8 rates both as "Critical." This is the bottleneck that blocks the primary goal: **"maintains coherence at scale."**

### 11.2 What changes, what doesn't

| Component | Changes? | Notes |
|-----------|----------|-------|
| Phase 1: Orient | No | Unchanged |
| Phase 2: Gather Signal | No | Unchanged |
| **Phase 3: Consolidate** | **Yes** | Heuristic → LLM. Core of this plan |
| Phase 4: Prune & Index | No | Unchanged |
| Phase 5: Drift Analysis | No | Benefits from better input (cleaner fact base) |
| `ConsolidationSummary` interface | No | Same shape returned to callers |
| `consolidation_log` writes | No | Same schema |
| `runConsolidation()` entry point | Minimal | Calls new `consolidate()`, same signature |

**Scope is surgical:** only the `consolidate()` function body and its helpers (`normalize()`, `contentOverlaps()`) are replaced. Everything above and below it stays.

### 11.3 Design: cluster → LLM → act

```
Phase 3 input: newFacts[] + allFacts[]
  │
  ├─ 1. Cluster: group facts by topic
  │     For each new fact:
  │       FTS5 search(fact.content) against allFacts → candidate cluster
  │       Add tag-matched facts that FTS5 missed
  │       Cap cluster size at 20 facts
  │
  ├─ 2. LLM call (one per cluster, Haiku):
  │     Input: the cluster of facts (id, content, source_type, confidence, date)
  │     Output: JSON array of actions:
  │       { action: "merge", keep: id, expire: [ids], reason: "..." }
  │       { action: "contradict", keep: id, expire: [ids], reason: "..." }
  │       { action: "relate", ids: [id, id], relation: "supports|related", reason: "..." }
  │       { action: "keep", id: id }  (no change needed)
  │
  └─ 3. Execute actions:
        merge → expireFact(expired, kept) + insertRelation(supersedes)
        contradict → expireFact(old, new) + insertRelation(contradicts)
        relate → insertRelation(supports/related)
        keep → no-op
```

### 11.4 Clustering strategy

The cluster quality determines the LLM's ability to find duplicates. Two complementary methods:

**Method A — FTS5 search (primary):** For each new fact, use `searchFacts(fact.content)` to find semantically similar active facts. FTS5 with Porter stemming handles inflections ("decided" → "decide") and ranks by BM25 relevance. Top 15 results form the initial cluster.

**Method B — Tag overlap (supplement):** Facts sharing ≥1 tag with the new fact are added if not already in the cluster. Caps the cluster at 20 total.

**Deduplication across clusters:** A fact may appear in multiple clusters (e.g., it's relevant to two new facts). Track processed fact IDs across clusters to avoid redundant LLM analysis. If a fact was already expired by a previous cluster's action, skip it.

**Why not one giant LLM call for all facts?** Cost and reliability. A corpus of 200 facts × ~50 tokens = 10,000 tokens input. Haiku handles this, but the output quality degrades with large, unfocused inputs. Focused clusters of 5-20 facts produce more reliable decisions.

### 11.5 LLM prompt

```
You are a knowledge base consolidation agent. You are given a cluster of facts
from a project knowledge base. Each fact has an ID, content, type, confidence,
and date.

Your task is to analyze the cluster and identify:

1. **Duplicates** — facts that express the same information in different words.
   Keep the most complete/recent version. Expire the others.

2. **Contradictions** — facts that make conflicting claims about the same topic.
   Keep the most recent or most authoritative (higher confidence). Expire the
   contradicted fact. If you can't determine which is correct, keep both and
   mark them as related (the human will resolve).

3. **Relations** — facts that support or are related to each other but are not
   duplicates. Link them.

Rules:
- A "correction" type always supersedes a non-correction on the same topic.
- Higher confidence supersedes lower confidence, all else equal.
- More recent supersedes older, all else equal.
- When in doubt, keep both facts — false merges lose data, false keeps don't.
- Do NOT invent new facts or modify existing fact text.

Respond with a JSON array of actions:

[
  {"action": "merge", "keep": 5, "expire": [3, 8], "reason": "Same decision about PostgreSQL"},
  {"action": "contradict", "keep": 12, "expire": [2], "reason": "Correction supersedes original"},
  {"action": "relate", "ids": [5, 14], "relation": "supports", "reason": "Both about DB choice"},
  {"action": "keep", "id": 7}
]

If no actions are needed, respond with: []
```

The prompt emphasizes **conservatism** ("when in doubt, keep both"). False merges lose data; false keeps just add noise that a future consolidation can fix.

### 11.6 Model choice

**Decision: Haiku (`claude-haiku-4-5-20251001`)** — same model as `llm-extract.ts`.

| Model | Cost (input/output per 1M tokens) | Speed | Quality for this task |
|-------|----------------------------------|-------|----------------------|
| Haiku 4.5 | $0.80 / $4.00 | ~50ms TTFT | Sufficient — structured comparison of short texts |
| Sonnet 4.6 | $3.00 / $15.00 | ~100ms TTFT | Better but 4× cost, not justified for fact comparison |
| Opus 4.6 | $15.00 / $75.00 | ~200ms TTFT | Overkill |

**Cost per consolidation run:**
- Cluster count: ~5-20 (depends on new fact volume since last run)
- Input per cluster: ~500-1500 tokens (5-20 facts × 50-80 tokens each + prompt)
- Output per cluster: ~100-300 tokens (action list)
- Total per run: ~10,000-30,000 tokens input + ~2,000-5,000 output
- Cost per run: ~$0.01-0.03
- Daily at 03:00: ~$0.30-0.90/month

Negligible compared to drift analysis ($15-60/month at §8.2).

### 11.7 Fallback behavior

Following the pattern from `llm-extract.ts:99-101`:

1. If `ANTHROPIC_API_KEY` not set → fall back to current heuristic (`normalize()` + `contentOverlaps()`).
2. If LLM call fails (network, rate limit, malformed response) → fall back to heuristic for that cluster, log warning, continue.
3. If LLM returns unparseable JSON → skip that cluster (conservative: keep all facts), log warning.

**No new env var needed.** The fallback is automatic — if the API key exists (which it does, it's required for the gateway), LLM consolidation is active. The heuristic becomes the degraded-mode path, not the primary path.

### 11.8 Response parsing

Reuse the defensive parsing pattern from `llm-extract.ts:145-192`:

```typescript
interface ConsolidationAction {
  action: "merge" | "contradict" | "relate" | "keep";
  keep?: number;         // fact ID to keep (merge/contradict)
  expire?: number[];     // fact IDs to expire (merge/contradict)
  ids?: number[];        // fact IDs to relate (relate)
  relation?: RelationType;
  reason?: string;
  id?: number;           // fact ID (keep)
}

function parseConsolidationResponse(text: string): ConsolidationAction[] {
  // 1. Strip markdown code fences if present
  // 2. JSON.parse, falling back to regex array extraction
  // 3. Validate each action: required fields, valid IDs, valid action type
  // 4. Reject actions referencing unknown fact IDs (safety)
  // 5. Return validated actions; skip malformed entries
}
```

**Critical safety check:** Every fact ID in the response must exist in the input cluster. The LLM cannot reference facts it wasn't shown. This prevents hallucinated IDs from corrupting the database.

### 11.9 Files changed

| File | Change | Lines (est.) |
|------|--------|-------------|
| `src/consolidation.ts` | Replace `consolidate()` internals. Add `clusterFacts()`, `consolidateCluster()`, `parseConsolidationResponse()`. Keep `normalize()` and `contentOverlaps()` as heuristic fallback. | ~120 net new |
| `src/consolidation.test.ts` | Add LLM consolidation tests with mocked Anthropic client. Keep existing heuristic tests (they now test the fallback path). | ~80 net new |

**Not changed:** `storage.ts`, `retrieval.ts`, `wal.ts`, `llm-extract.ts`, `mcp-server.ts`, `drift.ts`, `repo-sync.ts`, `cli.ts`, `index.ts`, `package.json`, `docker-compose.yml`, `.env.example`.

No new dependencies. Uses the existing `@anthropic-ai/sdk` (already in `package.json`).

### 11.10 Testing strategy

**1. Unit tests — LLM response parsing:**
- Valid actions array → parsed correctly.
- Markdown-fenced JSON → extracted and parsed.
- Malformed JSON → returns empty (skip cluster).
- Actions with unknown fact IDs → those actions filtered out.
- Mixed valid/invalid actions → valid ones preserved.

**2. Unit tests — clustering:**
- 3 facts, 2 share keywords → grouped in one cluster.
- 3 facts, 2 share tags but no keywords → grouped by tag.
- Cluster capped at 20 facts.
- Already-processed facts not re-clustered.

**3. Integration tests — LLM consolidation (mocked client):**
- Two semantically identical facts ("We use Postgres" / "Database: PostgreSQL") → LLM returns merge action → older fact expired, relation inserted.
- Correction supersedes existing fact → LLM returns contradict action → original expired.
- Unrelated facts → LLM returns keep actions → no changes.
- LLM call fails → falls back to heuristic → existing heuristic tests still pass.

**4. Existing tests preserved:**
- All current `consolidation.test.ts` tests continue to pass. They test behaviors that both the heuristic and LLM paths should produce (exact duplicates merged, corrections supersede, stale pruned, empty DB handled). The LLM path should be at least as good as the heuristic.

### 11.11 Implementation order

1. **Extract Anthropic client helper.** `llm-extract.ts` has `getClient()` / `_setClientForTest()`. Extract to a shared `src/anthropic.ts` (or import directly from `llm-extract.ts` if clean). Avoid duplicating the client singleton.
2. **Write `clusterFacts()`.** Input: `newFacts[], allFacts[]`. Output: `Fact[][]` (array of clusters). Uses `searchFacts()` + tag overlap. Add unit tests.
3. **Write `consolidateCluster()`.** Input: one cluster (`Fact[]`). Output: `ConsolidationAction[]`. Makes one Haiku call, parses response. Add unit tests with mocked client.
4. **Write `parseConsolidationResponse()`.** Defensive JSON parsing + ID validation. Add unit tests.
5. **Replace `consolidate()` body.** Call `clusterFacts()` → for each cluster, `consolidateCluster()` → execute actions. Heuristic fallback on failure. Run full test suite.
6. **Manual verification.** Insert 10 facts via Telegram with known duplicates and contradictions. Run `/consolidate`. Verify merged/contradicted facts in the DB and INDEX.md.

### 11.12 Success criteria

1. **Semantic duplicates detected:** "We decided to use PostgreSQL" and "Database choice: Postgres" → merged (one expired, relation inserted). Current heuristic misses this.
2. **Semantic contradictions detected:** "We use Redis for caching" and "Memcached is our caching layer" → contradiction flagged, newer/higher-confidence kept. Current heuristic only catches explicit `correction` types.
3. **All existing tests green.** No regression.
4. **Graceful degradation.** Unset `ANTHROPIC_API_KEY` → heuristic path, same behavior as today.
5. **Cost per run < $0.05.** Verified via Anthropic dashboard after a real run.

---

## References

| Resource | URL |
|----------|-----|
| OpenClaw docs | https://docs.openclaw.ai |
| OpenClaw Docker | https://docs.openclaw.ai/install/docker |
| OpenClaw Telegram | https://docs.openclaw.ai/channels/telegram |
| OpenClaw Configuration | https://docs.openclaw.ai/gateway/configuration |
| OpenClaw Skills | https://docs.openclaw.ai/tools/skills |
| OpenClaw Cron | https://docs.openclaw.ai/automation/cron-jobs |
| MemPalace (reference) | https://github.com/milla-jovovich/mempalace |
| Auto Dream (reference) | https://claudefa.st/blog/guide/mechanics/auto-dream |
| Echo Libero (reference) | https://echolibero.github.io/agents.html |
| Claude Code sources | `claude-code-sources/src/` (local, analyzed 2026-04-11) |
| Research Summary | (loaded into project) |
