-- A recipe DELETE and remembering its obsolete image keys must commit together
-- (#259). No recipe FK: this record deliberately outlives the deleted recipe.
CREATE TABLE recipe_image_cleanup (
  image_key       TEXT PRIMARY KEY NOT NULL CHECK (length(image_key) > 0),
  household_id    INTEGER NOT NULL REFERENCES household(id),
  queued_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  last_attempt_at TEXT
);

CREATE INDEX recipe_image_cleanup_by_attempt
  ON recipe_image_cleanup(coalesce(last_attempt_at, queued_at), image_key);

-- Cleanup asks whether anybody still references a key, not whether its former
-- owner does. This also protects references restored from a database snapshot.
CREATE INDEX recipe_by_image_key ON recipe(image_key) WHERE image_key IS NOT NULL;
