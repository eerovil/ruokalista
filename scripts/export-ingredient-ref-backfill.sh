#!/usr/bin/env bash
set -euo pipefail

output="${1:-.generated/ingredient-reference-export.json}"
case "$output" in
  .generated/*) ;;
  *) echo "output must be under .generated/" >&2; exit 1 ;;
esac

mkdir -p .generated
snapshot="$(mktemp .generated/ingredient-reference-snapshot.XXXXXX.json)"
chmod 600 "$snapshot"
trap 'rm -f "$snapshot"' EXIT

gh api \
  -H "Accept: application/vnd.github.raw+json" \
  repos/eerovil/ruokalista-backup/contents/snapshot.json > "$snapshot"

./scripts/node.sh node --experimental-strip-types \
  scripts/export-ingredient-ref-backfill.ts \
  --snapshot "$snapshot" \
  --output "$output"
