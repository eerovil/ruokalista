-- The category vocabulary becomes data an admin can edit (issue #199).
--
-- #196 put the vocabulary in `src/categories.ts` on purpose: a closed list in
-- code cannot be misspelt, cannot be coined per household, and renaming a label
-- is a code change rather than a data migration. That reasoning still holds for
-- everything except the last clause — the household asking for a new category
-- had to wait for a release. ADR-0013 records the swap and what it costs.
--
-- What does *not* change is what a recipe stores. `recipe_category.category` is
-- still the slug, so renaming a label still touches no recipe row, and a slug
-- is still plain ASCII so nothing downstream has to think about `ä` in an
-- identifier. The table below is the vocabulary itself, not a per-household
-- naming layer: there is no `household_id` here, for exactly the reasons
-- ADR-0012 gives.
--
-- No foreign key from `recipe_category`. Adding one would mean rebuilding that
-- table, and it would buy little: the only writer validates against this table
-- first, deleting a category detaches its recipes in the same batch, and an
-- orphaned slug already renders as itself and reads as no filter rather than as
-- an error. The rebuild is the risk; the fallback is already there.
CREATE TABLE category (
  slug     TEXT PRIMARY KEY,
  label    TEXT NOT NULL UNIQUE,
  -- Where the picker and the chip row draw it. Free of gaps only by habit:
  -- everything reads by `ORDER BY position`, so a gap is harmless.
  position INTEGER NOT NULL
);

-- The seven #196 shipped with, plus the two #199 asks for.
--
-- `Kastike` and `Pizza/piirakka` are both their own dish rather than a theme or
-- a main ingredient, which is the line this level of the vocabulary holds:
-- diets, themes and main ingredients would be separate filter dimensions if
-- they are ever wanted, never more rows here.
--
-- `Kastike` sits with the savoury dishes and `Pizza/piirakka` next to
-- `Leivonta`, because a piirakka is commonly both — the vocabulary stays
-- multi-select, so it does not have to choose.
INSERT INTO category (slug, label, position) VALUES
  ('pasta',          'Pasta',          1),
  ('keitto',         'Keitto',         2),
  ('salaatti',       'Salaatti',       3),
  ('uuniruoka',      'Uuniruoka',      4),
  ('kastike',        'Kastike',        5),
  ('pizza-piirakka', 'Pizza/piirakka', 6),
  ('leivonta',       'Leivonta',       7),
  ('jalkiruoka',     'Jälkiruoka',     8),
  ('lisuke',         'Lisuke',         9);
