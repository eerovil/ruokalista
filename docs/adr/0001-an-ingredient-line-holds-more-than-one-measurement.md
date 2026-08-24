# 1. An ingredient line holds more than one measurement

Date: 2026-08-24

## Status

Accepted. Narrows [How structured an ingredient is (#6)](https://github.com/eerovil/ruokalista/issues/6)
without reopening it.

## Context

#6 locked the shape of an ingredient line as `(quantity, unit, ingredient,
source line)` — one amount, in one unit, per line. Quantity and unit may be
blank and are never fabricated; units are kept as written and nothing is
converted.

Writing the v1 build spec meant checking that shape against the real ingredient
lines collected on the `research/recipe-import` branch for
[#2](https://github.com/eerovil/ruokalista/issues/2) — about 45 lines scraped
from six Finnish recipe sites. Two kinds of line do not fit:

- **A range.** k-ruoka's `1–1 ja ½ l vettä` — one to one and a half litres,
  with a Finnish word inside the range. One in roughly forty-five lines.
- **The same item measured twice, in different units.** meillakotona's
  `½ (500 g) valkokaali` — half a cabbage *and* 500 g. Not a range. More
  frequent in the sample than ranges are.

Under #6's shape both collapse to a blank quantity, because neither can be
stated honestly as a single number and #6 forbids inventing one. The line then
renders with no amount at all — "vettä", "valkokaali" — while the recipe
plainly stated one. The information survives in the source line, but only for
someone who reads it.

That is a worse outcome than #6 intended. #6 was protecting against fabricated
quantities, not against stated ones disappearing.

A third case stays as #6 has it: lines with genuinely no amount, such as
`tuoretta timjamia` or `hyppysellinen suolaa`. About a fifth of the sample.
Blank is the honest answer there and nothing changes.

## Decision

An ingredient line carries up to two measurements, and the first may be a
range:

- `quantity`, `quantity_max`, `unit` — the amount as written, with
  `quantity_max` set only when the source genuinely states a range.
- `alt_quantity`, `alt_unit` — a second measurement of the same item in a
  different unit, set only when the source states one.

Two database `CHECK`s keep this honest: a second measurement is both halves or
neither, and never appears without a first.

**Neither measurement is the primary one.** `alt_` means "written second", not
"less important". Because the data expresses no preference, each screen decides,
and those render rules live in `docs/spec.md`: a recipe shows both in source
order ("½ kpl (500 g)"), and scaling multiplies both, using the low end of a
range.

#6's substance is untouched. Nothing is fabricated, units are still stored
exactly as written, and nothing is converted between them — storing both halves
of `½ (500 g)` is the opposite of converting, since it is precisely the refusal
to pick one and derive the other.

## Consequences

- A stated amount no longer vanishes from the screen. This was the point.
- The eventual shopping list gains something real: where a line offers two
  units, the list may group on whichever one matches its other lines. This is
  the strongest argument for storing both, and it only pays off once that
  feature exists.
- Scaling needed a rule that the "no primary measurement" position does not
  supply on its own. It uses `quantity` and a range's low end. That rule is a
  render decision and cheap to change.
- The line table now has five quantity-ish columns, four of them null on most
  rows. A measurements child table would model this better and would absorb a
  third measurement and a range on the second one. It was considered and
  rejected as too much structure for two known cases in a household app.
- Two limits follow from that rejection, both accepted: **the second
  measurement cannot itself be a range**, and **there is no third slot**.
  Neither appears in the sample. A line needing either keeps the truth in its
  source line, exactly as before.
- `CONTEXT.md`'s definition of an ingredient line was rewritten to match, since
  it described a single amount in a single unit.
