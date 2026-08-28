# ADR-0012: A category belongs to the recipe, and the vocabulary is closed

**Status:** proposed (issue #196)

## Context

Issue #196 asks for recipes to be sortable into categories — *Pasta*, *Keitto*,
*Uuniruoka* and so on — so the store can be browsed as something other than one
long list. It asks for several categories per recipe, for them to be editable
later, for the list to filter by one, and for recipes that have none to keep
working. It deliberately leaves the structure and the way categories are managed
open.

Two questions had to be answered before anything could be stored.

**Whose fact is a category?** Since #143 a recipe can be read and planned by a
household that does not own it, and #185 added household-targeted sharing on top
of that. So a category is either a fact about the dish, travelling with it, or a
fact about the kitchen, private to each household — and the repo already has one
of each. `recipe.yield_portions` is the first kind: it is what the source page
said, and it travels. `recipe_preference.default_multiplier` is the second: "we
always make this at 1,5×" is nobody else's business.

**Who names a category?** Either the vocabulary is fixed in code, or a household
coins its own names in a table.

## Decision

**A category is a fact about the dish.** `recipe_category` is keyed by
`(recipe_id, category)` and carries no `household_id`. A shared lasagne is a
*Uuniruoka* to everybody who can read it.

**The vocabulary is closed and lives in `src/categories.ts`.** The table stores
a slug; the label is code.

## Consequences

The two decisions hold each other up, which is why they are one ADR:

- A per-household category **name** plus a recipe-level category **link** cannot
  both be true. If household A coins *Arkiruoka* and publishes a recipe tagged
  with it, household B either sees a word it has never used and cannot filter
  by, or sees nothing where the owner sees a category. Closing the vocabulary is
  what makes a recipe-level link mean the same thing everywhere.
- Conversely, if the vocabulary is closed there is nothing left for a
  per-household table to hold. Scoping the *link* per household would only let
  two kitchens disagree about what a dish is, which is not a disagreement worth
  modelling.

What this costs, said plainly: a household cannot invent *Grillaus* without a
code change. That is a real limitation and it is the intended trade. The
alternative — free text — brings a management screen, a merge problem
(*jälkiruoka* / *Jälkiruoat* / *jälkkäri*), a spelling problem and a filter row
that grows without limit on a phone, and #196 asks for none of those. If a
household turns out to need its own names, the way in is a second, additive
table for household-coined categories beside this one, not a rewrite of it.

Three smaller consequences follow:

- **Only a dish is categorised.** A part is a recipe row (ADR-0002), but nobody
  browses the store for a *juustokastike*. The editor offers the picker only for
  a dish and `saveRecipe` writes the rows only on the parent.
- **Nothing guesses a category.** Import does not ask the model for one — that
  would cost money on every import to produce a label somebody has to check
  anyway. The picker sits on the review screen instead, outside its
  "Muokkaa ennen tallennusta" disclosure, because the 99% of imports that need
  no correction would otherwise save with no category at all.
- **The filter is a place, not a control.** `?kategoria=<slug>` is a link, so it
  survives the back button, a bookmark and a reload with no script — the
  standing rule on the reading path. An unknown slug is read as no filter, so a
  stale bookmark shows the recipes rather than an empty screen.

## Alternatives considered

- **A free-text tag table per household.** Rejected above: it cannot survive
  #143's shared recipes, and it brings a management surface #196 did not ask
  for.
- **One category per recipe, as a column on `recipe`.** Cheaper, and it would
  have needed no new table — but #196 says in as many words that a recipe may
  belong to several, and a *kanapasta* is both *Pasta* and a main course.
- **Deriving a category from the ingredients.** No storage at all, and it reads
  well until a dish that happens to list pasta as a side is filed under *Pasta*.
  A guess nobody can correct is worse than a blank.
