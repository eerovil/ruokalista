-- Scaling stops being a portion count and becomes a multiplier (#165).
--
-- The old model asked "how many portions is this day for?" and divided by what
-- the source page said the recipe makes. That reads backwards in a kitchen: a
-- cook does not think "nine portions", they think "one and a half times the
-- recipe". So a recipe's stored amounts simply *are* 1x, and a planned batch
-- records how much of it gets cooked.
--
-- `recipe.yield_portions` is untouched. It is still what the source said, it is
-- still worth printing, and it is no longer the thing scaling starts from --
-- which is why a recipe that never stated a yield can now be scaled at all.
--
-- No table is rebuilt here. `planned_batch` is the parent of
-- `batch_occurrence`'s ON DELETE CASCADE, so dropping and recreating it would
-- take the occurrences with it (see docs/codebase/data-model.md). ADD COLUMN
-- and DROP COLUMN need none of that, and SQLite carries a column's own CHECK
-- away with the column when it goes.

-- ------------------------------------------------------------ the batch

-- 1x is the default because it is what an unscaled cooking means, not because
-- it is a safe-looking number: every existing row is rewritten below or else
-- keeps its old count in `legacy_portions`.
ALTER TABLE planned_batch
  ADD COLUMN multiplier REAL NOT NULL DEFAULT 1 CHECK (multiplier > 0);

-- What an unconvertible row used to say, kept rather than guessed at. NULL for
-- every row that converted cleanly and for every batch planned from now on.
ALTER TABLE planned_batch ADD COLUMN legacy_portions INTEGER;

-- portions / yield, for the batches whose dish states a usable integer yield.
-- Keep the ratio itself: rounding it here would quietly change what the old
-- batch meant.
UPDATE planned_batch
   SET multiplier = (
         SELECT planned_batch.portions * 1.0 / recipe.yield_portions
           FROM recipe
          WHERE recipe.id = planned_batch.recipe_id
       )
 WHERE EXISTS (
         SELECT 1 FROM recipe
          WHERE recipe.id = planned_batch.recipe_id
            AND recipe.yield_portions IS NOT NULL
            AND typeof(recipe.yield_portions) = 'integer'
            AND recipe.yield_portions > 0
       );

-- Everything else: the dish never said a usable integer yield. Those batches
-- get 1x and keep their old number, and `week-screens.ts` says so on the card
-- rather than letting an
-- invented factor pass for a decision somebody made.
UPDATE planned_batch
   SET legacy_portions = portions
 WHERE NOT EXISTS (
         SELECT 1 FROM recipe
          WHERE recipe.id = planned_batch.recipe_id
            AND recipe.yield_portions IS NOT NULL
            AND typeof(recipe.yield_portions) = 'integer'
            AND recipe.yield_portions > 0
       );

ALTER TABLE planned_batch DROP COLUMN portions;

-- -------------------------------------------------- the household's default

-- The same swap on the household-scoped preference from #143. It stays
-- household-scoped: a publisher who always cooks their lasagne at 2x must not
-- push 2x onto everybody who plans it.
ALTER TABLE recipe_preference
  ADD COLUMN default_multiplier REAL NOT NULL DEFAULT 1 CHECK (default_multiplier > 0);

UPDATE recipe_preference
   SET default_multiplier = (
         SELECT recipe_preference.default_portions * 1.0 / recipe.yield_portions
           FROM recipe
          WHERE recipe.id = recipe_preference.recipe_id
       )
 WHERE EXISTS (
         SELECT 1 FROM recipe
          WHERE recipe.id = recipe_preference.recipe_id
            AND recipe.yield_portions IS NOT NULL
            AND typeof(recipe.yield_portions) = 'integer'
            AND recipe.yield_portions > 0
       );

-- A preference that cannot be converted is dropped rather than given a made-up
-- multiplier. Nothing is lost that was doing anything: under the old rules a
-- default of six portions for a dish with no stated yield produced no factor at
-- all, so the row was already inert. The household simply has no saved default
-- again, and setting one is one tap on the recipe screen.
DELETE FROM recipe_preference
 WHERE NOT EXISTS (
         SELECT 1 FROM recipe
          WHERE recipe.id = recipe_preference.recipe_id
            AND recipe.yield_portions IS NOT NULL
            AND typeof(recipe.yield_portions) = 'integer'
            AND recipe.yield_portions > 0
       );

ALTER TABLE recipe_preference DROP COLUMN default_portions;
