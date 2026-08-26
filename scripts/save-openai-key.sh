#!/usr/bin/env bash
#
# Store the OpenAI API key for local development and for the deployed Worker,
# then check it against the API — in one run, because the key is handed over one
# command at a time.
#
#   agentdeck secret-run <ticket> -- ./scripts/save-openai-key.sh openai
#
# The value is read from the named environment variable and never appears in an
# argument list: the local copy goes through set-dev-var.sh, the Worker secret
# through stdin, and the API check through a curl config on stdin.
#
# This key draws recipe pictures (#96) and is charged per request, so the check
# below is a plain listing of models — the cheapest read there is. Nothing here
# generates an image.
#
set -euo pipefail

source_var="${1:?usage: save-openai-key.sh ENV_VAR_NAME}"
value="${!source_var:-}"
[ -n "$value" ] || { echo "nothing in \$$source_var" >&2; exit 1; }

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/lib-cloudflare.sh
. ./scripts/lib-cloudflare.sh

failures=""

echo "==> 1/3  .dev.vars (local development)"
# .dev.vars is loaded into the Worker's own environment, which is where a key
# the Worker calls out with belongs — unlike the Cloudflare account token,
# which stays outside the repo entirely.
./scripts/set-dev-var.sh OPENAI_API_KEY "$source_var"

echo "==> 2/3  Worker secret (deployed)"
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  if printf '%s' "$value" \
     | ./scripts/node.sh --cloudflare npx wrangler secret put OPENAI_API_KEY \
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

echo "==> 3/3  check the key against the API"
# Header passed via a curl config on stdin so the key never reaches argv. A
# listing, not a generation: this must not cost anything.
response=$(printf 'header = "authorization: Bearer %s"\n' "$value" | curl -s -K - \
  https://api.openai.com/v1/models/gpt-image-1)

model=$(printf '%s' "$response" | grep -oE '"id"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
error=$(printf '%s' "$response" | grep -oE '"code"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1)

if [ "$model" = "gpt-image-1" ]; then
  echo "    key works — gpt-image-1 is available to this account"
elif [ -n "$model" ]; then
  echo "    key works, but answered with $model rather than gpt-image-1"
  failures="${failures}  - API check"$'\n'
else
  echo "    key rejected or gpt-image-1 not available ${error:-}"
  failures="${failures}  - API check"$'\n'
fi

if [ -n "$failures" ]; then
  printf 'Did not complete:\n%s' "$failures"
  exit 1
fi
