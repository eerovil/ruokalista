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

Issue #186 proposes a `ruokalista-intake` Queue, bound as `INTAKE_QUEUE` for
both production and consumption by this Worker. The queue must exist before a
deploy can attach its consumer. `scripts/cloudflare-setup.sh` creates it before
migrations and deploy, tolerates an already-existing queue, and needs the
account token to carry Queues permission. Queue consumers have a separate
15-minute wall-clock limit, so an import continues after its browser request
has ended; `waitUntil()` would provide only 30 seconds after a disconnect.
The proposed five-minute Cron Trigger recreates a lost queue message from D1
after a 16-minute worker lease expires. It also removes `intake/` R2 objects
that have had no D1 reference for a day, while leaving the source of a real
failed import available for its explicit retry.

`SESSION_SECRET` is generated during setup and never stored anywhere, so a
signed-in session on the live Worker cannot be forged from this host — the live
signed-in path can only be exercised through a real browser sign-in.

## Google Cast receiver

The custom Web Receiver at
`https://ruokalista.eerovil.workers.dev/cast/receiver` (#176) is registered in
the Google Cast SDK Developer Console as application `0B89A6BA` and published,
and that id is stored in the Worker:

    ./scripts/node.sh --cloudflare npx wrangler secret put CAST_APP_ID

The application id is an identifier rather than a credential — every sender
page carries it in plain HTML; a Worker secret is used only so it could be
configured without baking a not-yet-created id into `wrangler.jsonc`. Leaving
it unset keeps the Cast action absent and avoids loading Google's sender SDK.
For a local device test, pass the id to the containerized `wrangler dev`
command as `--var CAST_APP_ID:<id>`; the harmless `test-cast-app` value used by
Playwright is served only to its stubbed SDK and cannot launch a device.

Registration and publishing happen in Google's console, outside this repo.

**A Cast device only learns about the app when it restarts.** Registering the
device, or publishing the receiver, changes nothing on a device that has been
up for hours: the browser then reports `NO_DEVICES_AVAILABLE` even though
Chrome's own Cast menu lists the TV, because that menu ignores which app is
being asked for. Unplug the device for ten seconds. To tell a device-side
problem from a page-side one without a browser, ask the device directly from
this host — `pychromecast`'s `start_app` on the receiver's id fails while
`start_app("CC1AD845")`, Google's default receiver, succeeds. Its
`/setup/eureka_info` also reports `uptime`, which is how long it has been since
the device last picked up a change.

## The shopping-list service

`SOSTOSLISTA_API_TOKEN` is the bearer secret of **s-ostoslista-worker**
(`https://s-ostoslista-worker.eerovil.workers.dev`, repo
`eerovil/s-ostoslista-client`) — a separate Worker that keeps a D1 copy of one
S-ryhmä shopping list in two-way sync with the S-ostoslista phone app, on a
five-minute cron. It lets this app put things on that real list.

It is not a direct S-ryhmä/AppSync credential and does not expose the phone's
underlying identity token. Its blast radius is still the bound real shopping
list: the service accepts authenticated reads and writes for that list, and its
five-minute sync propagates those writes to the list used by the phone. A
leaked token can therefore read and modify the shopping list through the
service. Keep it as a Worker secret, and rotate it on both sides if exposed.

`scripts/save-ostoslista-token.sh` stores it the same way as the Anthropic key —
`.dev.vars` for local development, a Worker secret for the deployed app — and
then checks it against the service's `/status`, printing only the bound list id
and item count.

The deployed Worker reaches the service over the `SOSTOSLISTA_SERVICE` **service
binding** in `wrangler.jsonc`, not over its public URL, and this is not a
preference. Both Workers live on `eerovil.workers.dev`, and Cloudflare will not
route one Worker's `fetch` to another Worker on the same zone: it answers with
an HTML error page instead, which reached `SOstoslistaClient` as *"invalid
JSON"* on every single call and made the whole integration look broken the first
time it ran in production. A binding goes Worker to Worker inside Cloudflare and
never leaves the network. The bearer token is still required — a binding skips
the public hop, not the service's own authentication.

Setting `SOSTOSLISTA_SERVICE_URL` switches the app back to plain HTTP at that
URL. There is deliberately no such var in `wrangler.jsonc`, so production always
uses the binding; the browser tests set it to reach their fixture. The service's
API is `GET /products?q=` to search the shop's catalogue, `POST /items {"ean"}`
or `{"note"}` to add, and `DELETE /items?ean=`/`?note=` to remove; product images
come from `https://cdn.s-cloud.fi/v1/w256_q75/product/ean/{EAN}_kuva1.jpg`, which
needs no auth. Its README documents the rest.

The integration also requires `SOSTOSLISTA_HOUSEHOLD_ID`, the one Ruokalista
household allowed to see or use it, and the remote service must have product
search enabled. Leaving the token or the household gate unset deliberately hides
every integration route and control rather than exposing a half-configured
action — which also means a misconfiguration looks like "the feature is off",
so check both before concluding the code is at fault.

When something does fail, interpolate the error's message into `console.error`
rather than passing the `Error` as a second argument. Workers Logs keeps the
stack frames but drops the message, and the message is the only part that says
what went wrong.

Local browser tests do not use those credentials. Playwright starts a small
contract fixture on the port after `PLAYWRIGHT_PORT` and passes harmless
`--var` bindings to local Wrangler, so search/add/error coverage can never touch
the real private list.

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
