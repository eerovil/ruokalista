#!/usr/bin/env bash
#
# Run the browser tests. Same idea as node.sh, but in Microsoft's Playwright
# image, which already carries the browsers — installing them into the plain
# node image would need root for apt.
#
#   ./scripts/playwright.sh npx playwright test
#   ./scripts/playwright.sh npx playwright test --update-snapshots
#
# --network=host so the config's own `wrangler dev` is reachable at 127.0.0.1.
#
# The two variables playwright.config.ts reads are forwarded into the container.
# PLAYWRIGHT_PORT especially: it is the documented remedy for two agent
# worktrees sharing this host, and until it was passed through, setting it
# changed nothing. Both worktrees then ran on 8787, and `reuseExistingServer`
# meant one suite quietly tested the other worktree's code against the other
# worktree's database — which reads as ECONNREFUSED and scattered nonsense
# failures, not as contention.
#
set -euo pipefail

run_env=()
for name in PLAYWRIGHT_PORT PLAYWRIGHT_WALKTHROUGH; do
  [ -n "${!name:-}" ] && run_env+=(-e "$name=${!name}")
done

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
container_home="${RUOKALISTA_CONTAINER_HOME:-$HOME/.local/share/ruokalista/home}"
mkdir -p "$container_home"

run_flags=(-i)
[ -t 0 ] && run_flags+=(-t)

exec podman run --rm "${run_flags[@]}" \
  --network=host \
  -v "$repo":/app:Z \
  -v "$container_home":/home/dev:Z \
  -w /app \
  -e HOME=/home/dev \
  -e CI=1 \
  "${run_env[@]+"${run_env[@]}"}" \
  --userns=keep-id \
  mcr.microsoft.com/playwright:v1.62.1-noble \
  "$@"
