#!/usr/bin/env bash
#
# Push the Google credentials from .dev.vars to the Worker and deploy.
#
#   CLOUDFLARE_ACCOUNT_ID=<id> CLOUDFLARE_API_TOKEN=<token> \
#     ./scripts/push-google-secrets.sh
#
# One script because the Cloudflare token is handed over one command at a time
# and may be single-use. Values are read from .dev.vars and piped on stdin, so
# neither ever appears in a command line.
#
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/lib-cloudflare.sh
. ./scripts/lib-cloudflare.sh

failures=""

put_secret() {
  local name="$1" value
  value=$(sed -n "s/^${name}=\"\(.*\)\"\$/\1/p" .dev.vars)

  if [ -z "$value" ]; then
    echo "    $name: not in .dev.vars"
    failures="${failures}  - $name"$'\n'
    return
  fi

  if printf '%s' "$value" | ./scripts/node.sh npx wrangler secret put "$name" >/dev/null 2>&1; then
    echo "    $name set (${#value} characters)"
  else
    echo "    $name failed"
    failures="${failures}  - $name"$'\n'
  fi
}

echo "==> 1/3  Worker secrets"
put_secret GOOGLE_CLIENT_ID
put_secret GOOGLE_CLIENT_SECRET

echo "==> 2/3  deploy"
./scripts/node.sh npx wrangler deploy || failures="${failures}  - deploy"$'\n'

echo "==> 3/3  live checks"
base="https://ruokalista.eerovil.workers.dev"
printf '    %-34s %s\n' "/health" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$base/health")"
printf '    %-34s %s\n' "/signin" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$base/signin")"
printf '    %-34s %s -> %s\n' "/auth/google" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$base/auth/google")" \
  "$(curl -s -o /dev/null -w '%{redirect_url}' "$base/auth/google" | cut -c1-60)"

if [ -n "$failures" ]; then
  printf 'Did not complete:\n%s' "$failures"
  exit 1
fi

echo
echo "Sign-in is live. First sign-in will hit the wall and show a Google sub;"
echo "insert a member row with it to get in."
