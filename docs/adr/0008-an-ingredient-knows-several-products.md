# 8. An ingredient knows several products, and a recipe may insist on one

Proposed in #161. (0007 is reserved by the in-flight recipe-multiplier change
in #165, so this one takes the next number rather than racing it.)

## The problem

#147 gave each canonical ingredient one S-group product, stored as three
columns on the `ingredient` row: `ean`, `external_product_name`,
`external_product_image_url`. That is enough to say "when we buy maito, we buy
this carton", and it is not enough for anything the shop sells in more than one
size. Jauheliha comes as 400 g, 700 g and 1 kg, and which of them to buy is not
a fact about jauheliha at all — it depends on how much the week's cooking asks
for.

The single column also has no room for the other thing a household wants: one
recipe insisting on its own product. The same kanasuikale fits a curry and a
pasta, but the pasta may want a particular marinated packet every time without
that becoming what kanasuikale *is*.

## The decision

Two tables replace the three columns.

`ingredient_product` holds what an ingredient can be bought as: several rows per
ingredient, each with an EAN, a name, an image, and a **structured package
size** — an amount and a unit, both null together when the size is not known.
The size is data. It is read off the product's name once, when somebody chooses
the product, and never re-derived while building a shopping list.

`recipe_ingredient_product` holds the exception: one product for one recipe's
use of one ingredient, per household. It is keyed by `(household_id, recipe_id,
ingredient_id)` rather than by `ingredient_line.id`, because saving a recipe
deletes and re-inserts every line — a line-id key would silently lose each
override the next time somebody fixed a typo. Household-scoped because a
published dish is plannable by everybody since #143, and each household chooses
its own product for it without writing into the owner's record.

The shopping list then groups by ingredient **and** override. A pinned recipe's
need is its own row with its own total and its own packets; the generic pile is
what is left. Adding the two together would either buy the curry a marinated
fillet or lose the pasta the one it asked for.

## What follows from it

- **`ingredient.ean` is gone**, not merely unused. Two places to look for the
  chosen product is the drift this change exists to end. The migration copies
  every existing mapping into `ingredient_product` first, so nothing is lost;
  the sizes those rows never had a column for are filled in the first time the
  app reads a name it can parse.
- **Package arithmetic converts; display still does not.** `src/packaging.ts`
  converts inside one family only — kg to g, dl to ml — because those are
  definitions. Grams to millilitres is a density this app does not know, and
  `rkl` is not a reliable millilitre. A total the app cannot express as one
  amount gets no package count at all, and neither does an ingredient whose
  packets have no known size. `5 dl + 2 rkl` still reads exactly that way on
  the list.
- **A wrong count is worse than no count.** Everywhere the sizes run out —
  an unparsable name, a unit outside the families, a mixed total, a need beyond
  a sensible trolley — the row falls back to what it did before: the chosen
  product, once, with nothing claimed about how many.
- **The integration's real add semantics are used rather than assumed.** The
  private service's `POST /items` is keyed by EAN and holds one copy per key, so
  a second packet is sent as the written line beside the product rather than
  through a quantity field that may not exist.
