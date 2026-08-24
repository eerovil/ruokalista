#!/usr/bin/env bash
#
# Store GOOGLE_CLIENT_SECRET in .dev.vars and check the pair against Google.
# Expects the secret in $client_secret and the id already in .dev.vars.
#
# The check deliberately exchanges an invalid authorization code. Google's reply
# distinguishes the two failures that matter:
#
#   invalid_client  the id or the secret is wrong
#   invalid_grant   Google accepted the credentials and rejected the code,
#                   which is exactly what a good pair does here
#
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

./scripts/set-dev-var.sh GOOGLE_CLIENT_SECRET client_secret

client_id=$(sed -n 's/^GOOGLE_CLIENT_ID="\(.*\)"$/\1/p' .dev.vars)
[ -n "$client_id" ] || { echo "no GOOGLE_CLIENT_ID in .dev.vars" >&2; exit 1; }

response=$(curl -s -X POST https://oauth2.googleapis.com/token \
  --data-urlencode "code=deliberately-invalid-code" \
  --data-urlencode "client_id=${client_id}" \
  --data-urlencode "client_secret=${client_secret}" \
  --data-urlencode "redirect_uri=http://127.0.0.1:8787/auth/google/callback" \
  --data-urlencode "grant_type=authorization_code")

# Only the error name is echoed; the rest of the body is not printed.
error=$(printf '%s' "$response" \
  | grep -oE '"error"[[:space:]]*:[[:space:]]*"[a-z_]+"' \
  | grep -oE '"[a-z_]+"$' | tr -d '"')

case "$error" in
  invalid_grant)
    echo "RESULT: credentials accepted by Google (invalid_grant on the fake code)"
    ;;
  invalid_client)
    echo "RESULT: Google rejected the credentials (invalid_client)"
    exit 1
    ;;
  *)
    echo "RESULT: unexpected reply, error=${error:-none}"
    exit 1
    ;;
esac
