#!/bin/sh
set -e

SKILL_DIR="/opt/whatson-skills/context-agent"

# Sync prompt files into OpenClaw's workspace. We can't bind-mount these
# directly — they live inside `.openclaw` which is itself a bind mount, and
# nested file-over-dir binds are silently broken on Docker Desktop macOS.
# Instead, the repo-side files are mounted at /opt/whatson-prompts/ (flat,
# non-nested) and copied in here on every container start.
WORKSPACE_DIR="/home/node/.openclaw/workspace"
PROMPTS_SRC="/opt/whatson-prompts"
if [ -d "$PROMPTS_SRC" ]; then
  mkdir -p "$WORKSPACE_DIR"
  for f in SOUL.md; do
    if [ -f "$PROMPTS_SRC/$f" ]; then
      cp -f "$PROMPTS_SRC/$f" "$WORKSPACE_DIR/$f"
      echo "[entrypoint] synced $f into workspace"
    fi
  done
fi

# ── Step 1: Seed gateway + channels (no "agent" key — mcp set rejects it) ──
CONFIG_FILE="/home/node/.openclaw/openclaw.json"
echo "[entrypoint] Ensuring gateway config..."
mkdir -p /home/node/.openclaw
node -e '
  const fs = require("fs");
  const path = "'"$CONFIG_FILE"'";
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
  cfg.gateway = Object.assign(cfg.gateway || {}, { mode: "local" });
  if (!cfg.channels) cfg.channels = {};
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  if (tgToken) {
    cfg.channels.telegram = Object.assign(cfg.channels.telegram || {}, {
      enabled: true,
      botToken: tgToken,
      dmPolicy: "pairing"
    });
  }
  const slackBot = process.env.SLACK_BOT_TOKEN;
  const slackApp = process.env.SLACK_APP_TOKEN;
  const slackSigning = process.env.SLACK_SIGNING_SECRET;
  if (slackBot && (slackApp || slackSigning)) {
    const base = Object.assign({ enabled: true, dmPolicy: "pairing" }, cfg.channels.slack || {});
    cfg.channels.slack = slackApp
      ? Object.assign(base, { mode: "socket", botToken: slackBot, appToken: slackApp })
      : Object.assign(base, { mode: "http",   botToken: slackBot, signingSecret: slackSigning, webhookPath: "/slack/events" });
  }
  const teamsId = process.env.MSTEAMS_APP_ID;
  const teamsPw = process.env.MSTEAMS_APP_PASSWORD;
  const teamsTenant = process.env.MSTEAMS_TENANT_ID;
  if (teamsId && teamsPw && teamsTenant) {
    cfg.channels.msteams = Object.assign(cfg.channels.msteams || {}, {
      enabled: true,
      appId: teamsId,
      appPassword: teamsPw,
      tenantId: teamsTenant,
      webhook: { port: 3978, path: "/api/messages" },
      dmPolicy: "pairing"
    });
  }
  // Remove agent key before mcp set (mcp set validator rejects it)
  const agent = cfg.agent;
  delete cfg.agent;
  fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
'

# ── Step 2: Register MCP server (needs valid config without "agent") ────────
echo "[entrypoint] Registering context-agent MCP server..."
export MCP_SCRIPT="$SKILL_DIR/dist/mcp-server.js"
MCP_CONFIG_JSON=$(node -e '
  const env = {};
  const keys = [
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
    "OPENROUTER_API_KEY",
    "TARGET_REPO",
    "WHATSON_CONTEXT_DIR",
    "WHATSON_TARGET_WORKDIR",
    "GITHUB_TOKEN",
    "WHATSON_COMMIT_AUTHOR",
    "WHATSON_SYNC_PUSH",
    "WHATSON_SYNC_EVERY_N_CONSOLIDATION",
    "WHATSON_DRIFT_ENABLED",
    "WHATSON_DRIFT_MODEL",
    "WHATSON_DRIFT_PACK_MODE",
    "WHATSON_DRIFT_MAX_PACK_BYTES",
    "WHATSON_DRIFT_CONCURRENCY",
    "WHATSON_DRIFT_DRY_RUN",
    "LLM_BACKEND",
    "LLM_BACKEND_EXTRACT",
    "LLM_BACKEND_CONSOLIDATION",
    "LLM_BACKEND_DRIFT",
    "LLM_BACKEND_RENDER",
    "LLM_BACKEND_RETRIEVAL",
    "CLAUDE_CLI_BIN",
    "VOYAGE_API_KEY",
    "WHATSON_EMBEDDING_MODEL",
    "WHATSON_EMBEDDING_DIMS",
  ];
  for (const k of keys) {
    if (process.env[k] !== undefined && process.env[k] !== "") env[k] = process.env[k];
  }
  process.stdout.write(JSON.stringify({
    command: "node",
    args: [process.env.MCP_SCRIPT],
    env,
  }));
')
cd /app
node dist/index.js mcp set context-agent "$MCP_CONFIG_JSON" 2>&1 || echo "[entrypoint] WARNING: mcp set failed (non-fatal)"

# ── Step 3: Set agent model via CLI (after mcp set) ─────────────────────────
AGENT_MODEL="${OPENCLAW_AGENT_MODEL:-google/gemini-2.0-flash}"
echo "[entrypoint] Setting agent model to $AGENT_MODEL..."
node dist/index.js config set agents.defaults.model "$AGENT_MODEL" 2>&1 || echo "[entrypoint] WARNING: model set failed (non-fatal)"

exec node dist/index.js gateway "$@"
