# ADR-0013: The category vocabulary is curated, not compiled

**Status:** proposed (issue #199)

Supersedes the second half of
[ADR-0012](0012-a-category-belongs-to-the-recipe-not-the-household.md). Its
first half — a category is a fact about the dish, not about the household —
stands unchanged and is what makes this one safe.

## Context

ADR-0012 answered two questions, and this one revisits only the second.

**Whose fact is a category?** The dish's. `recipe_category` carries no
`household_id`, so a shared lasagne is a *Uuniruoka* to everybody who can read
it. Nothing here changes that.

**Who names a category?** ADR-0012 said: code. `src/categories.ts` held a
constant of seven, and it said out loud what that cost — "a household cannot
invent *Grillaus* without a code change… that is a real limitation and it is the
intended trade."

Issue #199 asks for the trade back. It asks for two more categories
(`Kastike`, `Pizza/piirakka`) and, separately, for an admin to be able to add,
rename, reorder and remove categories "ilman koodimuutosta" — without a code
change — with the removal of a category in use saying what it will do first.

The two asks are the same ask seen twice: the second is what makes the first
routine instead of a release.

## Decision

**The vocabulary is a table an admin curates: `category(slug, label, position)`.**
`src/category-admin.ts` is the only thing that writes it, behind
`requireAdminScreen`.

**A slug is derived from the label once and is then permanent.** `Pizza/piirakka`
becomes `pizza-piirakka`; `Jälkiruoka` becomes `jalkiruoka`. Renaming changes
the label only.

**The list is still one list.** Not per household, not free text on a recipe,
and not something a member can add to while saving.

## Consequences

- **Renaming stays free**, which was the good half of ADR-0012's argument for
  code. `recipe_category` stores the slug, so *Jälkiruoka* → *Jälkiruoat* writes
  one row and touches no recipe. That is why the slug is not editable: making it
  editable would turn a text field into a data migration.
- **The merge and spelling problems ADR-0012 feared are still not here**, and
  for the same reason as before: nobody types a category while saving a recipe.
  One curated list of a couple of dozen entries is not free text; it is the same
  closed vocabulary with a slower-than-code, faster-than-release way in. A
  duplicate label or slug is refused rather than merged.
- **Removal is the new sharp edge**, and it is the one the issue names. A
  category in use is carried by recipes across every household, including
  recipes this admin's household does not own. So removal is a confirmation
  screen that lists those recipes and says how many, and the delete is one batch
  that detaches the category and removes it together. No recipe is ever deleted,
  and there is no cascade in the schema that could delete one.
- **There is no foreign key from `recipe_category` to `category`.** Adding one
  would mean rebuilding `recipe_category`, which this repo has documented reasons
  to avoid, and it would buy little: the only writer validates against the
  vocabulary first, removal detaches in the same batch, and an orphaned slug
  already renders as itself and reads as no filter. `src/restore.ts` checks the
  relationship where it actually matters — a snapshot naming a category it does
  not carry is refused.
- **Every screen reads the vocabulary per request.** `loadVocabulary` is one
  small query and a `Vocabulary` is passed down; there is no module-level cache,
  because an admin's rename has to be true on the next screen and a cache that
  is wrong for a minute is worse than a query that costs nothing.
- **An empty vocabulary is a legal state.** An admin who removes every category
  gets a recipe editor with no picker and a list with no chip row — which is
  exactly how every screen already renders a recipe that has no category.
- **`category` is the one migration-seeded table in the backup.** It is data now,
  so it is in `BACKUP_TABLES`; but a freshly migrated restore target already
  holds the nine rows the migration ships, so the restore clears it first and
  the emptiness check exempts it. That exemption is named in `src/restore.ts`.

What this costs, said plainly: an admin can now break the vocabulary for every
household at once — rename *Keitto* to nonsense, or remove a category twenty
recipes use. ADR-0012's constant made that impossible. The mitigations are the
confirmation screen, the refusal of duplicates, and the fact that the admin
boundary already guards operations of this weight (renaming a global ingredient
rewrites what every household's recipes say, and has been an admin operation
since #143).

## Alternatives considered

- **Leave the vocabulary in code and just add the two categories.** Half the
  issue, and the half that was already easy. #199 asks for the other half in as
  many words.
- **Let a household coin its own categories.** Still rejected, and ADR-0012's
  reasoning is untouched: a recipe shared under #143 would carry a word the
  reading household has never used. Admin-curated is what keeps one shared
  vocabulary while removing the release from the loop.
- **Let the slug be edited too.** It would look tidier after a rename. It would
  also mean a text field silently rewriting every `recipe_category` row that
  points at it, and getting it half-done leaves recipes in a category that no
  longer exists.
- **Soft-delete a category instead of detaching it.** A removed-but-remembered
  category keeps recipes findable if the admin changes their mind, but it also
  means the list an admin sees is not the list that exists, and #199 asks for a
  removal that says what it does rather than one that quietly does less.
