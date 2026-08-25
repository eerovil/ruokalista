#!/usr/bin/env bash
#
# Add a member to the household by hand. v1 has no signup path, so this is the
# only way anybody gets in.
#
#   CLOUDFLARE_ACCOUNT_ID=<id> CLOUDFLARE_API_TOKEN=<token> \
#     ./scripts/add-member.sh <google-sub> <display name> [email]
#
# The google-sub is what the sign-in wall shows a person who is not yet a
# member. It is the only way to learn it: members are matched on Google's stable
# account id, never on email.
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

google_sub="${1:?usage: add-member.sh [--local] <google-sub> <display name> [email]}"
display_name="${2:?usage: add-member.sh [--local] <google-sub> <display name> [email]}"
email="${3:-}"

node_options=()
if [ "$target" = "--remote" ]; then
  : "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
  : "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
  node_options=(--cloudflare)
fi

# Doubling single quotes is SQLite's own escaping.
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }

email_sql="NULL"
[ -n "$email" ] && email_sql=$(quote "$email")

sql="INSERT INTO household (id, name)
       SELECT 1, 'Koti'
       WHERE NOT EXISTS (SELECT 1 FROM household WHERE id = 1);
     INSERT INTO member (household_id, google_sub, display_name, email)
       VALUES (1, $(quote "$google_sub"), $(quote "$display_name"), ${email_sql})
       ON CONFLICT(google_sub) DO UPDATE
         SET display_name = excluded.display_name,
             email        = excluded.email;"

echo "==> adding $display_name to household 1 ($target)"
./scripts/node.sh "${node_options[@]}" npx wrangler d1 execute ruokalista "$target" \
  --command "$sql" >/dev/null

echo "==> members now"
./scripts/node.sh "${node_options[@]}" npx wrangler d1 execute ruokalista "$target" \
  --command "SELECT id, household_id, display_name, email FROM member ORDER BY id" \
  2>/dev/null | grep -E '"id"|"display_name"|"email"|"household_id"'
