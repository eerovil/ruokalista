# 9. An alternative is a line, not a substitution rule

Date: 2026-08-28

## Status

Proposed by [Tuki reseptikohtaisille ainesvaihtoehdoille (#183)](https://github.com/eerovil/ruokalista/issues/183).

## Context

Recipes offer choices. *1 lihaliemikuutio tai 1 Fond du Chef -annos.* Voita tai
margariinia. Kermaa tai kookosmaitoa. Tuoretta chiliä tai chilihiutaleita. The
data model had nowhere to put that, and #183 asked for one.

Before deciding the shape, the production snapshot was read. **Seven of 202
ingredient lines, across 17 recipes, were already an alternative** — about 3,5 %,
and every one of them written as a workaround:

- Five baked the whole phrase into an `ingredient` name: `hunaja tai sokeri`,
  `pätkäspagetti tai sarvimakaroni`, `kaura- tai ruishiutale`,
  `savukinkku tai pizzasuikale`, `aurinkokuivattu tomaatti tai vihreä oliivi`.
- Two dropped the alternative and kept only the first — `liemikuutio` and
  `kasvisliemikuutio`, which is #183's own opening example.

The first workaround is worse than it looks. Since #143 the `ingredient` table
is a **global dictionary**, so one household's phrasing is now a row everybody
sees, offered in everybody's picker. A phrase-named row can never match a
`pantry_entry`, can never be bought as an `ingredient_product`, and adds up with
nothing on a shopping list. The information was being stored in the one place it
does the most damage.

Three shapes were considered.

**A substitution table** — `ingredient_substitute (ingredient_id, substitute_id)`
— was rejected first. It says the wrong thing. Kookosmaito replaces kerma in a
curry and not in a kermakakku; the fact is about the dish, not about the pair.
#183 says this in its own first paragraph, and a standing rule would also have
to answer "in what ratio", which is a question no household app should be
guessing at.

**A phrase on the line** — a nullable `ingredient_line.alternative_text` — was
rejected because it is the workaround with a better column name. The second
option would still be prose: no ingredient id, no cupboard match, no product, no
amount that scales.

## Decision

An alternative is **another ingredient line**, and one nullable column says the
two lines are a choice:

```sql
ALTER TABLE ingredient_line ADD COLUMN alternative_group INTEGER
  CHECK (alternative_group IS NULL OR alternative_group > 0);
```

Lines of **one recipe row and one cooking-order section** sharing a group number
are options for each other. Four rules follow, and `src/alternatives.ts` is the
only place they live:

- **A group is scoped to the recipe row and to one cooking-order section.** A
  part is a recipe of its own (ADR-0002), so its group 1 and its dish's group 1
  are different groups; and a multipart dish's own lines are split again by
  `recipe-phase.ts::phaseBucket`, because the cooking view draws before-parts
  and after-parts apart and two options a cook reads apart are not a choice. A
  save **refuses** a group that spans two rather than dissolving it silently.
- **NULL is not a group of one.** It means an ordinary line standing alone. A
  group needs two options or it is not a choice, so a save dissolves a
  singleton rather than storing it — a rule a `CHECK` cannot express, because a
  `CHECK` sees one row at a time.
- **The first option is the default.** Lowest `position` in the group.
- **The shopping list buys the default and nothing else.** Per cooking, per
  recipe row, per section: the same dish planned twice needs its choice bought
  twice, and two options the screen drew apart are two things to buy.

## Consequences

- **Each option keeps its own amount and unit for free**, which #183 requires.
  It also keeps its own range, second measurement, source wording and cooking
  phase, because it is an ordinary line and nothing about it is special.
- **Each option names a real ingredient.** That is the point of the whole
  change: the option can be in the cupboard, can be bought as a product, and
  adds up with the same foodstuff in another recipe.
- **No table is added**, so the six-file backup/restore manifest lockstep does
  not move — backup captures `SELECT *` and restore builds its `INSERT` from the
  row's own keys.
- **The seven existing lines are not migrated.** Splitting `hunaja tai sokeri`
  into two options means inventing the second option's amount, and this app does
  not invent amounts (#6, ADR-0001). They are a short hand-edit in the editor
  now that there is somewhere for the edit to go. Nothing breaks in the
  meantime: those rows are ordinary lines and read exactly as they read today.
- **Which option to buy is not yet a member's choice.** #183 hedges its default
  with "ellei käyttäjä valitse muuta", and this decision deliberately ships the
  default only. A household-scoped override would be a second table keyed by
  `(household_id, recipe_id, alternative_group)` — the shape
  `recipe_ingredient_product` already uses (ADR-0008) — and it is a slice of its
  own.
- **The boundary is one function, asked by four places.** Review of this pull
  request found the fault that makes that worth stating: with the save
  normalizing across a whole row while the screens filtered by phase first, a
  group split before/after rendered as two lone lines with no `tai` while the
  shopping list still counted them a pair and bought one. Whenever a fifth
  place needs to know what a group is, it asks `phaseBucket` too.
- **A shared source sentence is stated once per set.** Import gives every option
  the same `source_line`, so at any multiplier but 1x every option was worth
  showing and the whole choice was repeated under each of them — and on Cast,
  nested inside a string about to be joined by another ` tai `. Options with
  genuinely different wording still each carry their own.
- **The group is on the `/api/recipes/:id` wire**, unlike `phase`. A phase
  decides where a line is drawn; a group decides what the list of lines means,
  and omitting it would have the JSON claim a recipe needs both options.
- **The group number is a text box, not a control.** No script, which is the
  standing rule on the editing path, and it costs a member one number typed
  twice. A grouping gesture is worth revisiting once anybody has used this.
