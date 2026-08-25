-- Parent content in a multipart dish can happen before or after its named parts.
-- NULL remains meaningful: old rows were never classified by the intake model.
ALTER TABLE recipe_step ADD COLUMN phase TEXT
  CHECK (phase IS NULL OR phase IN ('before_parts', 'after_parts'));

ALTER TABLE ingredient_line ADD COLUMN phase TEXT
  CHECK (phase IS NULL OR phase IN ('before_parts', 'after_parts'));
