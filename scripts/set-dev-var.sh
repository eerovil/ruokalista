#!/usr/bin/env bash
#
# Upsert KEY into .dev.vars, taking the value from a named environment variable
# so it never appears in a command line, an argument list, or shell history.
#
#   ./scripts/set-dev-var.sh GOOGLE_CLIENT_ID client_id
#
# .dev.vars is gitignored and holds local development values only.
#
set -euo pipefail

key="${1:?usage: set-dev-var.sh KEY ENV_VAR_NAME}"
source_var="${2:?usage: set-dev-var.sh KEY ENV_VAR_NAME}"
value="${!source_var:-}"

[ -n "$value" ] || { echo "nothing in \$$source_var" >&2; exit 1; }

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
touch .dev.vars

scratch=$(mktemp)
trap 'rm -f "$scratch"' EXIT
grep -v "^${key}=" .dev.vars > "$scratch" || true
printf '%s="%s"\n' "$key" "$value" >> "$scratch"

cat "$scratch" > .dev.vars
chmod 600 .dev.vars

echo "$key set in .dev.vars (${#value} characters)"
