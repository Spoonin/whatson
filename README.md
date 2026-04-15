# Whatson — Configuration Reference

Whatson is a context agent built on OpenClaw. It ingests messages and documents
via Telegram, extracts structured facts into a temporal knowledge graph, runs
consolidation passes to resolve duplicates and contradictions, and exports the
active knowledge base to a target repository as structured markdown.

This document lists every environment variable Whatson reads. Copy
[.env.example](.env.example) to `.env`, fill in required values, then
`docker compose up -d openclaw-gateway`.

---

## Required

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | API key for Claude. Used by the SDK backend and, by default, also by the `claude` CLI inside the container. Required unless every LLM component is switched to CLI and the binary is logged into a Pro/Max session. |
| `OPENCLAW_GATEWAY_TOKEN` | Bearer token protecting the OpenClaw Control UI and HTTP gateway. Pick any long random string. |
| `TELEGRAM_BOT_TOKEN` | Token from `@BotFather`. Required to connect the Telegram channel. Leave unset to run the gateway without Telegram. |

---

## Gateway

| Variable | Default | Description |
|---|---|---|
| `OPENCLAW_GATEWAY_PORT` | `18789` | Host port the Control UI and HTTP gateway bind to. |

---

## LLM backend routing

Every Anthropic call in Whatson flows through a single dispatcher in
[src/llm.ts](skills/context-agent/src/llm.ts). You can switch any
component between the Anthropic SDK (billed against API credits) and the
`claude` CLI (billed against a logged-in Claude Pro/Max session).

Precedence, highest to lowest:

1. `LLM_BACKEND_<COMPONENT>` — per-component override
2. `LLM_BACKEND` — global default
3. Built-in component default (see table)

Valid values: `sdk`, `cli` (case-insensitive). Anything else is ignored and
falls through to the next layer.

| Variable | Default | Applies to |
|---|---|---|
| `LLM_BACKEND` | `sdk` | Global default for all components when no component-specific var is set. |
| `LLM_BACKEND_EXTRACT` | `sdk` | Fact extraction from incoming messages (regex pre-filter + LLM classification). |
| `LLM_BACKEND_CONSOLIDATION` | `sdk` | LLM cluster analysis during consolidation (duplicate merge, contradiction detection). |
| `LLM_BACKEND_DRIFT` | `cli` | Drift analysis. **Always CLI** — drift needs tool access (`Read`, `Grep`, `Glob`, `Bash`) to scan the target repo. Setting this to `sdk` makes drift skip with an explicit reason. |
| `LLM_BACKEND_RENDER` | `sdk` | Rendering synthesized artifacts (PROJECT.md, etc.) from the fact store. |
| `LLM_BACKEND_RETRIEVAL` | `sdk` | Reserved. Retrieval is SQL-only today; this hook is ready for when synthesis lands. |
| `CLAUDE_CLI_BIN` | `claude` | Path or name of the Claude Code binary used by the CLI backend. Override if the binary is not on `PATH` or is named something other than `claude`. |

**Subscription billing.** The dispatcher strips `ANTHROPIC_API_KEY` from the
`claude -p` subprocess environment, so the CLI always falls through to the
logged-in session. SDK and CLI components can coexist on the same container
without touching `.env`. To enable CLI mode end-to-end:

1. `./data/claude-session/` is mounted at `/home/node/.claude` — the Claude
   Code session persists there across container restarts.
2. Run `claude login` once inside the container:
   `docker compose exec openclaw-gateway claude login`
3. Flip the component to CLI: `LLM_BACKEND_RENDER=cli` (or `LLM_BACKEND=cli`
   for all).

---

## Target repo sync

Whatson exports the active knowledge base to a target repository as structured
markdown (`INDEX.md`, per-topic files, per-source files). All settings are
optional — if `TARGET_REPO` is unset, sync is skipped.

| Variable | Default | Description |
|---|---|---|
| `TARGET_REPO` | _(unset)_ | Git URL (`https://` or `ssh://`) of the repo to push context into. Unset → sync is skipped. |
| `WHATSON_CONTEXT_DIR` | `docs/context` | Path inside the target repo where `INDEX.md`, `topics/`, `sources/`, and `rendered/` are written. |
| `WHATSON_TARGET_WORKDIR` | `<skill>/data/target-repo` | Local checkout path. Cleared and re-cloned if the remote URL changes. |
| `GITHUB_TOKEN` | _(unset)_ | Injected into `https://` URLs as `x-access-token:TOKEN@` for authentication. Omit for `ssh://` URLs. |
| `WHATSON_COMMIT_AUTHOR` | `Whatson <whatson@bot.local>` | `Name <email>` format. Used for the commit author/committer identity. |
| `WHATSON_SYNC_PUSH` | `true` | Set to `false` to commit locally without pushing. Useful when iterating on render output. |
| `WHATSON_SYNC_EVERY_N_CONSOLIDATION` | `1` | Auto-sync cadence gate. `0` disables auto-sync (use the `/sync` command manually). `1` syncs after every consolidation run. `N>1` syncs after every Nth run. |

---

## Embeddings (vector search)

Whatson uses Voyage embeddings for semantic search over the fact base via
`sqlite-vec`. Entirely optional — retrieval falls back to FTS5 keyword search
when the API key is absent.

| Variable | Default | Description |
|---|---|---|
| `VOYAGE_API_KEY` | _(unset)_ | Voyage AI API key. Unset → embeddings are disabled, semantic search returns no results, keyword search still works. |
| `WHATSON_EMBEDDING_MODEL` | `voyage-3-lite` | Voyage model name. |
| `WHATSON_EMBEDDING_DIMS` | `512` | Embedding dimension. Must match the model and the `fact_embeddings` vec0 table schema — if you change this, drop the DB so the schema rebuilds. |

---

## Drift analysis

Drift analysis cross-checks recorded facts against the current state of the
target repo's code. It runs as phase 5 of consolidation and shells out to the
`claude` CLI with tool access.

| Variable | Default | Description |
|---|---|---|
| `WHATSON_DRIFT_ENABLED` | `false` | Set to `true` to enable drift analysis. Disabled by default because it consumes tokens and time on every consolidation run. |
| `WHATSON_DRIFT_MODEL` | `claude-opus-4-6` | Model passed to `claude -p --model ...`. Use a capable model — drift analysis reasons about code. |

Drift also requires `TARGET_REPO` to be set and a successful checkout — without
a target repo there's nothing to check against.

---

## Diagnostics

```bash
# See which backend each component will use right now
docker compose exec openclaw-gateway \
  node -e "import('./src/llm.js').then(m => console.log(m.backendMatrix()))"

# Render a PROJECT.md locally (no push)
docker compose exec openclaw-gateway \
  node /opt/whatson-skills/context-agent/dist/cli.js render_project

# Check gateway health
docker compose exec openclaw-gateway /usr/local/bin/gateway-healthcheck.sh
```

Output paths on the host (via the `./data/context-data` bind mount):
- `./data/context-data/context.db` — SQLite fact store
- `./data/context-data/rendered/PROJECT.md` — latest synthesized render
- `./data/context-data/target-repo/` — local clone of the target repository
