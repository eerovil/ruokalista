# ADR-0017: The menu is a to-do list, not a calendar

Status: proposed in #345.

## Context

The household planned meals on a two-week calendar: each planned batch had one
or more occurrences, a date plus lunch or dinner (ADR-0004). The owner asked to
replace that calendar with a plain list of dishes to cook, with no days and no
meals.

## Decision

The home screen (`/`, **Kokattavat**) is a to-do list of dishes. A dish goes on
it from its recipe page, at a size (the multiplier, ADR-0007), and leaves it
when somebody taps **Kokattu** or takes it off without cooking. The shopping
list adds up the dishes on the list; its picker still lets a trip leave some out,
and a fresh list starts with every one ticked.

A dish on the list is still a **planned batch**, one with no occurrences. Being
cooked is a new column, `planned_batch.cooked_on`, set to the day it was ticked.
So:

- on the list = no occurrences and `cooked_on` is NULL;
- cooked = `cooked_on` set; the cooking history counts it on that day;
- the calendar's old batches keep their occurrences. Nothing shows or writes
  them any more, but the history still counts the past ones, and a future one
  still counts as somebody's plan.

`src/batch-state.ts` holds the two SQL questions everything else asks: is this
batch on a list, and is it still somebody's plan (on a list, or on a calendar day
still to come). Unsharing a recipe is refused while it is still somebody's plan;
deleting a recipe is refused on the same rule, and batches already cooked are
deleted with the recipe.

## Why a column and not a new table

A new table would have needed its own backup and restore entries, and the
shopping list, the product picks and the S-ostoslista send all key off batch ids
already. Keeping the list in `planned_batch` let all of that work unchanged, and
"one row is one cooking" stays true.

## Consequences

- `/picker`, `/api/menu` and the calendar's screens are gone. `/api/batches`
  keeps its paths but takes `{ recipeId, multiplier }`, and `PATCH` changes the
  multiplier or sets `cooked: true`.
- The calendar's tables and rows stay. Dropping `batch_occurrence` is a later,
  separate change, once nobody needs the old history.
