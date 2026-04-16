FROM ghcr.io/openclaw/openclaw:latest

USER root
RUN npm install -g @anthropic-ai/claude-code repomix && \
    mkdir -p /opt/whatson-skills && chown -R node:node /opt/whatson-skills
USER node

WORKDIR /opt/whatson-skills/context-agent
COPY --chown=node:node skills/context-agent/package.json skills/context-agent/pnpm-lock.yaml skills/context-agent/.npmrc ./
RUN pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store && rm -rf /tmp/pnpm-store
COPY --chown=node:node skills/context-agent/tsconfig.json skills/context-agent/SKILL.md ./
COPY --chown=node:node skills/context-agent/src ./src
COPY --chown=node:node skills/context-agent/templates ./templates
RUN pnpm run build

USER root
COPY --chmod=755 entrypoint.sh /entrypoint.sh
USER node

WORKDIR /app
ENTRYPOINT ["/entrypoint.sh"]
