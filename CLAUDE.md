# ruokalista

A recipe store: a Cloudflare Worker in TypeScript over D1. The wayfinder map
(issue #1) holds the decisions that were expensive to reverse, and `docs/spec.md`
is the v1 build spec — the schema, the screens and the intake flow, end to end.

v1 is being built in thin vertical slices, one PR per working thing. An earlier
attempt built it all in one 36-commit PR (#13, closed unmerged); it drifted from
the spec and grew three stacked fetch handlers, and none of it was reviewable.
Hence the slices, and hence the rule below.

This file is the index. It holds what is true across the whole app; each
subsystem's depth lives in `docs/codebase/`, read on demand.

## One fetch handler

`src/index.ts` is the only `fetch` handler and `src/router.ts` is the only place
a request is matched. There is one `Env` (`src/env.ts`), bound once and passed
down; nothing copies or rewrites it, and nothing smuggles identity through it.
This is the shape the closed attempt got wrong, so it is written down.

Every route that touches household data is wrapped in `requireMember`
(`src/auth.ts`), and every query below it takes the member's `household_id` as a
parameter. There is no other way in. Another household's record is a 404, not a
403 — whether it exists is not this household's business.

## The map

| Area | Where it lives |
| --- | --- |
| Routing and the one handler | `src/index.ts`, `src/router.ts`, `src/env.ts` |
| Sign-in, sessions, admin | `src/auth.ts`, `src/signin.ts`, `src/members.ts`, `src/admin-screens.ts` |
| Recipes, parts, scaling | `src/recipes.ts`, `src/recipe-save.ts`, `src/recipe-editor.ts`, `src/scaling.ts`, `src/recipe-phase.ts` |
| Importing a recipe | `src/intake.ts`, `src/intake-screens.ts`, `src/batch-intake.ts`, `src/line-form.ts` |
| Pictures | `src/recipe-images.ts`, `src/image-generation.ts`, `src/contact-sheet.ts`, `src/png.ts` |
| The week and planned batches | `src/menu.ts`, `src/week-screens.ts` |
| The shopping list | `src/shopping.ts`, `src/shopping-screens.ts` |
| Markup and the shell | `src/html.ts` |
| Schema and backups | `migrations/`, `src/backup.ts`, `src/restore.ts` |

## Read before you work on it

- [dev-environment](docs/codebase/dev-environment.md) — read before running anything locally: the container, the dev server, `.dev.vars`, and signing in without Google.
- [auth](docs/codebase/auth.md) — read before working on sign-in, sessions, household isolation, or the admin boundary.
- [recipes](docs/codebase/recipes.md) — read before working on a recipe's shape, multipart dishes, cooking-order phases, or portion scaling.
- [intake](docs/codebase/intake.md) — read before working on recipe import, the AgentDeck batch-upload path, or the model-cost dial.
- [recipe-images](docs/codebase/recipe-images.md) — read before working on recipe pictures: uploads, freshness, or the batch generator.
- [data-model](docs/codebase/data-model.md) — read before working on the D1 schema, a migration, or the backup and restore manifest.
- [screens](docs/codebase/screens.md) — read before working on a screen's markup, an inline browser script, or old-browser support.
- [testing](docs/codebase/testing.md) — read before working on any test, check, or CI change.
- [deploy-cloudflare](docs/codebase/deploy-cloudflare.md) — read before working on Cloudflare setup, secrets, R2, or a backup.
- [agent-workflow](docs/codebase/agent-workflow.md) — read before working on this repo as an agent: issues, triage, verification tiers, review and merge.

## What will catch you out

Each of these has cost somebody real time. The detail is in the linked doc.

- **Merging to `main` is a production release.** CI applies any new migration
  against the live D1 database and then deploys, unattended, with no staging —
  and `main` has no branch protection, so nothing blocks a merge whose CI never
  ran. See [deploy-cloudflare](docs/codebase/deploy-cloudflare.md).
- **A fresh worktree cannot run anything yet.** `.dev.vars` and `node_modules`
  are untracked, so `git worktree add` carries neither. The first symptom is an
  unrelated-looking `ENOENT` deep in test support code, or `tsc: not found` —
  not a message telling you to set up. See
  [dev-environment](docs/codebase/dev-environment.md).
- **Two agent worktrees at once break each other's tests.** Both default to port
  8787 and share one local D1 database, which reads as connection-refused and
  lock flakiness rather than as contention. Set `PLAYWRIGHT_PORT` in one of
  them. See [testing](docs/codebase/testing.md).
- **A new API key needs two places, not one.** A key in `.dev.vars` never
  reaches the Worker unless it is also listed in `wrangler.jsonc`'s
  vars-exposure block. See [deploy-cloudflare](docs/codebase/deploy-cloudflare.md).
- **An inline browser script is shipped untranspiled.** Write ES5, and remember
  that these scripts are template literals, so a backslash is eaten before the
  browser ever sees it — no regular expressions. See
  [screens](docs/codebase/screens.md).
- **Adding or removing a table means six files, in lockstep.** `BACKUP_TABLES`
  in `src/backup.ts`, `RESTORE_ORDER` and `validateRelationships` in
  `src/restore.ts`, the fixtures in `dev/check-restore.ts` and
  `dev/check-backup.ts`, `dev/seed.sql`, and
  `scripts/check-restore-roundtrip.ts`. `scripts/check-backup-schema.ts` catches
  only the first one being forgotten. See
  [data-model](docs/codebase/data-model.md).
- **Model calls cost real money and the budget is small.** Almost everything
  about intake is testable without spending anything; only call the model when
  the model call itself changed. See [intake](docs/codebase/intake.md).
- **`docs/spec.md` has drifted.** It still describes `meal_entry` as current and
  the planned-batch model as a proposal; the swap merged in #57/#86. Trust the
  code and [data-model](docs/codebase/data-model.md) over the spec on schema.
- **Touching `src/auth.ts`, `src/router.ts`, `src/index.ts`, `src/env.ts` or a
  migration is full-tier.** No focused spec covers them, so run the whole
  browser suite. See [agent-workflow](docs/codebase/agent-workflow.md).

## Conventions

- **Finnish in the product, English in the repo.** Every screen, label and
  message a household reads is Finnish; code, comments, commits, issues and
  these docs are English.
- **Refuse in the right shape.** A screen's refusal re-renders the screen with
  `<p class="refused">` and the member's input intact. `problem()` is the JSON
  API's refusal helper — using it on a screen dumps the member into raw JSON and
  loses what they typed.
- **Cite `file.ts::symbol`, never a line number.** Line numbers rot at the next
  refactor. Issue and PR numbers and commit shas are fine.
- **A decision that outlives its PR goes in `docs/adr/`**, and a term the
  household uses goes in `CONTEXT.md`.
- Defer to `README.md` for the exhaustive command list; these docs complement it
  rather than repeat it.
