#!/usr/bin/env bash
# Run a command in a Node 22 container against this repo.
#
# There is no node on this host (ostree system), so every npm/wrangler command
# goes through here:
#
#   ./scripts/node.sh npm install
#   ./scripts/node.sh npm run typecheck
#   ./scripts/node.sh --serve npm run dev   # http://127.0.0.1:8787
#
# --serve publishes port 8787 and is only for the dev server. Without it no port
# is published, so one-off commands still work while the dev server is running —
# publishing an already-bound port fails the container outright.
#
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

port_flags=()
if [ "${1:-}" = "--serve" ]; then
  port_flags=(-p 127.0.0.1:8787:8787)
  shift
fi

tty_flags=()
[ -t 0 ] && tty_flags=(-it)

exec podman run --rm "${tty_flags[@]}" "${port_flags[@]}" \
  -v "$repo":/app:Z \
  -w /app \
  -e HOME=/tmp \
  --userns=keep-id \
  docker.io/library/node:22-bookworm \
  "$@"
