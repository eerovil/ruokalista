#!/usr/bin/env bash
#
# Save the Cloudflare API token on this host, so wrangler commands stop needing
# a fresh handover every time.
#
#   agentdeck secret-run <ticket> -- ./scripts/save-cloudflare-token.sh cloudflare_secret
#
# The value is read from the named environment variable, never from an argument.
#
# It is written OUTSIDE the repository, mode 600. Not .dev.vars: that file is
# loaded into the Worker's environment during local development, which would put
# an account-wide API token where application code can read it.
#
set -euo pipefail

source_var="${1:?usage: save-cloudflare-token.sh ENV_VAR_NAME}"
value="${!source_var:-}"
# Passed in rather than baked in: this repository is public, and an account id
# is not a secret but is nobody else's business either.
account="${2:-${CLOUDFLARE_ACCOUNT_ID:-}}"

[ -n "$value" ] || { echo "nothing in \$$source_var" >&2; exit 1; }
[ -n "$account" ] || {
  echo "usage: save-cloudflare-token.sh ENV_VAR_NAME <account id>" >&2
  exit 1
}

target="${RUOKALISTA_CLOUDFLARE_ENV:-$HOME/.local/share/ruokalista/cloudflare.env}"
mkdir -p "$(dirname "$target")"

umask 077
cat > "$target" <<EOF
CLOUDFLARE_API_TOKEN="$value"
CLOUDFLARE_ACCOUNT_ID="$account"
EOF
chmod 600 "$target"

echo "saved to $target (${#value} characters, mode $(stat -c %a "$target"))"
