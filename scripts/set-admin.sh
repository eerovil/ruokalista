#!/usr/bin/env bash
#
# Mark a member as an admin, or take it away. Admin is one column on one row and
# there is no way to grant it from inside the app — same as membership itself.
#
#   CLOUDFLARE_ACCOUNT_ID=<id> CLOUDFLARE_API_TOKEN=<token> \
#     ./scripts/set-admin.sh <google-sub> on|off
#
# The google-sub is the same one add-member.sh takes: Google's stable account id,
# which the sign-in wall shows a person who is not yet a member. Members are
# matched on it and never on email, here as everywhere.
#
# Add --local to work on the development database instead of the real one.
#
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/lib-cloudflare.sh
. ./scripts/lib-cloudflare.sh

target="--remote"
if [ "${1:-}" = "--local" ]; then
  target="--local"
  shift
fi

google_sub="${1:?usage: set-admin.sh [--local] <google-sub> on|off}"
state="${2:?usage: set-admin.sh [--local] <google-sub> on|off}"

case "$state" in
  on)  value=1 ;;
  off) value=0 ;;
  *)   echo "state must be on or off, not '$state'" >&2; exit 2 ;;
esac

node_options=()
if [ "$target" = "--remote" ]; then
  : "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
  : "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
  node_options=(--cloudflare)
fi

# Doubling single quotes is SQLite's own escaping.
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }

# No insert: this only ever changes a member who already exists. Somebody who is
# not in the household cannot be made its admin by typo.
sql="UPDATE member SET is_admin = ${value} WHERE google_sub = $(quote "$google_sub");"

echo "==> setting is_admin = ${value} for ${google_sub} ($target)"
./scripts/node.sh "${node_options[@]}" npx wrangler d1 execute ruokalista "$target" \
  --command "$sql" >/dev/null

echo "==> members now"
./scripts/node.sh "${node_options[@]}" npx wrangler d1 execute ruokalista "$target" \
  --command "SELECT id, display_name, is_admin FROM member ORDER BY id" \
  2>/dev/null | grep -E '"id"|"display_name"|"is_admin"'
