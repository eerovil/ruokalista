#!/usr/bin/env bash
# Run a command in a Node 22 container against this repo.
#
# There is no node on this host (ostree system), so every npm/wrangler command
# goes through here:
#
#   ./scripts/node.sh npm install
#   ./scripts/node.sh npm run typecheck
#   ./scripts/node.sh --serve npm run dev   # http://127.0.0.1:8787
#   ./scripts/node.sh --login npx wrangler login
#
# --serve publishes port 8787 and is only for the dev server. Without it no port
# is published, so one-off commands still work while the dev server is running —
# publishing an already-bound port fails the container outright.
#
# --login publishes 8976, which is where Cloudflare's OAuth redirect lands.
#
# The container's HOME is a directory on the host, so a wrangler login survives
# between commands instead of dying with the container.
#
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
container_home="${RUOKALISTA_CONTAINER_HOME:-$HOME/.local/share/ruokalista/home}"
mkdir -p "$container_home"

port_flags=()
case "${1:-}" in
  --serve)
    port_flags=(-p 127.0.0.1:8787:8787)
    shift
    ;;
  --login)
    port_flags=(-p 127.0.0.1:8976:8976)
    shift
    ;;
esac

tty_flags=()
[ -t 0 ] && tty_flags=(-it)

exec podman run --rm "${tty_flags[@]}" "${port_flags[@]}" \
  -v "$repo":/app:Z \
  -v "$container_home":/home/dev:Z \
  -w /app \
  -e HOME=/home/dev \
  --userns=keep-id \
  docker.io/library/node:22-bookworm \
  "$@"
