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

### A dish can own nothing but its parts (issue #184)

Proposed here. Once the parts are recipe rows of their own, a dish written
entirely in named parts keeps no ingredient line at all — only a title, its
method and its parts. `validateRecipe` (`src/recipe-save.ts`) refuses a recipe
with no lines, which left that dish openable in the editor and impossible to
save: *Reseptissä pitää olla ainakin yksi aines.* This change gives the
function a `hasParts` option and the editor passes `recipe.parts.length > 0`,
so the rule asks the question it meant to ask — is this recipe empty? — rather
than counting only one of the two places a recipe's content can be. The
refusal's wording moves with it: *Reseptissä pitää olla ainakin yksi aines tai
osa.*

The option is off by default, which is what keeps the import path honest. A
draft's `lines` carries every part's lines along with the dish's, because the
parts do not exist yet and a `section` name is all that marks them — so an
empty array there really is an empty recipe. `saveRecipe` and
`src/batch-intake.ts` therefore refuse exactly what they refused before, and
only the editor waives the rule, only for a recipe whose parts it has already
loaded. Passing the answer in rather than counting the parts inside
`replaceRecipe` avoids a second query for something the editor knows.

The editor's **Tallenna muutokset** moves into a sticky bar in the same change
(`.editor-actions` in `src/html.ts`), because the editor is long enough that on
a phone the button sat several screens below whatever was being changed. It is
CSS only — `position: sticky` clear of the fixed tab strip — so a browser
without it gets today's behaviour and nothing on this path needs a script.

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
- **All amounts for an ingredient.** Nothing stops a recipe listing one
  ingredient twice — salt at two stages, oil to fry in and oil for the dressing
  — and the model's line choice is not independently verified. A mention
  therefore names the ingredient, and the screen reveals every distinct stated
  amount from that recipe's rows (`2 rkl / 1 dl`). Blank amounts are dropped and
  identical amounts collapse. Showing both cannot confidently give the cook the
  wrong single instruction.
- **No character range.** A stored `start`/`end` would be wrong the moment
  somebody fixed a typo earlier in the sentence. What is stored is the wording
  that was matched and roughly where it was; `resolveMentions` finds it again in
  whatever the text says now, taking the occurrence nearest the recorded
  position. Anything that cannot be placed — wording edited away, two references
  landing on the same words — is left as plain text, because linking the wrong
  word is worse than linking no word.

An occurrence has to be a **word of its own**, not a substring: a reference for
`suola` must not go on matching after the step becomes "Lisää suolakurkut", or
the salt amount lands in the middle of a word about gherkins. The boundary test
is Unicode-aware (`\p{L}\p{N}\p{M}`), because an ASCII rule would treat `ö` as a
boundary and match `suola` inside `suolaöljy`. Finnish inflection is unaffected:
the wording stored is the wording the step used, so `tomaatit` is matched as
`tomaatit` rather than derived from `tomaatti` — and a step later re-inflected
to `tomaatteja` loses the link, which is the harmless half of the trade.

The reference exists in two shapes and `saveRecipe` is where one becomes the
other. A **draft** reference (`DraftIngredientRef`) points at an ingredient line
by its *index*, because on an import half the ingredients do not have ids yet;
a **saved** one (`StepIngredientRef`) carries the `ingredient` id. The editor
converts back to indexes when it renders, since a form row is the thing a member
can move or retype and an index survives both.

An index alone is not enough, though: it says *where* an ingredient sits on the
form, not *which* one it is. So the editor also sends `expectedIngredientId`,
the ingredient the reference was made against, and `resolveStepRefs`
(`src/recipe-save.ts`) asks the question the mention actually asks — does this
step's own recipe row still have a line with that ingredient? The row is only a
handle: with a duplicated ingredient the editor has to hang the mention on one
of the rows and picks the first, so repointing *that* row while another still
carries the ingredient leaves the mention true and it survives. Change the only
tomato line to paprika and a step saying "tomaatit" has nothing left to name, so
it goes back to being plain text rather than quietly revealing paprika's amount.
Renaming an ingredient keeps its id, so a rename keeps its mentions — the same
rule, the other way up. The field is null on an import, where no id existed to
expect.

Asking about "this step's own recipe row" is also what refuses a cross-part
move, with no separate check: a line that ended up in a different part is not in
that list, so a reference to it resolves to nothing. A part is a recipe row of
its own, and an amount the reader cannot see on that screen is not worth linking
to.

An import reference has no ingredient to expect and is resolved through the row
it points at — matched on `LineToSave.formIndex`, the row's own number, rather
than on where it sits in the array. `readLines` drops removed rows and re-sorts
the rest by their position boxes, so somebody who removes one line on the review
screen would otherwise slide every later mention onto the next ingredient along,
which is a wrong amount rather than a missing one.

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

## A line that offers a choice (issue #183)

Proposed here: an ingredient line may be one of several options — *1
lihaliemikuutio **tai** 1 annos fondia*, voita tai margariinia. `src/alternatives.ts`
owns the whole idea and is the file to read first;
[ADR-0010](../adr/0010-an-alternative-is-a-line-not-a-substitution-rule.md) has
the survey of real recipes that decided its shape and the two alternatives it
rejected.

**Every option is an ordinary line.** Nothing about it is special, and that is
the design: it keeps its own quantity and unit — which is what #183 asks for —
plus its own range, second measurement, source wording and phase, and it names a
real `ingredient` rather than a phrase. What joins two lines is one nullable
number they share, scoped to their own recipe row.

- **A group renders where its first option sits.** The number is a member's own
  text box, so nothing stops it appearing on rows 1 and 5 with unrelated lines
  between; `alternativeSets` gathers them at the first rather than refusing
  input that says something perfectly clear. The recipe screen prints them
  joined by `tai`, and the Cast receiver joins them into one string for the same
  reason — two items on a TV list read as two things to fetch.
- **A group belongs to one recipe row *and* one cooking-order section, and a
  save refuses one that spans two.** `recipe-phase.ts::phaseBucket` is that
  boundary, and it is a bucket rather than a raw phase because the cooking view
  draws unclassified content with `before_parts`. Every end asks it: the save
  renumbers by it, the shopping list keys on it, and both screens already
  filter by it before they group. Getting this wrong was a real fault, not a
  hypothetical — a group split before/after rendered as two lone lines with no
  `tai` while the list still bought only the first, so a cook lost an
  ingredient. Grouping is per section but the *numbers* run across the whole
  row, so that a recipe with a group in each section can be opened and saved
  again without tripping the refusal.
- **A shared source sentence is stated once for the set.** Import gives every
  option of a group the same `source_line` — the page wrote one sentence and
  each option is a reading of it — and `sourceWorthShowing` turns true for
  every option with a stated amount as soon as a cooking is not 1×. Printing it
  per option repeated the whole choice under each of them, and on Cast embedded
  it inside each string before those were joined by another ` tai `, so
  `1 lihaliemikuutio tai 1 annos fondia` at 2× read as a choice inside a
  choice. `alternatives.ts::sharedSource` answers "is there one sentence here",
  and where the options genuinely carry different wording each keeps its own.
- **The thumbnail follows the default option.** A row showing two products would
  say "buy both", which is what a `tai` line does not mean.
- **The shopping list buys the first option and no other**, per cooking and per
  recipe row. The same dish planned twice needs its choice bought twice, and a
  dish's group 1 has nothing to do with its part's — which is why
  `ShoppingLine` carries `sourceRecipeId` beside `recipeId`. `recipeId` is the
  dish, because a product override is set per dish (#161); the group is stored
  on the row.
- **The editor's control is a number box** in the row's disclosure, beside the
  part and phase fields. No script, the standing rule on the editing path. It
  costs one number typed twice, and a grouping gesture is worth revisiting once
  somebody has used it.
- **A save dissolves a group of one and renumbers the rest from 1.** Neither
  rule can be a database `CHECK`, which sees one row at a time. A group number
  that is not a positive whole number is *refused* on the form rather than
  quietly dropped, even though the same value read off a column or off the
  model's JSON degrades to "no group" — a form is the one edge where somebody
  typed it on purpose.

`alternativeGroup` is on the `/api/recipes/:id` wire, and deliberately so. It
is not the same kind of field as `phase`, which only decides where a line is
drawn: without the group the JSON says a recipe needs kermaa *and*
kookosmaitoa, when it needs one of them. `tests/alternatives.spec.ts` pins the
exact key set of the recipe and line objects so nothing else drifts onto or off
that shape unnoticed.

Which option a household buys is **not** a member's choice yet. #183 hedges its
default with "ellei käyttäjä valitse muuta"; this change ships the default only,
and an override table is a slice of its own.

Intake can propose a group: `DRAFT_SCHEMA` carries an optional
`alternative_group` and the prompt asks for one line per option with the same
number and each option's own ingredient. It is optional on the wire so an
AgentDeck bundle written before this still imports. See
[intake](intake.md).

## What kind of food a recipe is (issue #196)

Proposed here: a recipe carries any number of categories — *Pasta*, *Keitto*,
*Uuniruoka* — and the list filters by one. `src/categories.ts` owns the whole
idea and is the file to read first;
[ADR-0012](../adr/0012-a-category-belongs-to-the-recipe-not-the-household.md)
holds the two decisions behind its shape and what they cost.

**No category is the ordinary state**, not missing data. Every recipe stored
before this has none, and every screen is written to read it that way: no tags
under the title, no extra segment on a list row, and no filter row at all until
something in the list is categorised.

- **A category belongs to the dish, not to the household.** The table carries no
  `household_id`, so a recipe shared under #143 or #185 says the same thing in
  every kitchen that can read it. The vocabulary is closed and lives in code for
  exactly that reason — a household-coined name would mean nothing to whoever
  the recipe was shared with. A household's own habit still belongs on
  `recipe_preference`, which is the other kind of fact and is scoped the other
  way.
- **Only a dish is categorised.** A part is a recipe row (ADR-0002) but nobody
  browses for a *juustokastike*, so the editor renders the picker only where
  `parentId` is null and `loadRecipe` does not ask for a part's categories.
- **The picker is checkboxes and no script**, the standing rule on the editing
  path. It is on the editor, and on the import review screen *outside* its
  `Muokkaa ennen tallennusta` disclosure — the 99% of imports that need no
  correction (#53) would otherwise save with no category at all, and the moment
  somebody is looking at a freshly imported dish is the moment they know what it
  is. Nothing asks the model for one.
- **The filter is a place, not a control.** `/recipes?kategoria=<slug>` is a
  link, so it survives the back button, a bookmark and a reload with no script.
  A name search made inside a category keeps it, a bulk publish comes back to
  it, and an unknown slug reads as no filter so a stale bookmark shows the
  recipes rather than an empty screen.
- **Only categories the list actually has get a chip.** A chip that leads
  nowhere makes the reader do the work of finding out it was empty. The chip
  being stood on is the exception and stays, or unticking the last recipe in a
  category would take away the only way back.
- **The chip row scrolls sideways rather than wrapping**, because the point of a
  filter above a list on a phone is that the list is still visible under it.

`categories` is deliberately **not** on the `/api/recipes` wire. Unlike
`alternativeGroup`, which changes what a recipe means, a category only changes
how somebody finds it, so a caller reads the same dish with or without it — and
`tests/alternatives.spec.ts` pins that key set. `dev/check-categories.ts` covers
the vocabulary and the filter's links; `tests/categories.spec.ts` covers the
screens.

## Publishing a recipe (issue #143)

Proposed here: a household may publish a dish, and a published dish is readable
and plannable by every other household while staying editable only by its owner.
`src/recipe-publish.ts` owns the rules and `src/publish-screens.ts` the two forms
that reach them; `src/recipes.ts` holds the two scopes everything reads through.

### Household-targeted sharing (#185, proposed)

This pull request proposes three owner-selected states: private, shared with
selected households, and public. `recipe.published_at` continues to mean public;
`recipe_share` records selected recipient households. `src/recipe-publish.ts`
owns transitions and refuses only when a household losing access has a future
plan. All readable/plannable query paths use its shared SQL condition, while
`findRecipe` and every write stay owner-only. See
[ADR-0009](../adr/0009-recipe-sharing-targets-households.md).

- **`findRecipe`** is own-only, and every write path uses it — editing,
  deleting, uploading a picture. **`findReadableRecipe`** adds "or published".
  Keeping them as two named functions rather than one flag is the point: a new
  write route has to opt *in* to the wider scope, and there is no reason it ever
  would.
- **A part is read through its dish.** Parts carry no `published_at`, so a
  non-owner asking for one directly gets a 404 — everything they need from it is
  already on the dish's screen. The dish's own load reaches its parts through
  the *owner's* household, which is why `partsOf` takes `row.household_id`
  rather than the reader's.
- **Unpublishing is refused while another household has a future occurrence**,
  and **a published recipe cannot be deleted at all** — delete asks for the
  unpublish first, so it inherits that check instead of carrying a second copy
  of it. A past occurrence blocks nothing. `countOnMenu` in
  `src/recipe-editor.ts` counts every household's batches for the same reason:
  once a past plan no longer blocks unpublishing, somebody else's row can still
  be pointing at the recipe when the owner tries to delete it.
- **The bulk form is the list itself.** A household shares a batch of recipes in
  one sitting, so the whole `.recipes` list on `/recipes` is one form with a
  checkbox per row and `Julkaise valitut` / `Poista julkaisu valituista` under
  it. The checkbox sits outside the row's link, so tapping a row still opens the
  recipe.
- **A partial result is a refusal.** Publishing eleven and having two blocked
  re-renders the list with the reason; only a clean run redirects.

`/recipes/julkiset` is the public section, and it deliberately excludes this
household's own published recipes: "ours" and "somebody else's" are different
things to a cook, and one of them can be corrected when the oven temperature
turns out to be wrong.

### A default that belongs to the kitchen

`recipe_preference` (`src/recipe-preference.ts`) holds one number per household
per recipe: the portion count the picker starts from. Issue #165 proposes
changing that number to `default_multiplier`. `recipe.yield_portions` is what the
source page said and travels with the recipe when it is published; this is the
household's own habit, and it is set and read by whoever is looking. The
publisher has no more say over another household's number than the other way
round. Under the proposal, a blank box and Tallenna clears it — the absence of
a row is "no particular default", the same shape the cupboard uses.

## Scaling

Issue #165 proposes replacing the portion count with a **multiplier**, and this
section describes what that change introduces. A recipe's stored amounts are 1×
the recipe. A planned batch stores how much of it gets cooked — 0,5×, 1,5×, 2×,
or any other positive number — and that is the only thing scaling
starts from. `recipe.yield_portions` stays as source metadata, printed under the
title as `Lähteessä 4 annosta` and computed with nowhere. See
[ADR-0007](../adr/0007-a-batch-is-scaled-by-a-multiplier.md).

One consequence is worth stating on its own: **a recipe whose source never said
what it makes scales exactly like one that did.** Roughly a fifth of imports are
like that, and before #165 the screen could only apologise.

A recipe opened from a cooking carries that cooking's multiplier. The week
itself is for reading, so the link is one step further in: a planned meal opens
`/batches/:id`, and *that* screen links to `/recipes/:id?multiplier=N` — it is
also where the multiplier gets changed and a meal gets taken off the list. The
week holds no inputs and no delete buttons on purpose (decision #36).

(That screen used to be `/meal-entries/:id`. #57/#86 replaced the whole
meal-entry model with planned batches and occurrences, and the routes moved with
it — see [data-model](docs/codebase/data-model.md).)

The multiplier control is `html.ts::multiplierField`: four one-tap chips
(`0,5× 1× 1,5× 2×`) posting `preset`, beside a box posting `multiplier` for
anything else. A browser sends only the pressed submit button's value, so a
handler reading `preset` first knows a chip was tapped — no script, which is the
standing rule on the planning path. The picker uses one compact field with the
four common values as datalist suggestions, because four buttons on every row
of a recipe list would bury the list while a closed select would forbid a new
custom value.

`src/scaling.ts` applies that multiplier, and a dish's multiplier reaches into
its parts — a part is a piece of the dish. 1× returns a line exactly as stored,
because pushing the recipe as written through the kitchen rounding would quietly
edit a line nobody asked to change.

Amounts round to what a cook can measure rather than to what the arithmetic
says: 5 dl times 1⅓ reads 6½ dl, not 6,666. Small amounts keep quarters, larger
ones go to halves and then whole numbers, weights go to the nearest 5 or 10 g.

The recipe screen is cook-first (decision #37), so a source line is not repeated
under every ingredient. `sourceWorthShowing` surfaces it in
exactly two cases: a line with **no stated amount**, because "hieman" and "maun
mukaan" have no field to live in, and a line whose amount **the multiplier
changed**,
because the number on screen is no longer the number on the page. Ranges and
second measurements round-trip through the fields intact, so they carry no copy.
The full source text sits behind `Näytä alkuperäinen`, still stored, still one
tap away.

That rule used to live in `src/recipes.ts`. Issue #123 proposes moving it to
`src/scaling.ts`, unchanged: it is a question about what scaling changed, and
the shopping list's breakdown has to ask it too. See
[screens](docs/codebase/screens.md).
