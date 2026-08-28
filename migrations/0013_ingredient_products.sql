-- An ingredient may know several shop products, and a recipe may insist on one.
--
-- #147 gave each canonical ingredient exactly one S-group product, stored on
-- the ingredient row itself. That cannot say what jauheliha needs said: the
-- same foodstuff is sold as 400 g, 700 g and 1 kg, and which of those to buy
-- depends on how much the week's cooking asks for. #161 replaces the single
-- column with a small table of products per ingredient, each carrying its
-- package size as data rather than as words inside a product name.
--
-- The second table is the deliberate exception to "one product per
-- ingredient": a household may pin one recipe's use of an ingredient to one
-- product, so a kanapasta always gets its own marinated fillet while every
-- other dish keeps the generic choice.

CREATE TABLE ingredient_product (
  id INTEGER PRIMARY KEY,
  ingredient_id INTEGER NOT NULL REFERENCES ingredient(id) ON DELETE CASCADE,
  ean TEXT NOT NULL,
  name TEXT NOT NULL,
  image_url TEXT,
  -- Both null together: a product whose package size could not be read is
  -- still choosable, it just never contributes a package count.
  package_quantity REAL,
  package_unit TEXT,
  position INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX ingredient_product_unique
  ON ingredient_product(ingredient_id, ean);
CREATE INDEX ingredient_product_by_ingredient
  ON ingredient_product(ingredient_id);

-- Keyed by recipe and ingredient rather than by ingredient_line.id on purpose:
-- saving a recipe deletes and re-inserts its lines, so a line-id key would
-- lose every override the next time somebody fixed a typo.
--
-- Household-scoped because the recipe may not be this household's. Since #143
-- a published dish is plannable by everybody, and each household gets to
-- choose its own product for it without writing into the owner's record.
CREATE TABLE recipe_ingredient_product (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  recipe_id INTEGER NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredient(id) ON DELETE CASCADE,
  ean TEXT NOT NULL,
  name TEXT NOT NULL,
  image_url TEXT,
  package_quantity REAL,
  package_unit TEXT
);

CREATE UNIQUE INDEX recipe_ingredient_product_unique
  ON recipe_ingredient_product(household_id, recipe_id, ingredient_id);

-- Every mapping made under #147 becomes that ingredient's first product. The
-- package size arrives empty because SQLite cannot read `400 g` out of a name;
-- the app fills it in the first time it sees the row and can parse it, and a
-- name it cannot parse simply stays without one.
INSERT INTO ingredient_product
  (ingredient_id, ean, name, image_url, package_quantity, package_unit, position)
SELECT id,
       ean,
       COALESCE(external_product_name, ean),
       external_product_image_url,
       NULL,
       NULL,
       1
  FROM ingredient
 WHERE ean IS NOT NULL
   AND trim(ean) <> '';

-- The old columns go rather than linger: two places to look for the chosen
-- product is exactly the drift #161 asks to end.
ALTER TABLE ingredient DROP COLUMN ean;
ALTER TABLE ingredient DROP COLUMN external_product_name;
ALTER TABLE ingredient DROP COLUMN external_product_image_url;
