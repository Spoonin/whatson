#!/bin/sh
# Why api.telegram.org check: poller stalls on stale undici sockets (UND_ERR_SOCKET)
# while the gateway HTTP stays up, so /healthz alone misses the failure.
set -eu

curl -fsS --max-time 5 http://127.0.0.1:18789/healthz >/dev/null
curl -fsS --max-time 8 -o /dev/null https://api.telegram.org/
