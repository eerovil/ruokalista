# Cloudflare and deployment

Setup, secrets, R2 for recipe images, and the nightly D1 backup/restore system.

## Cloudflare

Live at https://ruokalista.eerovil.workers.dev, D1 database `ruokalista`
(`f81fabeb-…`), `SESSION_SECRET` set as a Worker secret.

Credentials live in `~/.local/share/ruokalista/cloudflare.env` (mode 600), which
`scripts/lib-cloudflare.sh` sources into every script that needs them. Not
`.dev.vars`: that file is loaded into the Worker's own environment during local
development, which is no place for an account-wide API token.

`scripts/cloudflare-setup.sh` does the whole setup in one command and is safe to
re-run. `push-google-secrets.sh` pushes the Google credentials and deploys;
`add-member.sh` inserts a member, which is the only way anybody gets in.

Recipe images (#88) add an R2 bucket, `ruokalista-recipe-images`, bound as
`RECIPE_IMAGES`. **R2 must be enabled per-account before first use, and nothing
in the repo can do that** — the Cloudflare API refuses bucket creation with
`{"code": 10042, "message": "Please enable R2 through the Cloudflare
Dashboard."}` until a human flips it on once. This blocked PR #89 from merging:
merging to `main` applies migrations and then deploys, so deploying first would
have left production with the new `image_key` column applied and a failed
deploy (old Worker code still live). Turning R2 on has to happen before that
merge, or production gets the new column and keeps the old Worker.

`cloudflare-setup.sh`'s R2 step is create-and-tolerate, not list-then-create:
`wrangler r2 bucket list`'s output shape has changed across wrangler versions,
so the script runs `wrangler r2 bucket create "$BUCKET_NAME"` unconditionally
and treats an `already exists`/`already owned` substring in the failure output
as success rather than parsing a list. That step sits above the script's
`set +e` section (`set -euo pipefail` still in force) on purpose: a
missing/unreachable R2 bucket is fatal to the whole setup run, whereas the
steps after `set +e` — remote migrations, deploy, `SESSION_SECRET` — are
allowed to fail individually and land in a `note_failure` list, so a
partial-permission token still gets as far as it can. Deploy runs before the
`SESSION_SECRET` step because `wrangler secret put` needs the Worker to exist,
which on a first run it does not until that deploy creates it — the Worker is
briefly live without `SESSION_SECRET`, which is the 503 path, not an open one.

`wrangler deploy --dry-run` proves a binding (R2 or otherwise) resolves without
actually deploying — it prints the bindings table (e.g.
`env.RECIPE_IMAGES (ruokalista-recipe-images) R2 Bucket`) and exits.

## The shopping-list service

`SOSTOSLISTA_API_TOKEN` is the bearer secret of **s-ostoslista-worker**
(`https://s-ostoslista-worker.eerovil.workers.dev`, repo
`eerovil/s-ostoslista-client`) — a separate Worker that keeps a D1 copy of one
S-ryhmä shopping list in two-way sync with the S-ostoslista phone app, on a
five-minute cron. It lets this app put things on that real list.

It is **not** an S-ryhmä credential. That service holds the app's AppSync key
and the phone's identity token; ruokalista only ever holds a bearer token for
the service's own API, so a leak here cannot touch S-ryhmä accounts and is
rotated with one `wrangler secret put` on either side.

`scripts/save-ostoslista-token.sh` stores it the same way as the Anthropic key —
`.dev.vars` for local development, a Worker secret for the deployed app — and
then checks it against the service's `/status`, printing only the bound list id
and item count.

The service's URL is `SOSTOSLISTA_SERVICE_URL`, a plain var in `wrangler.jsonc`
rather than a secret. Its API is `GET /products?q=` to search the shop's
catalogue, `POST /items {"ean"}` or `{"note"}` to add, and
`DELETE /items?ean=`/`?note=` to remove; product images come from
`https://cdn.s-cloud.fi/v1/w256_q75/product/ean/{EAN}_kuva1.jpg`, which needs no
auth. Its README documents the rest.

`SESSION_SECRET` is generated during setup and never stored anywhere, so a
signed-in session on the live Worker cannot be forged from this host — the live
signed-in path can only be exercised through a real browser sign-in.

## Backups

A Cron Trigger (`wrangler.jsonc`, `"17 2 * * *"`, UTC) calls the Worker's
`scheduled` handler, which runs `scheduledBackup` (`src/backup-scheduled.ts`) —
kept independent of the HTTP router — which calls `runNightlyBackup`
(`src/backup.ts`). It snapshots D1 and pushes it to the `eerovil/ruokalista-backup`
GitHub repository as `snapshot.json`, authenticated with the
`BACKUP_GITHUB_TOKEN` secret (declared in `wrangler.jsonc` and `src/env.ts`).

The backup is manifest-driven, and this is the part that is easy to get wrong:
`BACKUP_TABLES` in `src/backup.ts` (`household`, `member`, `ingredient`,
`recipe`, `recipe_step`, `ingredient_line`, `planned_batch`,
`batch_occurrence`, each with its row ordering) is the single list that drives
snapshot capture, row ordering, schema comparison and post-restore comparison.
`scripts/check-backup-schema.ts` (`npm run check:backup-schema`) fails the
build if the live migrated tables and `BACKUP_TABLES` disagree — there is no
separate "did you forget the new table" check; that diff *is* the check.

Any schema change that adds or removes a table must update, in lockstep:
`BACKUP_TABLES` (`src/backup.ts`); `RESTORE_ORDER` in `src/restore.ts` (new
tables must come after the tables they reference — e.g. `planned_batch` after
`household`/`member`/`recipe`, `batch_occurrence` after `planned_batch`);
`validateRelationships()` in `src/restore.ts` (FK and uniqueness-key checks);
the fixtures in `dev/check-restore.ts` and `dev/check-backup.ts`; the seed
cleanup in `dev/seed.sql`; and the round-trip drill in
`scripts/check-restore-roundtrip.ts` (`npm run check:restore-roundtrip`), which
migrates and seeds a throwaway local D1 under `.wrangler/restore-roundtrip/`,
snapshots it, restores into a second throwaway database, and compares. #57
touched all of these for the `meal_entry` → `planned_batch`/`batch_occurrence`
split.

`scripts/restore-backup.ts` (`npm run restore:backup`) applies a snapshot back
into a D1 database, local or remote. It refuses to run against
`PRODUCTION_DATABASE_ID` (`f81fabeb-b38f-453d-8966-dfe52c721341`) or the
selectors `ruokalista`/`DB` unless the caller is explicit about targeting
production — restoring is a destructive, one-way overwrite.

The backup covers D1, not R2. A restored snapshot therefore carries
`recipe.image_key` values whose bytes may be gone; the recipe screen falls back
to the placeholder, which is the same thing it does for a recipe that never had
a picture.

See also `docs/codebase/data-model.md` for the schema `BACKUP_TABLES` mirrors,
and `docs/codebase/testing.md` for how `npm run check` fits alongside the
backup-specific checks.
