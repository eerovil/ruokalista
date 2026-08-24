#!/usr/bin/env bash
# Run a command in a Node 22 container against this repo.
#
# There is no node on this host (ostree system), so every npm/wrangler command
# goes through here:
#
#   ./scripts/node.sh npm install
#   ./scripts/node.sh npm run typecheck
#   ./scripts/node.sh npm run dev      # serves on http://localhost:8787
#
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

tty_flags=()
[ -t 0 ] && tty_flags=(-it)

exec podman run --rm "${tty_flags[@]}" \
  -v "$repo":/app:Z \
  -w /app \
  -p 8787:8787 \
  -e HOME=/tmp \
  --userns=keep-id \
  docker.io/library/node:22-bookworm \
  "$@"
