-- Public recipes, and the global ingredient dictionary they need (#143).
--
-- Two changes that only work together. A household may publish a recipe so
-- every other household can read and plan it; and `ingredient` stops being
-- household-scoped, so a published recipe's lines mean the same foodstuff in
-- everybody's shopping list and cupboard. Without the second half a shared
-- recipe would need a per-household remapping layer, which is the thing this
-- issue exists to avoid.
--
-- Household isolation is otherwise untouched. `recipe.household_id` still says
-- who owns a recipe and is still what every write is scoped by; publication is
-- the one named exception, and it grants reading and planning, never editing.

-- ------------------------------------------------------------ ingredients

-- Which household-local rows collapse into which surviving global row.
--
-- Matched on a folded name because the same foodstuff has been typed into two
-- households independently: several `suola` rows are the worked example in the
-- issue. SQLite's `lower()` is ASCII-only and would leave `Öljy` and `öljy` as
-- two ingredients, so the three Finnish vowels are folded by hand first — the
-- same reason `src/ingredients.ts` sorts in JavaScript rather than in SQL.
--
-- The survivor is the lowest id, which is arbitrary but stable: re-running the
-- query on the same data always picks the same row.
CREATE TABLE ingredient_merge AS
  WITH keyed AS (
    SELECT id,
           lower(replace(replace(replace(name, 'Ä', 'ä'), 'Ö', 'ö'), 'Å', 'å'))
             AS norm
      FROM ingredient
  )
  SELECT keyed.id AS old_id,
         (SELECT min(other.id) FROM keyed AS other WHERE other.norm = keyed.norm)
           AS new_id
    FROM keyed;

-- Every reference moves to the survivor before the old rows go. Nothing is
-- deleted here that a recipe or a cupboard still points at.
UPDATE ingredient_line
   SET ingredient_id = (
         SELECT new_id FROM ingredient_merge
          WHERE old_id = ingredient_line.ingredient_id
       )
 WHERE ingredient_id IN (
         SELECT old_id FROM ingredient_merge WHERE old_id <> new_id
       );

-- A cupboard is one row per household per ingredient, so two rows in the same
-- household whose ingredients just merged would collide on that uniqueness.
-- Both said the same thing — "we have this in" — so the older row is kept and
-- the duplicate dropped; the household's cupboard still holds the foodstuff.
DELETE FROM pantry_entry
 WHERE id NOT IN (
   SELECT min(pantry_entry.id)
     FROM pantry_entry
     JOIN ingredient_merge
       ON ingredient_merge.old_id = pantry_entry.ingredient_id
    GROUP BY pantry_entry.household_id, ingredient_merge.new_id
 );

UPDATE pantry_entry
   SET ingredient_id = (
         SELECT new_id FROM ingredient_merge
          WHERE old_id = pantry_entry.ingredient_id
       )
 WHERE ingredient_id IN (
         SELECT old_id FROM ingredient_merge WHERE old_id <> new_id
       );

-- A step's ingredient mentions (#120) carry ingredient ids inside a small JSON
-- array, so they have to be rewritten too or a merged ingredient's amount stops
-- being revealed. `json_valid` guards the same case `parseStepRefs` does: a
-- value that cannot be understood is left exactly as it is rather than
-- replaced by an empty array, so nothing is silently thrown away here.
UPDATE recipe_step
   SET ingredient_refs = (
         SELECT json_group_array(
                  json_object(
                    'ingredientId',
                    coalesce(
                      (SELECT new_id FROM ingredient_merge
                        WHERE old_id = json_extract(ref.value, '$.ingredientId')),
                      json_extract(ref.value, '$.ingredientId')
                    ),
                    'matchedText', json_extract(ref.value, '$.matchedText'),
                    'approxPosition', json_extract(ref.value, '$.approxPosition')
                  )
                )
           FROM json_each(recipe_step.ingredient_refs) AS ref
       )
 WHERE ingredient_refs IS NOT NULL
   AND json_valid(ingredient_refs)
   AND json_type(ingredient_refs) = 'array'
   AND json_array_length(ingredient_refs) > 0;

-- ---------------------------------------------- rebuilding around the column
--
-- `household_id` cannot simply be dropped: it carries a foreign key, and SQLite
-- refuses DROP COLUMN on a column a constraint names. So the table has to be
-- rebuilt — which is also the only way to replace the per-household uniqueness
-- with the global one.
--
-- The obvious rebuild does not work here, and the reason is worth writing down
-- because it costs an afternoon to rediscover. D1 enforces foreign keys, always,
-- and a migration's statements do not run inside a transaction this file can
-- control, so `PRAGMA defer_foreign_keys` buys nothing: `DROP TABLE ingredient`
-- while `ingredient_line` still references it fails outright, and
-- `pantry_entry`'s `ON DELETE CASCADE` would empty every cupboard on the way
-- past. Renaming instead does not help either. With foreign keys on, SQLite
-- rewrites other tables' `REFERENCES ingredient` clauses to follow the rename,
-- whatever `legacy_alter_table` says — so the children chase the old table
-- around rather than attaching to the new one.
--
-- That same rewrite is what this does use, deliberately. The new table is built
-- under a working name, the two children are rebuilt to reference *it*, and only
-- then is the old table dropped and the new one renamed into place — at which
-- point SQLite rewrites both children's clauses from `ingredient_global` to
-- `ingredient` for us. No statement in the sequence ever leaves a constraint
-- violated, so none of it depends on a pragma.
CREATE TABLE ingredient_global (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,          -- as the household that coined it wrote it
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  created_by  INTEGER NOT NULL REFERENCES member(id)
);

INSERT INTO ingredient_global (id, name, created_at, created_by)
SELECT ingredient.id, ingredient.name, ingredient.created_at, ingredient.created_by
  FROM ingredient
  JOIN ingredient_merge ON ingredient_merge.old_id = ingredient.id
 WHERE ingredient_merge.new_id = ingredient.id;

-- Same shape as `0001_init.sql` plus `0004_semantic_phases.sql`'s phase column,
-- pointing at the new dictionary.
CREATE TABLE ingredient_line_global (
  id             INTEGER PRIMARY KEY,
  recipe_id      INTEGER NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  quantity       REAL,
  quantity_max   REAL,
  unit           TEXT,
  alt_quantity   REAL,
  alt_unit       TEXT,
  ingredient_id  INTEGER NOT NULL REFERENCES ingredient_global(id),
  source_line    TEXT NOT NULL,
  phase          TEXT CHECK (phase IS NULL OR phase IN ('before_parts', 'after_parts')),

  CHECK ((alt_quantity IS NULL) = (alt_unit IS NULL)),
  CHECK (alt_quantity IS NULL OR quantity IS NOT NULL)
);

INSERT INTO ingredient_line_global
  (id, recipe_id, position, quantity, quantity_max, unit,
   alt_quantity, alt_unit, ingredient_id, source_line, phase)
SELECT id, recipe_id, position, quantity, quantity_max, unit,
       alt_quantity, alt_unit, ingredient_id, source_line, phase
  FROM ingredient_line;

DROP TABLE ingredient_line;
ALTER TABLE ingredient_line_global RENAME TO ingredient_line;
CREATE UNIQUE INDEX ingredient_line_order ON ingredient_line(recipe_id, position);
CREATE INDEX ingredient_line_by_ingredient ON ingredient_line(ingredient_id);

-- Same shape as `0008_pantry.sql`. The cupboard stays household-scoped — only
-- the ingredient it names became global, which is the whole point.
CREATE TABLE pantry_entry_global (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES household(id),
  ingredient_id INTEGER NOT NULL REFERENCES ingredient_global(id) ON DELETE CASCADE,
  state         TEXT NOT NULL CHECK (state IN ('unlimited', 'quantity')),
  quantity      REAL,
  quantity_unit TEXT,
  added_at      TEXT NOT NULL DEFAULT (datetime('now')),
  added_by      INTEGER NOT NULL REFERENCES member(id),

  CHECK ((state = 'quantity') = (quantity IS NOT NULL)),
  CHECK (quantity IS NULL OR quantity >= 0),

  UNIQUE (household_id, ingredient_id)
);

INSERT INTO pantry_entry_global
  (id, household_id, ingredient_id, state, quantity, quantity_unit, added_at, added_by)
SELECT id, household_id, ingredient_id, state, quantity, quantity_unit, added_at, added_by
  FROM pantry_entry;

DROP TABLE pantry_entry;
ALTER TABLE pantry_entry_global RENAME TO pantry_entry;

-- Nothing references the old dictionary any more, so it goes without cascading
-- into anything, taking its per-household index with it.
DROP TABLE ingredient;
ALTER TABLE ingredient_global RENAME TO ingredient;

-- Exact-match, like the index it replaces. Case-insensitive matching stays in
-- `src/recipe-save.ts::resolveIngredients`, which folds in Finnish; an index
-- cannot, because SQLite's NOCASE is ASCII-only.
CREATE UNIQUE INDEX ingredient_name ON ingredient(name);

DROP TABLE ingredient_merge;

-- ------------------------------------------------------------- publication

-- Publication is two nullable columns on the recipe, not a table: a recipe is
-- published or it is not, there is no second state and nothing else to record.
-- NULL is unpublished, which is what every existing recipe is.
ALTER TABLE recipe ADD COLUMN published_at TEXT;
ALTER TABLE recipe ADD COLUMN published_by INTEGER REFERENCES member(id);

-- The public list is "every published dish", so the index is on the column the
-- list filters by.
CREATE INDEX recipe_published ON recipe(published_at, id);

-- ------------------------------------------------- household-side preference

-- How many portions *this* household cooks a recipe in, which is not a fact
-- about the recipe. A publisher who always makes their lasagne for nine must
-- not push nine onto everyone who plans it, so the number lives in a
-- household-scoped row keyed by recipe rather than on the shared recipe.
--
-- `ON DELETE CASCADE` because a preference is meaningless without its recipe,
-- and because a recipe deleted by its owner may still have preferences left
-- behind by households that once used it while it was published.
CREATE TABLE recipe_preference (
  id                INTEGER PRIMARY KEY,
  household_id      INTEGER NOT NULL REFERENCES household(id),
  recipe_id         INTEGER NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
  default_portions  INTEGER NOT NULL CHECK (default_portions > 0),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by        INTEGER NOT NULL REFERENCES member(id),

  UNIQUE (household_id, recipe_id)
);
