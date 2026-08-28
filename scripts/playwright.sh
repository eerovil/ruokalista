#!/usr/bin/env bash
#
# Run the browser tests. Same idea as node.sh, but in Microsoft's Playwright
# image, which already carries the browsers — installing them into the plain
# node image would need root for apt.
#
#   ./scripts/playwright.sh npx playwright test
#   ./scripts/playwright.sh npx playwright test --update-snapshots
#   PLAYWRIGHT_SCREENSHOTS=1 ./scripts/playwright.sh npx playwright test screenshots
#
# --network=host so the config's own `wrangler dev` is reachable at 127.0.0.1.
#
# The variables playwright.config.ts reads are forwarded into the container.
# PLAYWRIGHT_PORT especially: it is the documented remedy for two agent
# worktrees sharing this host, and until it was passed through, setting it
# changed nothing. Both worktrees then ran on 8787, and `reuseExistingServer`
# meant one suite quietly tested the other worktree's code against the other
# worktree's database — which reads as ECONNREFUSED and scattered nonsense
# failures, not as contention.
#
# A different port is not enough on its own, because the local D1 file lives in
# the checkout: two runs over the *same* checkout fight over the same SQLite
# file whatever ports they use. That happened for real (#128) because killing
# this script did not kill the container — the orphan kept holding the database,
# the next run failed with SQLITE_BUSY, and the agent read those failures as
# bugs in the tests and started editing them. Hence the two guards below: one
# run per checkout at a time, by name, and a best-effort stop on the way out.
#
set -euo pipefail

run_env=()
for name in PLAYWRIGHT_PORT PLAYWRIGHT_WALKTHROUGH PLAYWRIGHT_SCREENSHOTS; do
  [ -n "${!name:-}" ] && run_env+=(-e "$name=${!name}")
done

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
container_home="${RUOKALISTA_CONTAINER_HOME:-$HOME/.local/share/ruokalista/home}"
mkdir -p "$container_home"

# Named after the checkout, so a second run over the same files is refusable and
# so a leftover one can be stopped by name instead of identified by inspection.
# The hash keeps two worktrees with the same basename apart.
repo_slug="$(printf '%s' "$(basename "$repo")" | tr -c 'a-zA-Z0-9_.-' '-')"
repo_hash="$(printf '%s' "$repo" | sha256sum | cut -c1-8)"
container="ruokalista-pw-${repo_slug}-${repo_hash}"

if [ -n "$(podman ps --filter "name=^${container}\$" --format '{{.ID}}')" ]; then
  cat >&2 <<EOF
refusing to start: a browser run is already using this checkout

  checkout:  $repo
  container: $container

Both runs would share this checkout's local D1 file, so the second one fails
with SQLITE_BUSY or empty pages. Those failures are contention, not bugs in the
code under test — do not "fix" them.

Wait for the running suite, or end it with:

  podman stop $container
EOF
  exit 1
fi

stop_container() {
  podman stop --time 5 "$container" >/dev/null 2>&1 || true
}
# Ctrl-C used to leave the container running; now it does not.
trap 'stop_container; exit 130' INT TERM
trap stop_container EXIT

run_flags=(-i)
[ -t 0 ] && run_flags+=(-t)

status=0
podman run --rm --name "$container" "${run_flags[@]}" \
  --network=host \
  -v "$repo":/app:Z \
  -v "$container_home":/home/dev:Z \
  -w /app \
  -e HOME=/home/dev \
  -e CI=1 \
  "${run_env[@]+"${run_env[@]}"}" \
  --userns=keep-id \
  mcr.microsoft.com/playwright:v1.62.1-noble \
  "$@" || status=$?

exit "$status"
