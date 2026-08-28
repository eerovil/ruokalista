# Working on this repo as an agent

Conventions for driving this repo as an agent: the issue tracker, triage labels,
verification tiers, domain docs, and workflow lessons other sessions have hit.

### Issue tracker

Issues, PRDs and wayfinder maps live in this repo's GitHub Issues, driven with
the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage labels, unchanged: `needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`. See
`docs/agents/triage-labels.md`.

### Verification

Focused locally, complete in CI: the typecheck, the checks and the specs that
cover what you changed, then let the pull request's CI run the whole browser
suite. A review pass reruns what its own fix could have broken, not the
sequence again. See `docs/agents/verification.md`.

### Domain docs

Single-context: `CONTEXT.md` at the repo root plus `docs/adr/`. Both exist —
`CONTEXT.md` is the glossary to use, and the ADRs record decisions that go past
what the wayfinder map locked. See `docs/agents/domain.md`.

## Repo-wide facts worth checking before assuming otherwise

- **`main` has no branch protection at all** — confirmed live via
  `gh api repos/eerovil/ruokalista/branches/main/protection` (404, "Branch not
  protected"). A pull request's `mergeStateStatus` shows `UNSTABLE`/`CLEAN`
  rather than `BLOCKED` even before any CI run exists, and GitHub will let it
  merge with zero required checks. CI (`.github/workflows/ci.yml`) is still the
  gate every session should respect; nothing stops a push around it.
- Before concluding a repo's CI is broken or a push failed to trigger it, check
  `https://www.githubstatus.com/api/v2/summary.json` first. One session spent
  8+ minutes debugging what looked like a misconfigured workflow (zero runs
  created repo-wide) before finding an active GitHub Actions incident — a free,
  fast, decisive check that rules the repo out entirely.

## Reviewing a pull request

- A review can hand off into fixing within the same thread when a skill or a
  poller dispatch says so (`review-fix-pr`) — "a review session never touches
  code" is not a repo rule. What a *merge-review*-only dispatch does forbid is
  opening a docs-only PR for pure investigation.
- Before pushing to a shared branch, confirm nobody else pushed in the
  meantime: `git fetch origin <branch> && git merge-base --is-ancestor
  FETCH_HEAD HEAD` before `git push origin HEAD:<branch>`.
- A dedicated "verify the fix, don't just re-run tests" pass — handing a
  `Plan`-type agent the diff between the "found" and "fixed" commits and
  asking it to check the fix is actually sound — surfaces different bugs than
  the original review pass does; it has caught real bugs (a wrong JPEG marker
  exclusion, a comment split in half by an inserted code block) that no test
  failure would have shown.
- Watch for a form refusal that calls `problem()` (`src/html.ts`'s JSON refusal
  helper, used by API routes — see `src/auth.ts::requireAdmin`,
  `src/intake-screens.ts`) from a screen-rendering route instead of
  re-rendering with `<p class="refused">`: it dumps the member into raw JSON
  and loses what they typed. Every other refusal in the app re-renders the
  screen; this is easy to miss because the code still "handles" the error,
  just not in the expected shape.
- Grilling (this host's global rule: grill before non-trivial work) is skipped
  only when the issue text has already settled every product decision it would
  raise — not just because the agent judges the issue "clear enough" from its
  own read.
- When a PR's branch falls behind `main` mid-review, prefer `git merge
  origin/main` over rebase (no force-push needed to update a branch someone
  else may also be watching), resolve conflicts preserving both intents, then
  rerun verification proportional to what the merge actually touched before
  pushing the merge commit — the conflicted files' specs, not the whole suite,
  unless the conflicts were broad enough that you cannot say what they reach.
- A merge conflict that touches `docs/screenshots/*.png` is not a PNG diff to
  resolve by hand: resolve the code first, then regenerate the screenshot from
  the merged app (`PLAYWRIGHT_SCREENSHOTS=1 ./scripts/playwright.sh npx playwright test screenshots`).
  Confirmed still current — `docs/screenshots/13-dish-in-parts.png` and
  `14-scaled.png` exist and are exactly the pair one session regenerated after
  a conflict between two PRs that both touched shared recipe rendering.

## Coordinator / subagent sessions

- Only the top-level session spawns subagents; synthesis, decisions and code
  edits stay in the main thread. A coordinator session working a single issue
  can run several read-only investigation subagents in parallel (grounding
  evidence, architecture research, correctness review) and only act on their
  findings itself.
- A poller session convention: register the worktree and post a plan comment
  to the issue before starting, and recompute a "review surface" diffstat
  (source/tests/docs/generated buckets via `git diff --numstat`) before the
  terminal PR/issue comment, so the human reviewer knows where to look first.
- An issue can be filed as research/spec rather than a fully-specified ask —
  a goal, constraints, and open questions to resolve. The investigating
  subagent's own output (a seam table, key findings, a minimal integration
  design) can end up as the PR's actual design; if `docs/agentdeck-recipe-bundles.md`
  or `src/batch-intake.ts` need revisiting for "why this shape", that is where
  the reasoning lived.

## This repo's own origin

The wayfinder map and its process were bootstrapped by an agent session: it
scaffolded `docs/agents/*.md`, the `wayfinder:*` and triage GitHub labels, then
ran the `/wayfinder` charting session that produced the map issue and its
sub-issue tickets. Background research subagents launched with
`isolation: "worktree"` resolved two of those tickets by reading real recipe
site HTML and inspecting the host; that research lives only as GitHub issue
comments (`gh issue view --comments`) on the closed tickets, not in any repo
file.

`gh issue close <n> --comment "..."` has been seen to fail silently (no output,
issue stays open) — verify the issue's state afterward rather than trusting a
combined comment+close call succeeded.
