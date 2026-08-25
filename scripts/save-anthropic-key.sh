#!/usr/bin/env bash
#
# Store the Anthropic API key for local development and for the deployed
# Worker, then check it against the API — in one run, because the key is handed
# over one command at a time.
#
#   agentdeck secret-run <ticket> -- ./scripts/save-anthropic-key.sh anthropic
#
# The value is read from the named environment variable and never appears in an
# argument list: the local copy goes through set-dev-var.sh, the Worker secret
# through stdin, and the API check through a curl config on stdin.
#
set -euo pipefail

source_var="${1:?usage: save-anthropic-key.sh ENV_VAR_NAME}"
value="${!source_var:-}"
[ -n "$value" ] || { echo "nothing in \$$source_var" >&2; exit 1; }

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/lib-cloudflare.sh
. ./scripts/lib-cloudflare.sh

failures=""

echo "==> 1/3  .dev.vars (local development)"
# .dev.vars is the right home for this one: it is loaded into the Worker's own
# environment, which is exactly where ANTHROPIC_API_KEY belongs — unlike the
# Cloudflare account token, which lives outside the repo.
./scripts/set-dev-var.sh ANTHROPIC_API_KEY "$source_var"

echo "==> 2/3  Worker secret (deployed)"
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  if printf '%s' "$value" \
     | ./scripts/node.sh npx wrangler secret put ANTHROPIC_API_KEY >/dev/null 2>&1; then
    echo "    set"
  else
    echo "    failed"
    failures="${failures}  - Worker secret"$'\n'
  fi
else
  echo "    skipped: no Cloudflare credentials on this host"
  failures="${failures}  - Worker secret"$'\n'
fi

echo "==> 3/3  check the key against the API"
# Header passed via a curl config on stdin so the key never reaches argv.
response=$(printf 'header = "x-api-key: %s"\n' "$value" | curl -s -K - \
  https://api.anthropic.com/v1/messages \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-5","max_tokens":16,"messages":[{"role":"user","content":"Say OK."}]}')

# Only the model id and stop reason are echoed; the body is not printed.
model=$(printf '%s' "$response" | grep -oE '"model"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
error=$(printf '%s' "$response" | grep -oE '"type"[[:space:]]*:[[:space:]]*"[a-z_]*error"' | head -1)

if [ -n "$model" ]; then
  echo "    key works — answered by $model"
else
  echo "    key rejected ${error:-(no model in reply)}"
  failures="${failures}  - API check"$'\n'
fi

if [ -n "$failures" ]; then
  printf 'Did not complete:\n%s' "$failures"
  exit 1
fi
