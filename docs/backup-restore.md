# Backup restore procedure

Ruokalista's offsite backup is the private `eerovil/ruokalista-backup` repository.
Each successful scheduled run replaces `snapshot.json`; git history is the version
history. The snapshot contains private household data. Never copy it into this public
source repository, CI artifacts, issue comments, or logs.

## Independent freshness watchdog

The watchdog deliberately runs outside Cloudflare, but it runs in this **public**
repository so GitHub-hosted Actions do not require paid private-repository minutes.
`.github/workflows/backup-freshness.yml` reads only the `scheduled_at` field from the
private backup repository and opens/closes one public `backup stale` issue here.

The workflow authenticates to `eerovil/ruokalista-backup` with Actions secret
`BACKUP_REPO_READ_TOKEN`. Use a separate fine-grained PAT restricted to that one
repository with **Contents: Read-only** (and the required Metadata read). Do not reuse
or broaden the Worker's write-capable `BACKUP_GITHUB_TOKEN`.

The watchdog must never log, persist, artifact, or issue-comment the snapshot itself.
For stale/fresh acceptance testing, `workflow_dispatch` fixture timestamps bypass the
private repository read entirely, so the alert logic can be exercised without editing
or exposing `snapshot.json`.

## Pick a backup

Work in a clone of the private backup repository and choose the commit whose snapshot
you want to recover:

```sh
git log --oneline -- snapshot.json
git show <backup-commit>:snapshot.json > /tmp/ruokalista-snapshot.json
chmod 600 /tmp/ruokalista-snapshot.json
```

The restore tool validates the format, complete app-table set, row counts, SHA-256,
duplicate keys and foreign-key relationships before allowing Wrangler to write to the
target. It then requires the migrated target schema to match the snapshot exactly and
requires every app table to be empty. A schema difference is a refusal, not something
the tool guesses through; support for an older schema must be added as an explicit
compatibility adapter and tested first.

## Local drill

Use an isolated persistence directory so the ordinary development database is not
touched:

```sh
rm -rf .wrangler/restore-drill
npm run restore:backup -- \
  --snapshot /tmp/ruokalista-snapshot.json \
  --database ruokalista \
  --local \
  --persist-to .wrangler/restore-drill
```

The command applies the repository migrations, verifies compatibility/emptiness,
restores original ids in foreign-key-safe order, runs `PRAGMA foreign_key_check`, and
reads every table back in deterministic order. The `D1 restore verified` result means the restored rows exactly
match the snapshot, not merely that the counts look plausible. It explicitly says
that image bytes were not checked: matching `recipe.image_key` strings do not
prove that the objects still exist.

CI exercises the same path from a seeded local D1 snapshot into a second empty local
D1 database with:

```sh
npm run check:restore-roundtrip
```

## Remote acceptance drill

Create a brand-new temporary D1 database for the drill. Do not reuse production and do
not point a deployed Worker at the drill database. With the normal Cloudflare
credentials available to Wrangler, restore by its explicit database name:

```sh
npm run restore:backup -- \
  --snapshot /tmp/ruokalista-snapshot.json \
  --database <temporary-d1-database-name> \
  --remote
```

The CLI has additional hard stops for the known production selectors: database name
`ruokalista`, binding `DB`, and the production D1 database id. Those guards are not a
substitute for checking the target name: the acceptance drill must use a disposable
database created for that purpose.

After a successful drill, record only non-sensitive evidence in issue #64: backup git
commit, snapshot digest, row counts, temporary database name, commands used and the
verification result. Do not paste source text, member data, ingredients, or the
snapshot itself.

Delete the temporary remote D1 database after the evidence is recorded. For a local
drill, remove the isolated persistence directory. Remove `/tmp/ruokalista-snapshot.json`
when finished.

## Failure rules

A restore must stop non-zero for an unknown backup format, checksum mismatch,
missing/unexpected app table, duplicate key, orphan relationship, recipe-parent cycle,
schema mismatch, non-empty target, failed insert, foreign-key violation, or any
post-restore row mismatch. Do not edit a snapshot by hand to get around a refusal: pick
a different historical backup or add an explicit, reviewed compatibility rule.


## Read-only image availability audit (#271, first slice of #262)

Run this independently before or after a database restore. It does not restore,
create, replace or delete any database row or bucket object. Select the intended
bucket and local/remote mode explicitly; no production bucket is selected by default.
For example, after a drill with a disposable bucket:

```sh
npm run check:backup-images -- \
  --snapshot /tmp/ruokalista-snapshot.json \
  --bucket <temporary-image-bucket-name> \
  --remote \
  --report /tmp/ruokalista-image-audit.json
```

For local storage use `--local --persist-to <isolated-state-directory>` instead
of `--remote`. Remote reads use the existing Wrangler credentials; only object-read
access is needed. No new secret or application endpoint is introduced. The command
uses Wrangler's `r2 object get --pipe` contract, documented at
https://developers.cloudflare.com/r2/reference/wrangler-commands/.

The complete snapshot is validated before any object request. Each distinct key is
read once, sequentially, including the images of recipe parts. Each download has a
60-second command timeout and the existing five-MiB image limit. Missing objects,
permission/transport failures, empty responses, over-limit bytes and unrecognized
image headers make the audit fail non-zero. `unavailable` deliberately does not
claim to distinguish absence from a permission or network failure. Without images,
the audit performs no storage request.

Console output contains only aggregate success information or a sanitized failure;
provider errors, keys, recipe IDs and private snapshot data are not printed. The
optional JSON report contains keys, recipe IDs, sizes, observed SHA-256 digests and
per-object results, including failures. It is **private**, created with mode 0600,
and refuses to overwrite an existing file or symlink. Never commit, publish or
upload this report to public CI artifacts. Remove it after the drill. A failed
snapshot validation has no image report because no objects have been audited.

**Availability is not historical identity or retention.** These snapshots do not
store the original image-byte SHA-256 values. The report's digests describe the bytes
read now; they are not compared to an original snapshot-time image manifest. Header
recognition is not a full image decode. Even a successful audit does not prove that
the file is the original photograph, will remain available tomorrow, or survives
loss of the whole bucket. Compare retained audit digests/bytes as additional drill
evidence where independent originals are available.

## Historical-image retention (#262)

[ADR-0016](adr/0016-retired-images-cover-the-snapshot-window.md) defines the proposed
application policy. It becomes effective only when the implementing release has
passed deployment and public-release verification; record that commit/time as the
rollout boundary. Finish any pre-upgrade cleanup invocation before declaring the
boundary, and audit the first supported post-rollout snapshot. Running old code or
rolling back to immediate deletion ends this protection. **It does not recover
bytes deleted before that boundary.**

For a schema-compatible snapshot captured after that release and no more than
**30 days old**, application cleanup retains its recipe-image bytes in the source
bucket. Each replaced/removed image stays for **31 days after its last successful
detachment**, irrespective of how old its upload is. This includes dish and part
images, manually uploaded/URL-imported photos and supplied generated pictures.
A one-day margin is not permission to run a live restore concurrently with cleanup.
The same queue is used by replacement, removal and whole-recipe deletion; a later
detachment after restore starts a fresh period. Current live references never
expire. No bucket-wide age-based deletion rule is introduced.

The database snapshot format and exact-schema compatibility checks are unchanged.
This is an image-availability contract for otherwise-restorable snapshots, not a
promise that arbitrary older schemas can be loaded. Keep the corresponding source
release/migrations with the backup evidence. Pre-rollout or older-than-window
snapshots require the read-only image audit and any independently preserved bytes;
do not present them as guaranteed by this policy.

### Recover without racing expiry

1. Choose a schema-compatible snapshot in the supported window. For a real recovery,
   quiesce **all application writes, queue consumers and scheduled cleanup** before
   restoring references. Keep them stopped through byte verification and cutover.
   There is no automatic production-maintenance switch in this change. The existing
   CLI still refuses known production targets; use a disposable database for drills.
   A drill that takes an extra day or approaches expiry needs a separately secured
   copy or paused cleanup, not reliance on the safety margin alone.
2. Run `check:backup-images` against the intended bucket before restoring. A missing
   or unreadable image is a refusal, not permission to continue with a broken photo.
   Preserve private digest evidence only in an authorized private location.
3. Restore into the empty compatible target using the existing procedure, verify
   exact rows, then run the image audit again. Compare original digest/byte evidence
   where available. The existing D1-only success message is still not whole-system
   recovery evidence. Never repair a missing photo by silently substituting a new one.
4. Resume writes and cleanup only after a verified cutover. Restored current image
   references are excluded from cleanup; replacing/removing them later renews their
   retirement timestamps. Record the snapshot digest, source release, target, image
   audit outcome and cutover evidence privately before resuming.

Restoring an older database can lose cleanup receipts for images created after its
snapshot. Their bytes are left in place (safe but possibly untracked); this change
adds no orphan scanner. Reconcile only with all supported snapshots accounted for,
never with an indiscriminate upload-age deletion rule. Persistent R2/D1 failures
also extend retention and storage growth; they must remain visible through
`recipe.image_cleanup_pending`, `recipe.image_cleanup_failed` and
`recipe.image_retention_unrecorded`. A database error after an upload is an uncertain
commit, so conservative retention may leave extra bytes pending reconciliation.

### Evidence, storage and exclusions

The read-only production configuration probe on **2026-09-08 13:43:07 UTC** found
zero bucket-lock rules and no enabled object-expiration rules; the enabled lifecycle
rule includes aborting unfinished multipart uploads. Evidence is in
[issue #262](https://github.com/eerovil/ruokalista/issues/262#issuecomment-5586125336).
The probe read no object data and changed no bucket settings. Configuration can
change: recheck it before relying on a recovery promise. An administrator or external
retention policy can still remove bytes outside this application's controls.

The repository-backed archive stores database snapshots, not image bytes. Independent
image copies outside the inspected system remain unverified. **Complete bucket loss
is not covered.** It requires a verified independent image archive, paired snapshot
and original-byte manifests, and a separate recovery drill. Same-bucket retention
and a successful availability audit cannot supply that protection.

Expected storage is current images plus retired versions awaiting their 31-day
expiry (at most five MiB per accepted image); retry backlogs and restore orphans can
exceed that estimate. No new service, archive destination, lifecycle configuration
or scheduler is introduced. Local original-byte drills in
`dev/check-image-retention.ts` exercise replacement/removal/deletion, both picture
provenances, both recipe levels, renewal, rollback, lost commit responses and expiry.
Full production recovery/independent-copy evidence remains a separate acceptance
step; keep #262 open until its agreed scope and release evidence are satisfied.
