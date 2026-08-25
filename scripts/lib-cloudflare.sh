# Load the Cloudflare credentials saved on this host, if there are any.
# Sourced, not executed.
#
# Kept outside the repo and outside .dev.vars — that file is loaded into the
# Worker's own environment during local development, which is no place for an
# account-wide API token. Written by scripts/save-cloudflare-token.sh.

cloudflare_env="${RUOKALISTA_CLOUDFLARE_ENV:-$HOME/.local/share/ruokalista/cloudflare.env}"
if [ -f "$cloudflare_env" ]; then
  # shellcheck disable=SC1090
  set -a
  . "$cloudflare_env"
  set +a
fi
unset cloudflare_env
