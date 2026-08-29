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
-- `recipe_category` gains a foreign key onto this table, which is why it is
-- rebuilt at the bottom of this file. An earlier draft of #199 left it off,
-- reasoning that the only writer validates against the vocabulary first. That
-- is true and it is not enough: the validation is a separate read, so an admin
-- who removes a category in the moment between one member's check and that same
-- member's write lands an orphan slug no screen can ever filter by or clear.
-- The constraint closes the window in the one place both writers go through.
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


-- ------------------------------------------- recipe_category gets the key

-- Rebuilt rather than altered: SQLite cannot add a foreign key to an existing
-- column, and this is the constraint that makes "every stored category is one
-- the vocabulary has" true at write time rather than only just before it.
--
-- The rebuild is the simple kind. Nothing references `recipe_category`, so
-- dropping it cascades into nothing and renaming the replacement into place
-- rewrites no other table's clauses — the trap `0011_public_recipes.sql`
-- documents does not apply here. `category` is created and seeded above, so the
-- new table's target exists before a single row is copied.
--
-- No `ON DELETE` action on the new key, so removing a category that recipes
-- still carry is refused by the database. `src/category-admin.ts::deleteCategory`
-- already detaches the recipes first, in the same batch and before the category
-- row goes, which is the order that satisfies it.
CREATE TABLE recipe_category_scoped (
  recipe_id INTEGER NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
  category  TEXT NOT NULL REFERENCES category(slug),
  PRIMARY KEY (recipe_id, category)
);

-- Every slug written before this file ran came from the closed list #196
-- shipped, and all nine of those are seeded above, so this copies everything.
-- The join is here so that a row somehow naming a slug the vocabulary does not
-- have cannot fail the migration on the live database: such a row is already
-- invisible on every screen, and losing it is what the constraint means.
INSERT INTO recipe_category_scoped (recipe_id, category)
SELECT recipe_category.recipe_id, recipe_category.category
  FROM recipe_category
  JOIN category ON category.slug = recipe_category.category;

DROP TABLE recipe_category;
ALTER TABLE recipe_category_scoped RENAME TO recipe_category;

-- The filter asks "which recipes are Keitto", so the category is the lookup.
-- Recreated because the index went with the old table.
CREATE INDEX recipe_category_by_category ON recipe_category(category);
