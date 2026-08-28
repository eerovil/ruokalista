# ADR-0007: A cooking is scaled by a multiplier, not by a portion count

## Status

Proposed by issue #165. This change supersedes the scaling model described in
`docs/spec.md` and in earlier revisions of `docs/codebase/recipes.md`, where a
planned meal carried a portion count and `src/scaling.ts` divided it by the
recipe's stated yield.

## The decision this change introduces

**A recipe's stored amounts are 1× the recipe.** They are not "amounts for four
portions" that happen to be written down; they are the recipe. Everything the
app shows a cook is that recipe times a number.

**A planned batch stores that number.** `planned_batch.multiplier` replaces
`planned_batch.portions`. A batch reads *Tortillalasagne · 1,5×*.

**A household's saved default is a multiplier too.** The household-scoped
preference introduced by #143 becomes `recipe_preference.default_multiplier`,
and stays household-scoped for exactly the reason it was introduced: a publisher
who always cooks their lasagne at 2× must not push 2× onto everybody who plans
it.

**`recipe.yield_portions` stays, and stops being load-bearing.** It is what the
source page claimed the recipe makes. The recipe screen prints it as metadata
— *Lähteessä 4 annosta* — and nothing computes with it.

## Why

The old model asked a question a cook does not ask. Standing at a hob nobody
thinks "this evening is nine portions"; they think "one and a half times the
recipe". The portion count was an extra hop through arithmetic to arrive at a
number the cook had already decided.

It also failed in a way that could not be repaired. Roughly a fifth of imported
recipes never state a yield, and under the old rules those recipes could not be
scaled at all — the screen had to say so and offer nothing. That was correct
given the model and useless given the kitchen. Under a multiplier the question
never arises: the recipe as written is 1×, whether or not the source said what
that makes.

The change also has to land before packet sizes and product choice (#151-ish
work on S-ostoslista) build anything deeper on scaling semantics, because those
would otherwise be built on the number this replaces.

## What this does not change

- Batch coverage. A batch still owns its occurrences, and a multiplier still has
  nothing to do with how many meals one pot covers (ADR-0004). The shopping list
  still counts a batch once however far it stretches.
- Kitchen rounding. 5 dl at 4/3 still reads 6½ dl. Only where the factor comes
  from changed.
- Parts. A part is a piece of the dish (ADR-0002) and takes the dish's
  multiplier, which is what it always did.
- Household isolation, and #143's one exception to it.
- Per-person or per-eater portioning. Nothing here is a step toward it; it was
  explicitly ruled out of scope.

## Migrating what already exists

`migrations/0013_recipe_multiplier.sql` converts a batch as
`portions / yield_portions` where the dish states a usable integer yield,
preserving the ratio rather than rounding it. Yield 4 with 6 portions becomes
1,5×; 4 with 4 becomes 1×; 4 with 8
becomes 2×.

Where that division cannot be trusted because the dish never stated a usable
integer yield, **no multiplier is invented**. The batch is set
to 1× and its old number is kept in `planned_batch.legacy_portions`, and the
week screen says so on the card so a cook can correct it rather than discover it
in a pan. That column is NULL for every batch planned since, and saving a
multiplier clears it.

An unconvertible `recipe_preference` row is deleted instead. That is not the
same decision made differently: under the old rules a default of six portions
for a dish with no stated yield produced no factor at all, so the row was
already doing nothing. Dropping it leaves the household with no saved default,
which is a state the app already has a shape for, and setting one again is one
tap.

## What was considered and rejected

- **Keeping both a portion count and a multiplier.** Two numbers meaning the
  same thing, one of them authoritative and one of them not, is the shape that
  produces a screen disagreeing with a shopping list.
- **Defaulting an unconvertible batch to its old portion count read as a
  multiplier** (six portions becoming 6×). Silently catastrophic, and precisely
  the invented number the issue rules out.
- **Restricting the multiplier to 0,5 / 1 / 1,5 / 2.** Those four are what the
  screens offer with one tap; the domain takes any positive number,
  and the batch screen has a box for it. A household that cooks something at 3×
  should not have that rounded for them.
