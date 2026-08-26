# Recipes, parts and scaling

The recipe row, multipart dishes, cooking-order phases, portion scaling and the
finish-state screens (delete, ingredient rename) — everything downstream of a
saved recipe. See `docs/codebase/intake.md` for how a draft becomes one and
`docs/codebase/recipe-images.md` for the picture that rides alongside it.

## Finish states

Deleting a recipe is a two-step: `GET /recipes/:id/delete` asks, naming the
parts that go with it, and only the POST from that screen deletes. The editor
links to it rather than submitting.

The ingredient list is read-first — each row is the name and how many recipes
use it, and the row *is* the disclosure that reveals the rename box. A list of
live text boxes read as a form nobody had finished filling in.

Intake's progress is counted, not dumped: the island reads the streaming JSON
and shows "Uunikaali · 5 ainesta · 2 vaihetta" rather than the raw bytes. Note
that `STREAMING_ISLAND` (`src/intake-screens.ts`) is a template literal, so **a
backslash in it is eaten before the browser sees it** — no regular expressions
in that script.

## Parts of a dish

A lasagne is a jauhelihakastike and a juustokastike. Each part is an ordinary
`recipe` row with `parent_id` set — not a second kind of record. Parts are
excluded from the recipe list and the picker, so only dishes can be planned.

The model marks parts by writing a name into each line's and step's `section`
field; `saveRecipe` turns distinct names into child recipes. Nothing carries a
section once saved, which is why the editor has no part field: a saved part is a
recipe you edit on its own screen.

See `docs/adr/0002-a-part-is-a-recipe.md`, including what it deliberately does
not decide — scaling parts with the parent is still open (parts are shown
exactly as written, unscaled, alongside a scaled parent).

### Cooking order has a phase (issue #58, decision #50, ADR-0003)

Parent-level content on a multipart dish — a line or step that belongs to the
dish itself, not to a named part — can carry a cooking-order meaning:
`RecipePhase = "before_parts" | "after_parts" | null` (`src/recipe-phase.ts`,
narrowed by `recipePhase()`). The cooking view (`src/recipes.ts::recipeBody`,
via `body()`) renders parent content marked `before_parts` (or `null`), then
each named part in its existing order, then parent content marked
`after_parts`. It is only a rendering order, not a general sequence or
dependency graph, and named parts never carry a phase of their own — only
parent-level lines and steps do.

`NULL` means "unclassified", not "the model chose before_parts".
`migrations/0004_semantic_phases.sql` leaves every existing line and step
`NULL`, and the cooking view keeps unclassified parent content in its old
parent-first position (bucketed with `before_parts`), so the migration does not
visibly reorder an existing recipe. The editor lets a member reclassify legacy
rows deliberately.

`phaseSelect` (`src/line-form.ts`) renders the "Milloin tämä tehdään?" select,
but only where it can mean something: `lineRows`/`lineRow` take a `phases`
option, passed as `phases: multipart` for an intake draft
(`src/intake-screens.ts`) and `phases: recipe.parts.length > 0` in the editor
(`src/recipe-editor.ts`), and gated further so a line already inside a named
part (`values.section.trim() !== ""`) gets no phase select. A single-dish draft
or recipe must never offer one — getting this narrow enough mattered in
practice, since a phase select and the ingredient select share a `select`
element and a locator that means "the ingredient select" breaks if a second
`select` appears on the same row.

## Scaling

A recipe opened from a day carries that day's portions. The week itself is for
reading, so the link is one step further in: a planned meal opens
`/batches/:id`, and *that* screen links to `/recipes/:id?portions=N` — it is
also where portions get changed and a meal gets taken off the list. The week
holds no inputs and no delete buttons on purpose (decision #36).

(That screen used to be `/meal-entries/:id`. #57/#86 replaced the whole
meal-entry model with planned batches and occurrences, and the routes moved with
it — see [data-model](docs/codebase/data-model.md).)

`src/scaling.ts` turns those portions into a factor, and a
dish's factor reaches into its parts — a part has no yield of its own because it
is a piece of the dish.

Amounts round to what a cook can measure rather than to what the arithmetic
says: 5 dl times 1⅓ reads 6½ dl, not 6,666. Small amounts keep quarters, larger
ones go to halves and then whole numbers, weights go to the nearest 5 or 10 g.

The recipe screen is cook-first (decision #37), so a source line is not repeated
under every ingredient. `sourceWorthShowing` in `src/recipes.ts` surfaces it in
exactly two cases: a line with **no stated amount**, because "hieman" and "maun
mukaan" have no field to live in, and a line whose amount **the factor changed**,
because the number on screen is no longer the number on the page. Ranges and
second measurements round-trip through the fields intact, so they carry no copy.
The full source text sits behind `Näytä alkuperäinen`, still stored, still one
tap away.

A recipe with no stated yield cannot be scaled and says so — there is nothing to
scale *from*.
