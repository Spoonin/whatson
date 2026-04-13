#!/bin/sh
set -e

CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-/home/node/.openclaw}"

# Build skill: install deps (better-sqlite3 native addon) + compile TypeScript.
# node_modules is on an anonymous volume so the container's linux binary
# stays isolated from the host's. pnpm/tsc are idempotent — run every start.
SKILL_DIR="$CONFIG_DIR/workspace/skills/context-agent"
if [ -d "$SKILL_DIR" ]; then
  echo "[entrypoint] Building context-agent skill..."
  cd "$SKILL_DIR"
  CI=true pnpm install --store-dir /tmp/pnpm-store 2>&1
  pnpm run build 2>&1
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

cd /app
exec node dist/index.js gateway "$@"
