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

## Ingredients a step names

`migrations/0008_step_ingredient_refs.sql` (issue #120, proposed here) adds one
nullable `recipe_step.ingredient_refs` column holding a small JSON array of
`{ingredientId, matchedText, approxPosition}`. NULL and `"[]"`
both mean "this step links nothing", which is what every existing row is.

The reference names an ingredient, not one line. A recipe may list the same
ingredient several times at different amounts; revealing a mention shows every
distinct stated amount from those rows. This avoids trusting an unverified model
choice about which duplicate line a word meant. Blank amounts are omitted and
identical amounts collapse.

A column rather than a table, on purpose: a reference has no identity of its
own, is only ever read with the step it belongs to, and a new table would drag
in the six-file lockstep below for what is a detail of one row. Backup and
restore need no change — `backup.ts` captures with `SELECT *` and `restore.ts`
writes whatever columns a row carries.

`src/ingredient-refs.ts::parseStepRefs` is the only reader, and it treats a
malformed value as no references rather than throwing: a step whose links cannot
be understood is still a step somebody has to cook from. See
[recipes](docs/codebase/recipes.md) for what the column is for.

## The cupboard

`migrations/0008_pantry.sql` (#125) adds `pantry_entry`, one row per ingredient
the household keeps in. A row means "we have enough of
this, treat it as unlimited"; no row means nothing is known and the ingredient
is bought as normal. Running out is a delete, not a second kind of row.

```sql
CREATE TABLE pantry_entry (
  id, household_id, ingredient_id,
  state,          -- 'unlimited' today, 'quantity' reserved
  quantity, quantity_unit,
  added_at, added_by,
  UNIQUE (household_id, ingredient_id)
);
```

`state` is a word rather than a boolean deliberately, and the amount columns
exist before anything writes them: counted inventory — 6 kpl of eggs against
the 10 a week needs — is meant to land as the `quantity` state plus a
subtraction rule, not as a replacement table. Two CHECK constraints hold the
pair together: an amount belongs to the counted state and to no other, and it
is never negative. `src/pantry.ts` is the only place that reads or writes this
table, and its `splitByPantry` looks only at membership, so v1 cannot
accidentally depend on the unused columns.

Matching is by `ingredient_id` — the household's canonical identity for a
foodstuff — and never by name.

## Background recipe imports

Issue #186 proposes `intake_job`, a household-scoped record for a model call
that continues after its browser leaves. It retains the source, queued/running/
ready/failed state, safe failure text and validated draft until the recipe is
saved. Photographed bytes stay temporarily in R2; `image_refs` is only their
ordered key list. `lease_id` makes completion conditional on the consumer that
claimed the running job. The queue message carries the job id rather than
source data.

## Admin

`migrations/0007_member_admin.sql` adds `member.is_admin` (default 0). One
explicit column, not a role system — never inferred from email, display name,
request origin, or anything the client says.

## Leaving a household

`migrations/0009_member_removed.sql`, added for #127, adds `member.removed_at`
and `member.removed_google_sub`. Removing somebody from a household does not
delete their `member` row, and this is the reason why: four columns record a
member as having made something — `ingredient.created_by`,
`recipe.created_by` and `.updated_by`, `planned_batch.created_by`,
`pantry_entry.added_by` — and `src/recipes.ts` joins `member` on
`recipe.created_by` to print who wrote a recipe. A DELETE would break a foreign
key, or take the recipe off the list.

So removal is a stamp. `removed_at` is set, and the person's real Google `sub`
moves to `removed_google_sub` while the live `google_sub` is rewritten to a
tombstone. Two things follow, and both are the point:

- Every lookup that turns a request into a member — `findMemberById`,
  `findMemberByGoogleSub`, `allMembers` in `src/members.ts` — filters
  `removed_at IS NULL`, so neither a Google account nor a session cookie already
  in a browser opens the household any more.
- `google_sub` is UNIQUE across the whole table, so handing it back is what lets
  the same person be added to another household. That is the second half of a
  move, which #127 defines as a removal followed by an addition.

Rewriting the live column rather than making the UNIQUE index conditional is
deliberate: four tables reference `member`, and rebuilding it against the live
database to relax one constraint is not worth it.

What that tombstone may be matters more than it looks, and 0009 got it wrong.
It parked a removed row on `removed:<id>`, reasoning that a Google `sub` is a
decimal string and so could never look like that. Google promises no such
thing: its contract is any case-sensitive ASCII string of up to 255 characters
(https://developers.google.com/identity/openid-connect/openid-connect), so
`removed:2` is a legal account id. Reserving that shape shut a real person
holding it out of the admin screen, and left them a parked row to collide with
on the UNIQUE column.

`migrations/0010_removed_member_tombstone.sql`, proposed as the fix, moves the
tombstone outside that contract instead of carving a corner out of it: U+2014 EM
DASH followed by the member id, which is not ASCII and so is not a `sub` at all.
It also rewrites any row 0009 already parked, matching on `removed_at IS NOT
NULL` as well as the text so that a live member whose real sub reads
`removed:<their id>` is left alone.

The proposal writes the contract itself down once, in
`src/google.ts::isGoogleSub`, and holds both ends to it — sign-in
(`readIdentity`) and the admin form (`src/households.ts::memberFields`). That is
what makes the guarantee a guarantee: because the tombstone is not ASCII, no
value either end accepts can equal one, and the reasoning rests on Google's
contract rather than on a habit of Google's. `dev/check-google-sub.ts` is the
regression.

This is a column addition, so the backup lockstep below does not move: backup
captures `SELECT *` and restore builds its INSERT from the row's own keys, so
both carry the new columns without a change.

## Public recipes, and a global ingredient dictionary

Issue #143, proposed here, adds `recipe.published_at` and `recipe.published_by`
(`migrations/0011_public_recipes.sql`). A dish carrying a `published_at` is
readable and plannable by every household; the row is shared rather than copied,
so the owner's edits are immediately what everyone reads. Parts carry no
`published_at` of their own — publishing a dish publishes the dish. The access
question is two scopes and nothing more, `own` and `readable`, both in
`src/recipes.ts`; every write stays on `own`. See
[ADR-0006](../adr/0006-a-published-recipe-is-shared-not-copied.md) for why there
is no role or grant model behind it.

### Selected recipe recipients (#185, proposed)

This pull request proposes `recipe_share`, keyed by `(recipe_id, household_id)`.
It points at the root dish, the recipient household and the member who shared
it. Public visibility stays on `recipe.published_at`; a recipe is selected when
that field is null and one or more share rows exist. The table participates in
backup and restore after `recipe`, `household` and `member`. See
[ADR-0009](../adr/0009-recipe-sharing-targets-households.md).

The same migration makes `ingredient` **global**: no `household_id`, and one
canonical row per name (`UNIQUE (name)` replacing
`ingredient_name_per_household`). This is what lets a published recipe reach
another household's shopping list and cupboard without a per-household
remapping layer. `pantry_entry` is untouched in that respect — it still carries
`household_id`, and every query over it still filters on it.

Duplicate rows across households are coalesced onto the lowest id per folded
name. The fold does the three Finnish vowels by hand because SQLite's `lower()`
is ASCII-only, the same reason `src/ingredients.ts` sorts in JavaScript. Every
reference moves with them: `ingredient_line`, `pantry_entry` (deduplicating the
rows that would collide on `UNIQUE (household_id, ingredient_id)`), and the
ingredient ids inside `recipe_step.ingredient_refs`, which are JSON rather than
a foreign key and so need rewriting by hand. A malformed refs value is left
exactly as it is, the way `parseStepRefs` treats it.

`recipe_preference` is the third table this adds: one `(household_id,
recipe_id)` row holding the default portions the picker starts from.
`recipe.yield_portions` is what the source page said and travels with the
recipe; "we always make this for nine" is a fact about a kitchen, and putting it
on the shared row would push the publisher's habit onto everyone who plans it.

## Scaling by a multiplier

`migrations/0013_recipe_multiplier.sql`, proposed by #165, replaces
`planned_batch.portions` with `multiplier REAL` and
`recipe_preference.default_portions` with `default_multiplier REAL`. A recipe's
stored amounts are 1× the recipe; `recipe.yield_portions` stays untouched and
becomes source metadata that nothing computes with. See
[ADR-0007](../adr/0007-a-batch-is-scaled-by-a-multiplier.md) for the reasoning
and [recipes](recipes.md) for what the screens do with it.

No table is rebuilt. `planned_batch` is the parent of `batch_occurrence`'s
`ON DELETE CASCADE`, so a drop-and-recreate would take the occurrences with it —
`ALTER TABLE ADD COLUMN` and `DROP COLUMN` need none of that, and SQLite carries
a column's own `CHECK` away with the column. Worth knowing before reaching for
the rebuild sequence 0011 documents: it is not always needed.

The migration converts `portions / yield_portions` where the dish stores a
usable positive integer yield, preserving the ratio rather than rounding it.
Where it cannot, it invents nothing: the batch goes to 1× and its old number is
kept in `planned_batch.legacy_portions`, which
`week-screens.ts::batchCard` prints on the card so a cook corrects it rather
than finding out at the hob. `menu.ts::changeMultiplier` clears the column,
because once somebody has chosen there is nothing left to warn about. An
unconvertible `recipe_preference` row is deleted instead — under the old rules
it produced no factor at all, so it was already inert.

`dev/check-multiplier-migration.ts` runs the real migration files against
`node:sqlite` and asserts all of that. It is there because the "never invent a
multiplier" rule exists only in the SQL, and it is the pattern
`dev/check-ingredient-product-migration.ts` follows for the same reason below.

### What an ingredient is bought as

Issue #147 put three nullable columns on that global `ingredient` row — `ean`,
`external_product_name` and `external_product_image_url` — caching the one
S-group product selected for an ingredient. It deliberately added no provider or
household mapping table: the integration is enabled for one server-configured
household only, and that is the boundary that made a global preference
acceptable.

Issue #161 proposes replacing those columns with two tables
(`migrations/0013_ingredient_products.sql`), because one product per ingredient
cannot say what jauheliha needs said — it is sold as 400 g, 700 g and 1 kg, and
which to buy depends on the week rather than on the foodstuff.
[ADR-0008](../adr/0008-an-ingredient-knows-several-products.md) holds the
reasoning; the shape is:

- **`ingredient_product`** — several rows per ingredient, each an EAN, a name,
  an image and a **structured package size** (`package_quantity` +
  `package_unit`, null together when unknown). The size is stored data. It is
  read off the product's name once, at the moment somebody chooses it, and is
  never re-derived while a shopping list is built. `UNIQUE (ingredient_id,
  ean)`.
- **`recipe_ingredient_product`** — one product for one recipe's use of one
  ingredient, per household. `UNIQUE (household_id, recipe_id, ingredient_id)`.
  Keyed by recipe and ingredient rather than by `ingredient_line.id` on
  purpose: `recipe-save.ts` deletes and re-inserts a recipe's lines on every
  save, so a line-id key would lose each override the next time somebody fixed
  a typo. Household-scoped because a published dish is plannable by everybody
  (#143) and each household picks its own product for it.

The migration copies every existing `ingredient.ean` mapping across before
dropping the columns, so nothing selected under #147 is lost; those rows arrive
with no package size, and `ingredient-products.ts::backfillPackageSizes` fills
one in the first time the app reads a name it can parse. A product whose name
cannot be parsed simply stays unsized and never contributes a package count.

Both product values are still written only after a fresh S-ostoslista search
confirms the submitted EAN, and the image is still the stable public CDN URL
derived from that EAN. Unlike #147, this **is** a table addition, so it goes
through the manifest lockstep below.

### Rebuilding a table in a D1 migration

Worth reading before writing another one. The plain SQLite rebuild does not work
here, and the failure is not obvious:

- **D1 enforces foreign keys, always**, and a migration's statements are not
  inside a transaction the file controls, so `PRAGMA defer_foreign_keys` buys
  nothing. `DROP TABLE ingredient` while `ingredient_line` references it fails
  outright — and `pantry_entry`'s `ON DELETE CASCADE` would have emptied every
  cupboard on the way past.
- **Renaming does not save you.** With foreign keys on, SQLite rewrites other
  tables' `REFERENCES` clauses to follow the rename, whatever
  `legacy_alter_table` says, so the children chase the old table around instead
  of attaching to the new one.

0011 uses that rewrite deliberately instead of fighting it: the new table is
built under a working name, the two child tables are rebuilt to reference *it*,
and only then is the old table dropped and the new one renamed into place —
which is what points the children back at `ingredient`. No statement in the
sequence ever leaves a constraint violated, so none of it depends on a pragma.

## Backup and restore: the manifest lockstep rule

`BACKUP_TABLES` in `src/backup.ts` is the single list that drives snapshot
capture, row ordering, schema comparison, and post-restore comparison — it is
currently `household`, `member`, `intake_job`, `ingredient`, `recipe`, `recipe_share`,
`recipe_step`, `ingredient_line`, `planned_batch`, `batch_occurrence`, `pantry_entry`,
`recipe_preference`, and — proposed by #161 — `ingredient_product` and
`recipe_ingredient_product`.
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
