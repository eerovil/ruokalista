-- The kitchen cupboard: which ingredients the household already has (#125).
--
-- A row means "we keep this in, treat it as enough" — salt, pepper, oregano,
-- oil. No row means nothing is known about the ingredient, so nothing is
-- assumed and it is bought as normal. Running out is a delete.
--
-- `state` is a word rather than a boolean on purpose. v1 only ever writes
-- 'unlimited', but counted inventory — 6 kpl of eggs against the 10 a week
-- needs — is a second state and its two columns, not a different table.
CREATE TABLE pantry_entry (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES household(id),
  ingredient_id INTEGER NOT NULL REFERENCES ingredient(id) ON DELETE CASCADE,
  state         TEXT NOT NULL CHECK (state IN ('unlimited', 'quantity')),
  quantity      REAL,
  quantity_unit TEXT,
  added_at      TEXT NOT NULL DEFAULT (datetime('now')),
  added_by      INTEGER NOT NULL REFERENCES member(id),
  -- An amount belongs to the counted state and to no other: a row claiming
  -- 'unlimited' and 6 kpl at once would be two answers to one question.
  CHECK ((state = 'quantity') = (quantity IS NOT NULL)),
  CHECK (quantity IS NULL OR quantity >= 0),
  -- One entry per ingredient per household, which is also the lookup the
  -- shopping list makes.
  UNIQUE (household_id, ingredient_id)
);
