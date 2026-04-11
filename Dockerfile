FROM ghcr.io/openclaw/openclaw:latest

COPY --chmod=755 entrypoint.sh /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
