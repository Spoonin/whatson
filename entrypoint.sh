#!/bin/sh
set -e

CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-/home/node/.openclaw}"

# Build skill: install deps + compile TypeScript (no native addons — sql.js is pure WASM)
SKILL_DIR="$CONFIG_DIR/workspace/skills/context-agent"
SKILL_SENTINEL="$SKILL_DIR/.built"
if [ -d "$SKILL_DIR" ] && [ ! -f "$SKILL_SENTINEL" ]; then
  echo "[entrypoint] Building context-agent skill..."
  cd "$SKILL_DIR"
  CI=true pnpm install --store-dir /tmp/pnpm-store 2>&1
  pnpm run build 2>&1
  touch "$SKILL_SENTINEL"
fi

# Register context-agent MCP server (idempotent — overwrites if exists)
echo "[entrypoint] Registering context-agent MCP server..."
cd /app
node dist/index.js mcp set context-agent "{\"command\":\"node\",\"args\":[\"$SKILL_DIR/dist/mcp-server.js\"]}" 2>&1 || echo "[entrypoint] WARNING: mcp set failed (non-fatal)"

cd /app
exec node dist/index.js gateway "$@"
