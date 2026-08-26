# The data model

The D1 schema, its migrations, and what has moved past `docs/spec.md` — read that first, this is the drift and the reasoning behind it.

## Schema conventions

D1 is SQLite, so the model from #5 and #6 lands without translation. Migrations
live in `migrations/`, applied with `wrangler d1 migrations apply`. Ids are
`INTEGER PRIMARY KEY` (SQLite rowid aliases — small, household-private, never
shown to the world). Timestamps are ISO 8601 text in UTC. Dates are
`YYYY-MM-DD` text, compared as strings, which sorts correctly. Every table that
holds household data carries `household_id`, and every query filters on it.
`docs/spec.md`'s `0001_init.sql` listing is still the base shape: `household`,
`member`, `ingredient`, `recipe`, `recipe_step`, `ingredient_line`. What follows
is everything the later migrations changed.

## `meal_entry` is gone: `planned_batch` + `batch_occurrence`

Issue #57 replaced `meal_entry` with two tables
(`migrations/0005_planned_batches.sql`), and `docs/spec.md`'s description of a
single `meal_entry` row is superseded. A **planned batch** is one cooking of
one recipe — stable identity, household, recipe, portions, creator — and it
owns an ordered set of **occurrences**, each one a `(date, slot)` row:

```sql
CREATE TABLE planned_batch (
  id, household_id, recipe_id, portions, created_at, created_by
);
CREATE TABLE batch_occurrence (
  batch_id REFERENCES planned_batch(id) ON DELETE CASCADE,
  date, slot,
  PRIMARY KEY (batch_id, date, slot)
);
```

The FK/PK column on `batch_occurrence` is `batch_id`, not `planned_batch_id`.

The migration turned every existing `meal_entry` row into one `planned_batch`
with exactly one `batch_occurrence`, preserving id, recipe, household, creator,
portions, date and slot — it does not try to infer that two old rows were the
same cooking, and it never will: there is no way to tell from a flat log which
entries were one pot.

A menu is still a date-range query, not a record (per #5): it projects every
batch whose occurrences intersect the requested range, including a batch that
begins before or ends after the visible week. Same-slot multiplicity is kept —
a slot can hold any number of independent batches, including two of the same
recipe (carried over from decision #36).

Coverage rule: an occurrence set must be non-empty, and every day strictly
between a batch's first and last occurrence date must have at least one
occurrence; lunch and dinner do not otherwise need to be contiguous. Portions
are display/scaling context and never determine coverage. See
[ADR-0004](../adr/0004-a-planned-batch-owns-its-occurrences.md).

Routes moved with the model: `/meal-entries/:id` no longer exists. Planning
goes through `/batches/:id`, `/batches/:id/coverage`, `/batches/:id/portions`,
`/batches/:id/recipe`, `/batches/:id/delete`, plus the matching
`/api/batches...` JSON routes in `src/index.ts`.

## Parts of a dish

`migrations/0002_parts.sql` adds `recipe.parent_id` and `recipe.part_position`.
A part is not a new kind of record — it is a `recipe` row with a parent, per
[ADR-0002](../adr/0002-a-part-is-a-recipe.md). `parent_id` NULL means "this is
a dish"; non-null means "this is a part of that dish, in this position". A
part cannot itself have parts (one level, no deeper), and a part belongs to
exactly one dish — two lasagnes with a *juustokastike* are two separate rows,
never a shared one. Deleting a dish cascades to its parts.

`migrations/0004_semantic_phases.sql` adds `recipe_step.phase` and
`ingredient_line.phase`, each constrained to `before_parts` / `after_parts` /
NULL. This lets parent content in a multipart dish render before or after its
named parts in the cooking view (docs/adr/0003). NULL is meaningful, not a
placeholder: it means "unclassified", and the cooking view keeps such content
in its old parent-first position so the migration never reorders an existing
recipe. Named parts and plain recipes leave the field NULL always.

## Optimistic editing

`migrations/0003_recipe_revision.sql` adds `recipe.revision` (starts at 0) and
`recipe.edit_token`. A form carries the revision it opened; saving increments
it only if that revision is still current, so an older editor cannot silently
clobber a newer edit. `edit_token` identifies the one batch of child
deletes/inserts that won a given revision update, so a save is conditional on
the token rather than just the numeric revision — seeing the same revision
from somebody else's already-completed edit is never enough to rewrite it.

## Recipe images

`migrations/0006_recipe_images.sql` adds `recipe.image_key` (#89: bytes plus a
key, nothing else). `migrations/0007_recipe_image_freshness.sql` adds the
columns that answer "is this still the dish": `image_origin` (`manual` |
`generated` | NULL), `image_fingerprint` (the recipe fingerprint a *generated*
picture was made from), `image_generated_at`, `image_generated_by`.
`src/image-freshness.ts` is the one place that turns those columns into
`missing` / `fresh` / `stale`, comparing the stored fingerprint against
`recipe-fingerprint.ts`'s current one — no query does this comparison inline.
A manually uploaded picture is never compared and never goes stale; `NULL`
origin reads as `manual` too, since every row #89 ever wrote was a hand
upload, and the migration is written so landing it does not retroactively
stale a single existing picture.

## Admin

`migrations/0007_member_admin.sql` adds `member.is_admin` (default 0). One
explicit column, not a role system — never inferred from email, display name,
request origin, or anything the client says.

## Backup and restore: the manifest lockstep rule

`BACKUP_TABLES` in `src/backup.ts` is the single list that drives snapshot
capture, row ordering, schema comparison, and post-restore comparison — it is
currently `household`, `member`, `ingredient`, `recipe`, `recipe_step`,
`ingredient_line`, `planned_batch`, `batch_occurrence`.
`scripts/check-backup-schema.ts` fails the build if the live migrated tables
and `BACKUP_TABLES` disagree; that diff *is* the check, there is no separate
"did you forget the new table" step.

Any schema change that adds or removes a table must update, in lockstep:

- `BACKUP_TABLES` in `src/backup.ts`
- `RESTORE_ORDER` in `src/restore.ts` — new tables must come after the tables
  they reference (`planned_batch` after `household`/`member`/`recipe`,
  `batch_occurrence` after `planned_batch`)
- `validateRelationships()` in `src/restore.ts` — the FK and uniqueness-key
  checks for the new table
- the fixtures in `dev/check-restore.ts` and `dev/check-backup.ts`
- the seed cleanup in `dev/seed.sql`
- the round-trip drill in `scripts/check-restore-roundtrip.ts`

#57 touched all of these for the `meal_entry` → `planned_batch` /
`batch_occurrence` swap; that PR is the reference example if this list is
ever wrong.

`restore.ts` also restores recipes parent-first (`sortRecipesParentFirst`),
because a part's `parent_id` must already exist for the foreign key to hold —
the same ordering concern ADR-0002 raised for parts applies again here.

## Superseded and cross-links

`docs/spec.md`'s "Issue #57 proposes superseding `meal_entry`" language is
stale: #57 is merged and shipped (PR #86), and the model above is what's live
on `origin/main`. See `docs/codebase/recipes.md` for the screen and editor
behaviour built on this schema, and `docs/codebase/deploy-cloudflare.md` for
how backups run in production.
