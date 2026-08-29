-- An intake job may propose changes to an existing owned recipe (#215).
-- Nullable columns keep every ordinary import unchanged. The recipe and its
-- revision are captured when the job starts so the eventual review/save can
-- refuse an edit made against an older version instead of overwriting it.

ALTER TABLE intake_job ADD COLUMN target_recipe_id INTEGER REFERENCES recipe(id) ON DELETE CASCADE;
ALTER TABLE intake_job ADD COLUMN target_revision INTEGER;
ALTER TABLE intake_job ADD COLUMN edit_mode TEXT CHECK (edit_mode IN ('extend', 'replace'));
ALTER TABLE intake_job ADD COLUMN target_recipe_json TEXT CHECK (
  (target_recipe_id IS NULL AND target_revision IS NULL AND edit_mode IS NULL
    AND target_recipe_json IS NULL)
  OR
  (target_recipe_id IS NOT NULL AND target_revision IS NOT NULL
    AND edit_mode IS NOT NULL AND target_recipe_json IS NOT NULL)
);
