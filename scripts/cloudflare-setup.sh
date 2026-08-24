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

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

wrangler() { ./scripts/node.sh npx wrangler "$@"; }

# wrangler prints a banner before its JSON, so pick the uuid out by shape rather
# than by parsing the whole document.
uuid_from() {
  grep -oE '"uuid"[[:space:]]*:[[:space:]]*"[0-9a-fA-F-]{36}"' \
    | grep -oiE '[0-9a-f-]{36}' \
    | head -1
}

echo "==> 1/5  database"
if info=$(wrangler d1 info "$DATABASE_NAME" --json 2>/dev/null) \
   && database_id=$(printf '%s' "$info" | uuid_from) \
   && [ -n "$database_id" ]; then
  echo "    $DATABASE_NAME exists: $database_id"
else
  echo "    creating $DATABASE_NAME"
  wrangler d1 create "$DATABASE_NAME" >/dev/null
  database_id=$(wrangler d1 info "$DATABASE_NAME" --json 2>/dev/null | uuid_from)
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

echo "==> 3/5  remote migrations"
wrangler d1 migrations apply "$DATABASE_NAME" --remote

echo "==> 4/5  SESSION_SECRET"
if [ "$ROTATE_SESSION_SECRET" = "1" ] \
   || ! wrangler secret list 2>/dev/null | grep -q SESSION_SECRET; then
  # Generated here and never printed. Rotating it signs every member out, which
  # is the only revocation the app has.
  openssl rand -base64 32 | tr -d '\n' | wrangler secret put SESSION_SECRET
  echo "    set"
else
  echo "    already set (ROTATE_SESSION_SECRET=1 to replace it)"
fi

echo "==> 5/5  deploy"
wrangler deploy

echo
echo "Done. The Worker is live; only /health is reachable until Google sign-in"
echo "exists, and the remote database has no household or member rows yet."
