#!/usr/bin/env bash
#
# Put ruokalista on Cloudflare, from nothing to a live Worker, in one command.
#
#   CLOUDFLARE_ACCOUNT_ID=<account id> CLOUDFLARE_API_TOKEN=<token> \
#     ./scripts/cloudflare-setup.sh
#
# It is one script rather than a handful of commands because the token may be
# single-use: every step that needs it has to happen inside one run.
#
# Safe to run again. It creates the D1 database only if it is missing, and
# rotating SESSION_SECRET is opt-in — see ROTATE_SESSION_SECRET below.
#
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"

DATABASE_NAME="${DATABASE_NAME:-ruokalista}"
ROTATE_SESSION_SECRET="${ROTATE_SESSION_SECRET:-0}"
PRODUCTION_ORIGIN="${PRODUCTION_ORIGIN:-https://ruokalista.vilpponen.fi}"

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/lib-cloudflare.sh
. ./scripts/lib-cloudflare.sh

# Remote Wrangler is the exceptional command that receives the account token.
wrangler() { ./scripts/node.sh --cloudflare npx wrangler "$@"; }

# Looked up through `d1 list`, which reads no config. `d1 info <name>` resolves
# the name through wrangler.jsonc's binding, so before the real id is written
# there it asks Cloudflare about the placeholder and gets a 7404.
lookup_database_id() {
  wrangler d1 list --json 2>/dev/null \
    | ./scripts/node.sh node scripts/pick-d1-id.mjs "$DATABASE_NAME"
}

echo "==> 1/5  database"
database_id=$(lookup_database_id | tr -d '\r\n')
if [ -n "$database_id" ]; then
  echo "    $DATABASE_NAME exists: $database_id"
else
  echo "    creating $DATABASE_NAME"
  wrangler d1 create "$DATABASE_NAME" >/dev/null
  database_id=$(lookup_database_id | tr -d '\r\n')
  [ -n "$database_id" ] || { echo "could not read the new database id" >&2; exit 1; }
  echo "    created: $database_id"
fi

echo "==> 2/5  wrangler.jsonc"
sed -i -E \
  "s/(\"database_id\"[[:space:]]*:[[:space:]]*\")[^\"]*(\")/\1${database_id}\2/" \
  wrangler.jsonc
grep -q "$database_id" wrangler.jsonc \
  || { echo "failed to write database_id into wrangler.jsonc" >&2; exit 1; }
echo "    database_id written"

# From here on a failing step must not abandon the ones after it: the token may
# be good for a single run, so the script gets as far as it can and reports what
# did not happen, rather than stopping at the first stumble.
set +e
failures=""
note_failure() { failures="${failures}  - $1"$'\n'; }

echo "==> 3/5  remote migrations"
wrangler d1 migrations apply "$DATABASE_NAME" --remote \
  || note_failure "remote migrations"

# Deploy comes before the secret because `wrangler secret put` needs the Worker
# to exist; on a first run it does not until this deploy creates it. The Worker
# is briefly live without SESSION_SECRET, which is the 503 path, not an open one.
echo "==> 4/5  deploy"
wrangler deploy || note_failure "deploy"

echo "==> 5/5  SESSION_SECRET"
if [ "$ROTATE_SESSION_SECRET" = "1" ] \
   || ! wrangler secret list 2>/dev/null | grep -q SESSION_SECRET; then
  # Generated here and never printed. Rotating it signs every member out, which
  # is the only revocation the app has.
  openssl rand -base64 32 | tr -d '\n' | wrangler secret put SESSION_SECRET \
    && echo "    set" \
    || note_failure "SESSION_SECRET"
else
  echo "    already set (ROTATE_SESSION_SECRET=1 to replace it)"
fi

echo
echo "Canonical production URL: $PRODUCTION_ORIGIN"
echo "  /health   -> $(curl -s -o /dev/null -w '%{http_code}' "$PRODUCTION_ORIGIN/health")"
echo "  protected -> $(curl -s -o /dev/null -w '%{http_code}' "$PRODUCTION_ORIGIN/api/ingredients")"

if [ -n "$failures" ]; then
  printf 'Did not complete:\n%s' "$failures"
  exit 1
fi

echo "Done. Only /health is reachable until Google sign-in exists, and the"
echo "remote database has no household or member rows yet."
echo "Register this Google OAuth redirect before enabling sign-in:"
echo "  $PRODUCTION_ORIGIN/auth/google/callback"
