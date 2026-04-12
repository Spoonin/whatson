FROM ghcr.io/openclaw/openclaw:latest

USER root
RUN npm install -g @anthropic-ai/claude-code
USER node

COPY --chmod=755 entrypoint.sh /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
