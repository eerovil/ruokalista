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

## An ingredient named in a step (issue #120)

This pull request proposes letting a preparation step point at the ingredients
it names, so a cook can reveal an amount without looking back up the screen.
`src/ingredient-refs.ts` owns the whole idea and is the file to read first.

A reference is deliberately thin, and both omissions are the point:

- **No amount.** The `ingredient_line` row stays the only place a quantity
  lives, so a different portion count and a later edit to a line both come
  through on their own. Nothing has to be kept in step.
- **No character range.** A stored `start`/`end` would be wrong the moment
  somebody fixed a typo earlier in the sentence. What is stored is the wording
  that was matched and roughly where it was; `resolveMentions` finds it again in
  whatever the text says now, taking the occurrence nearest the recorded
  position. Anything that cannot be placed — wording edited away, two references
  landing on the same words — is left as plain text, because linking the wrong
  word is worse than linking no word.

The reference exists in two shapes and `saveRecipe` is where one becomes the
other. A **draft** reference (`DraftIngredientRef`) points at an ingredient line
by its *index*, because on an import half the ingredients do not have ids yet;
a **saved** one (`StepIngredientRef`) carries the `ingredient` id. The editor
converts back to indexes when it renders, since a form row is the thing a member
can move or retype and an index survives both. `resolveStepRefs`
(`src/recipe-save.ts`) drops a reference whose line ended up in a different part
of the dish than the step — a part is a recipe row of its own, and an amount the
reader cannot see on that screen is not worth linking to.

The reveal proposed on the recipe screen is **a checkbox and its label, not a
script**: every mention toggles on its own, it survives Safari's
back-forward cache, and it works with JavaScript off, which is the standing
rule for anything on the reading path. `MENTION_STYLE` in `src/recipes.ts` is
the whole of it. A mention whose ingredient states no amount ("hieman
sitruunaruohoa") renders as plain text — a control that does nothing is worse
than no control.

One consequence worth knowing before writing a test: the amount is in the markup
with `display: none` on it until it is tapped. Nobody reads it, nothing copies
it and no screen reader announces it, but it *is* in `textContent`. See
[testing](docs/codebase/testing.md).

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
