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

# Register context-agent MCP server (idempotent — overwrites if exists).
# OpenClaw's `mcp set` accepts an `env` object; we pass an explicit allowlist
# because the gateway does not forward the container's env to spawned MCP
# stdio servers by default.
echo "[entrypoint] Registering context-agent MCP server..."
export MCP_SCRIPT="$SKILL_DIR/dist/mcp-server.js"
MCP_CONFIG_JSON=$(node -e '
  const env = {};
  const keys = [
    "ANTHROPIC_API_KEY",
    "TARGET_REPO",
    "WHATSON_CONTEXT_DIR",
    "WHATSON_TARGET_WORKDIR",
    "GITHUB_TOKEN",
    "WHATSON_COMMIT_AUTHOR",
    "WHATSON_SYNC_PUSH",
    "WHATSON_SYNC_EVERY_N_CONSOLIDATION",
    "WHATSON_DRIFT_ENABLED",
    "WHATSON_DRIFT_MODEL",
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

exec node dist/index.js gateway "$@"
