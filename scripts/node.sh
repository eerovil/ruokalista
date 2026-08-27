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
#   ./scripts/node.sh --cloudflare npx wrangler deploy
#
# --serve publishes port 8787 and is only for the dev server. Without it no port
# is published, so one-off commands still work while the dev server is running —
# publishing an already-bound port fails the container outright.
#
# --login publishes 8976, which is where Cloudflare's OAuth redirect lands.
#
# --cloudflare is the only way the account token is forwarded. Generic commands
# such as npm install, typecheck and tests never receive production credentials.
#
# The container's HOME is a directory on the host, so a wrangler login survives
# between commands instead of dying with the container.
#
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
container_home="${RUOKALISTA_CONTAINER_HOME:-$HOME/.local/share/ruokalista/home}"
mkdir -p "$container_home"

serve=0
login=0
with_cloudflare=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --serve)
      serve=1
      shift
      ;;
    --login)
      login=1
      shift
      ;;
    --cloudflare)
      with_cloudflare=1
      shift
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

[ "$#" -gt 0 ] || { echo "usage: node.sh [options] command ..." >&2; exit 2; }

# This image has no browsers, so a browser run started here fails in a way that
# reads like broken tests rather than like the wrong wrapper. Say which one to
# use instead. (#128 lost a cycle to exactly this.)
for arg in "$@"; do
  case "$arg" in
    playwright|test:browser|*/playwright)
      cat >&2 <<EOF
node.sh cannot run the browser tests: this image carries no browsers.

Use the Playwright wrapper instead:

  ./scripts/playwright.sh npx playwright test
EOF
      exit 2
      ;;
  esac
done
if [ "$serve" = "1" ] && [ "$login" = "1" ]; then
  echo "--serve and --login cannot be used together" >&2
  exit 2
fi

port_flags=()
if [ "$serve" = "1" ]; then
  port_flags=(-p 127.0.0.1:8787:8787)
elif [ "$login" = "1" ]; then
  port_flags=(-p 127.0.0.1:8976:8976)
fi

# -i always, so a piped stdin reaches the command (wrangler secret put reads it).
run_flags=(-i)
[ -t 0 ] && run_flags+=(-t)

cloudflare_flags=()
if [ "$with_cloudflare" = "1" ]; then
  # shellcheck source=scripts/lib-cloudflare.sh
  . "$repo/scripts/lib-cloudflare.sh"

  # Forwarded by name, never by value, so a token stays out of the command line.
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] \
    && cloudflare_flags+=(-e CLOUDFLARE_API_TOKEN)
  [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] \
    && cloudflare_flags+=(-e CLOUDFLARE_ACCOUNT_ID)
fi

exec podman run --rm "${run_flags[@]}" "${port_flags[@]}" "${cloudflare_flags[@]}" \
  -v "$repo":/app:Z \
  -v "$container_home":/home/dev:Z \
  -w /app \
  -e HOME=/home/dev \
  --userns=keep-id \
  docker.io/library/node:22-bookworm \
  "$@"
