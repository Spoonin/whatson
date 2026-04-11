#!/bin/sh
set -e

CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-/home/node/.openclaw}"
SENTINEL="$CONFIG_DIR/.initialized"

# Build skill: rebuild native addons for Linux + compile TypeScript
SKILL_DIR="$CONFIG_DIR/workspace/skills/context-agent"
SKILL_SENTINEL="$SKILL_DIR/.built-$(uname -m)"
if [ -d "$SKILL_DIR" ] && [ ! -f "$SKILL_SENTINEL" ]; then
  echo "[entrypoint] Building context-agent skill for $(uname -m)..."
  cd "$SKILL_DIR"
  CI=true pnpm install --frozen-lockfile 2>&1 || CI=true pnpm install 2>&1
  pnpm run build 2>&1
  touch "$SKILL_SENTINEL"
fi

cd /app
exec node dist/index.js gateway "$@"
