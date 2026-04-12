# Context Agent — Setup & Development Guide

> Working documentation for running the POC in Claude Code.
> Created: 2026-04-11

---

## Project Goal

Build a long-lived AI agent for collecting, structuring, and consolidating context from multiple sources. The agent runs on top of **OpenClaw** — a self-hosted AI assistant gateway with multi-channel support.

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
