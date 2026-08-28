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
# Safe to run again. It creates the D1 database and the R2 bucket only if they
# are missing, and rotating SESSION_SECRET is opt-in — see
# ROTATE_SESSION_SECRET below.
#
# R2 has to be enabled on the account first, in the Cloudflare dashboard. It is
# not something a token can turn on, and `wrangler deploy` refuses outright
# while wrangler.jsonc binds a bucket that does not exist — so this script
# stops here rather than letting the deploy fail halfway.
#
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"

DATABASE_NAME="${DATABASE_NAME:-ruokalista}"
BUCKET_NAME="${BUCKET_NAME:-ruokalista-recipe-images}"
QUEUE_NAME="${QUEUE_NAME:-ruokalista-intake}"
ROTATE_SESSION_SECRET="${ROTATE_SESSION_SECRET:-0}"

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

echo "==> 1/7  database"
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

echo "==> 2/7  wrangler.jsonc"
sed -i -E \
  "s/(\"database_id\"[[:space:]]*:[[:space:]]*\")[^\"]*(\")/\1${database_id}\2/" \
  wrangler.jsonc
grep -q "$database_id" wrangler.jsonc \
  || { echo "failed to write database_id into wrangler.jsonc" >&2; exit 1; }
echo "    database_id written"

echo "==> 3/7  recipe image bucket"
# Before the tolerant section below on purpose: a missing bucket is not a
# stumble the deploy can survive, so this one is fatal.
# Create-and-tolerate rather than list-then-create: `r2 bucket list` has changed
# its output shape between wrangler versions, and "already exists" is the one
# failure that means everything is fine.
bucket_log=$(mktemp)
if wrangler r2 bucket create "$BUCKET_NAME" >"$bucket_log" 2>&1; then
  echo "    created: $BUCKET_NAME"
elif grep -qi "already exists\|already owned" "$bucket_log"; then
  echo "    $BUCKET_NAME exists"
else
  cat "$bucket_log" >&2
  echo "could not create $BUCKET_NAME. Is R2 enabled on the account (it has to" >&2
  echo "be switched on in the dashboard once), and does the token carry R2?" >&2
  exit 1
fi

rm -f "$bucket_log"

echo "==> 4/7  intake queue"
queue_log=$(mktemp)
if wrangler queues create "$QUEUE_NAME" >"$queue_log" 2>&1; then
  echo "    created: $QUEUE_NAME"
elif grep -qi "already exists\|already owned" "$queue_log"; then
  echo "    $QUEUE_NAME exists"
else
  cat "$queue_log" >&2
  echo "could not create $QUEUE_NAME. Does the token carry Queues permission?" >&2
  exit 1
fi
rm -f "$queue_log"

# From here on a failing step must not abandon the ones after it: the token may
# be good for a single run, so the script gets as far as it can and reports what
# did not happen, rather than stopping at the first stumble.
set +e
failures=""
note_failure() { failures="${failures}  - $1"$'\n'; }

echo "==> 5/7  remote migrations"
wrangler d1 migrations apply "$DATABASE_NAME" --remote \
  || note_failure "remote migrations"

# Deploy comes before the secret because `wrangler secret put` needs the Worker
# to exist; on a first run it does not until this deploy creates it. The Worker
# is briefly live without SESSION_SECRET, which is the 503 path, not an open one.
echo "==> 6/7  deploy"
deploy_log=$(mktemp)
wrangler deploy 2>&1 | tee "$deploy_log"
[ "${PIPESTATUS[0]}" -eq 0 ] || note_failure "deploy"

echo "==> 7/7  SESSION_SECRET"
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

url=$(sed 's/\x1b\[[0-9;]*m//g' "$deploy_log" \
       | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
rm -f "$deploy_log"

echo
if [ -n "$url" ]; then
  echo "Live at $url"
  echo "  /health   -> $(curl -s -o /dev/null -w '%{http_code}' "$url/health")"
  echo "  protected -> $(curl -s -o /dev/null -w '%{http_code}' "$url/api/ingredients")"
fi

if [ -n "$failures" ]; then
  printf 'Did not complete:\n%s' "$failures"
  exit 1
fi

echo "Done. Only /health is reachable until Google sign-in exists, and the"
echo "remote database has no household or member rows yet."
