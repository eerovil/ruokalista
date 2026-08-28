-- A recipe can stay private, be shared with selected households, or be public.
-- Public remains recipe.published_at; selected recipients live here so the
-- existing public state and its timestamps keep their meaning.
CREATE TABLE recipe_share (
  recipe_id INTEGER NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
  household_id INTEGER NOT NULL REFERENCES household(id),
  shared_at TEXT NOT NULL DEFAULT (datetime('now')),
  shared_by INTEGER NOT NULL REFERENCES member(id),
  PRIMARY KEY (recipe_id, household_id)
);

-- Recipient lists ask the inverse question: what has been shared to this
-- household? The primary key already covers owner-side recipient management.
CREATE INDEX recipe_share_household ON recipe_share(household_id, recipe_id);
