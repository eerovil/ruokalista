-- What kind of food a recipe is (issue #196).
--
-- Keyed on the recipe row and on nothing else. A category is part of what a
-- recipe *is*, the way its title is, so a published or selectively shared dish
-- (#143, #185) says the same thing in every kitchen that reads it. Putting a
-- household_id here would have meant the same lasagne being a Uuniruoka in one
-- kitchen and nothing in the next, which is not a fact about a kitchen the way
-- recipe_preference's default multiplier is.
--
-- The vocabulary is a closed list in src/categories.ts and this table stores
-- its slug, not a display name: renaming "Jälkiruoka" is then a code change
-- rather than a data migration, and no household can coin a category that
-- another household reading the same shared recipe has never heard of.
--
-- No row is the normal state. Every recipe saved before this has none, and
-- every screen reads that as "no categories" rather than as missing data.
CREATE TABLE recipe_category (
  recipe_id INTEGER NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
  category  TEXT NOT NULL,
  PRIMARY KEY (recipe_id, category)
);

-- The filter asks "which recipes are Keitto", so the category is the lookup.
CREATE INDEX recipe_category_by_category ON recipe_category(category);
