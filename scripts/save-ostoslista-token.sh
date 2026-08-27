#!/usr/bin/env bash
#
# Store the shopping-list service token for local development and for the
# deployed Worker, then check it against the service — in one run, because the
# token is handed over one command at a time.
#
#   agentdeck secret-run <ticket> -- ./scripts/save-ostoslista-token.sh ostoslista
#
# The value is read from the named environment variable and never appears in an
# argument list: the local copy goes through set-dev-var.sh, the Worker secret
# through stdin, and the service check through a curl config on stdin.
#
# What the token is: the bearer secret of s-ostoslista-worker, a separate Worker
# that keeps a D1 copy of one S-ryhmä shopping list in two-way sync with the
# S-ostoslista app (github.com/eerovil/s-ostoslista-client). It lets ruokalista
# read and modify that list. It is *not* a direct S-ryhmä/AppSync credential and
# does not expose the phone's identity token, but a leak still exposes the bound
# real shopping list through this service.
#
set -euo pipefail

source_var="${1:?usage: save-ostoslista-token.sh ENV_VAR_NAME}"
value="${!source_var:-}"
[ -n "$value" ] || { echo "nothing in \$$source_var" >&2; exit 1; }

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/lib-cloudflare.sh
. ./scripts/lib-cloudflare.sh

# Kept in step with SOSTOSLISTA_SERVICE_URL in wrangler.jsonc. Overridable so
# this can be pointed at a replacement deployment without editing the script.
service_url="${SOSTOSLISTA_SERVICE_URL:-https://s-ostoslista-worker.eerovil.workers.dev}"

failures=""

echo "==> 1/3  .dev.vars (local development)"
# .dev.vars is the right home for this one: it is loaded into the Worker's own
# environment, which is exactly where SOSTOSLISTA_API_TOKEN belongs — unlike the
# Cloudflare account token, which lives outside the repo.
./scripts/set-dev-var.sh SOSTOSLISTA_API_TOKEN "$source_var"

echo "==> 2/3  Worker secret (deployed)"
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  if printf '%s' "$value" \
     | ./scripts/node.sh --cloudflare npx wrangler secret put SOSTOSLISTA_API_TOKEN \
       >/dev/null 2>&1; then
    echo "    set"
  else
    echo "    failed"
    failures="${failures}  - Worker secret"$'\n'
  fi
else
  echo "    skipped: no Cloudflare credentials on this host"
  failures="${failures}  - Worker secret"$'\n'
fi

echo "==> 3/3  check the token against the service"
# Header passed via a curl config on stdin so the token never reaches argv.
# /status is the cheapest authenticated route and touches nobody's list.
response=$(printf 'header = "Authorization: Bearer %s"\n' "$value" | curl -s -K - \
  --max-time 20 -w '\n%{http_code}' "$service_url/status" || true)
status=$(printf '%s' "$response" | tail -1)
body=$(printf '%s' "$response" | sed '$d')

case "$status" in
  200)
    # Only the bound list id and item count are echoed; no list contents.
    list=$(printf '%s' "$body" | grep -oE '"listId"[[:space:]]*:[[:space:]]*"[^"]*"' \
           | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
    items=$(printf '%s' "$body" | grep -oE '"items"[[:space:]]*:[[:space:]]*[0-9]+' \
            | head -1 | grep -oE '[0-9]+$')
    echo "    token works — list ${list:-unknown}, ${items:-?} item(s)"
    ;;
  401)
    echo "    token rejected by the service (401)"
    failures="${failures}  - service check"$'\n'
    ;;
  "")
    echo "    service unreachable"
    failures="${failures}  - service check"$'\n'
    ;;
  *)
    echo "    unexpected reply from the service (HTTP $status)"
    failures="${failures}  - service check"$'\n'
    ;;
esac

if [ -n "$failures" ]; then
  printf 'Did not complete:\n%s' "$failures"
  exit 1
fi
