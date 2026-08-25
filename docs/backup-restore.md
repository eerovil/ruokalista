# Backup restore procedure

Ruokalista's offsite backup is the private `eerovil/ruokalista-backup` repository.
Each successful scheduled run replaces `snapshot.json`; git history is the version
history. The snapshot contains private household data. Never copy it into this public
source repository, CI artifacts, issue comments, or logs.

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
reads every table back in deterministic order. Success means the restored rows exactly
match the snapshot, not merely that the counts look plausible.

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
