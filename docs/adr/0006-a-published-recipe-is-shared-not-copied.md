# ADR-0006: A published recipe is shared, not copied — and ingredients go global with it

## Status

Proposed by issue #143. This change intentionally opens the one hole in the
household isolation rule that `CLAUDE.md` otherwise states without exception,
and it intentionally supersedes the assumption that `ingredient` is
household-scoped.

## The decision this change introduces

A household may **publish** a dish. A published dish is readable and plannable
by every signed-in household; it is editable, unpublishable and deletable only
by the household that owns it. There is one `recipe` row and no copies, so an
edit by the owner is immediately what every household reading it sees. That is
the point of publishing rather than sharing a duplicate: a recipe with a wrong
oven temperature gets fixed once.

Publication is two nullable columns, `recipe.published_at` and
`recipe.published_by`, not a table and not a role system. A recipe is published
or it is not; there is no third state and nobody to grant anything to.

The access rule is two scopes and no more:

- **own** — `recipe.household_id = ?`. Every write stays here.
- **readable** — that, or any recipe carrying a `published_at`.

A private recipe of another household stays a 404, exactly as before. This
change deliberately does not introduce a general permission model: there is no
per-recipe grant, no group, no role. Anything that is not "everybody" is
"nobody".

**Parts are not independently publishable.** Publishing a dish publishes the
dish; its parts carry no `published_at` and are read through the parent's
screen. A part is a `recipe` row (ADR-0002), not a record another household
addresses, so a direct request for one by a non-owner is a 404 — everything a
reader needs from a part is already on the dish's page.

## Taking it back

Unpublishing is **refused while another household has a future planned
occurrence** on the recipe. Somebody has decided to cook this on Thursday, and
pulling the recipe out from under them on Wednesday is the failure this
prevents. An occurrence already past blocks nothing: the cooking happened, and
the batch is a record rather than a claim.

**Deleting a published recipe is refused outright**, and the screen says to
unpublish first. Deletion is unpublishing plus more, so it asks for the
unpublish and inherits that check instead of carrying a second copy that could
drift. Once private, the existing "is it on a menu" rule applies — widened to
count *every* household's batches, because a past plan elsewhere no longer
blocks unpublishing and would otherwise be left pointing at a deleted row.

## Ingredients become one global dictionary

A published recipe's `ingredient_line` rows have to mean something in the
reading household's shopping list and cupboard. With a per-household
`ingredient` table they do not, and the only ways out are a per-household
remapping layer or matching by name — the second being exactly the fuzzy
matching `src/pantry.ts` refuses to do, because deciding "suola" and
"hienosuola" are the same thing is how a list quietly stops mentioning something
somebody needed.

So `ingredient` becomes global: one canonical row per foodstuff, referenced by
every household's lines and cupboards. Everything household-specific stays
household-specific — `pantry_entry` still carries `household_id`, and so does
every query over it.

Two consequences follow, and both are deliberate:

- **The dictionary is visible to everybody.** Every household sees every
  ingredient name. That is what a shared vocabulary is, and it is the same
  drift-spotting the list was built for, now across households.
- **Renaming one is an admin operation.** Coining a name while writing a recipe
  adds a row nobody was using and stays ordinary work. Renaming an existing one
  rewrites what every household's recipes say, which is the shape of thing
  `requireAdmin` exists for. Merging is still not implemented.

## A household preference is not a recipe fact

`recipe.yield_portions` is what the source page said. It belongs to the recipe
and travels with it. "We always make this for nine" belongs to a kitchen, and
putting it on the shared row would make the publisher's habit everybody's
default the moment they shared it.

So `recipe_preference` is a `(household_id, recipe_id)` row holding the default
portions the picker starts from. The owning household has no more say over
another household's number than the other way round. It is named for the
general idea rather than its one column because the next household-side fact
about a recipe is the same row.

## Migration

`migrations/0011_public_recipes.sql` coalesces duplicate `ingredient` rows onto
one survivor per name, folding the three Finnish vowels by hand first because
SQLite's `lower()` is ASCII-only. Every reference moves with them:
`ingredient_line`, `pantry_entry` (deduplicating the cupboard rows that would
collide on `UNIQUE (household_id, ingredient_id)`), and the ingredient ids
inside `recipe_step.ingredient_refs`, which are JSON rather than a foreign key.
A malformed refs value is left exactly as it is, the same way `parseStepRefs`
treats it.

Dropping `ingredient.household_id` needs a table rebuild — SQLite refuses
`DROP COLUMN` on a column a foreign key names. The rebuild is written the long
way round, and the reason is worth keeping: D1 enforces foreign keys and a
migration's statements are not inside a transaction this file controls, so
`PRAGMA defer_foreign_keys` buys nothing, and with foreign keys on SQLite
rewrites children's `REFERENCES` clauses to follow a rename whatever
`legacy_alter_table` says. So the new table is built under a working name, the
two child tables are rebuilt to reference *it*, and the rename into place is
what points them back. No statement in the sequence leaves a constraint
violated.

## Consequences

`shoppingLinesFor` no longer requires a planned dish to belong to the planning
household — requiring it would silently drop every shared recipe's ingredients
off a shopping list. `requireDish` accepts a published dish. The backup manifest
gains `recipe_preference` and the `ingredient` uniqueness key drops
`household_id`, in the usual six-file lockstep.
