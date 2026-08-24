-- The v1 schema, exactly as docs/spec.md specifies it.
--
-- Conventions: ids are INTEGER PRIMARY KEY (SQLite rowid aliases). Timestamps
-- are ISO 8601 text in UTC. Dates are YYYY-MM-DD text, compared as strings.
-- Every table holding household data carries household_id, and every query
-- filters on it.

CREATE TABLE household (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE member (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES household(id),
  google_sub    TEXT NOT NULL UNIQUE,   -- Google's stable account id, not email
  display_name  TEXT NOT NULL,
  email         TEXT,                   -- shown, never used to match
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX member_by_household ON member(household_id);

CREATE TABLE ingredient (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES household(id),
  name          TEXT NOT NULL,          -- as the household approved it
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    INTEGER NOT NULL REFERENCES member(id)
);
CREATE UNIQUE INDEX ingredient_name_per_household
  ON ingredient(household_id, name);

CREATE TABLE recipe (
  id                 INTEGER PRIMARY KEY,
  household_id       INTEGER NOT NULL REFERENCES household(id),
  title              TEXT NOT NULL,
  yield_portions     INTEGER,           -- NULL when the source did not say
  source_text        TEXT NOT NULL,     -- kept forever, exactly as it arrived
  source_route       TEXT NOT NULL CHECK (source_route IN ('pasted','photographed')),
  structured_by      TEXT,              -- model id that produced the first draft
  structured_at      TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  created_by         INTEGER NOT NULL REFERENCES member(id),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by         INTEGER NOT NULL REFERENCES member(id)
);
CREATE INDEX recipe_by_household ON recipe(household_id, title);

CREATE TABLE recipe_step (
  recipe_id  INTEGER NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  text       TEXT NOT NULL,
  PRIMARY KEY (recipe_id, position)
);

CREATE TABLE ingredient_line (
  id             INTEGER PRIMARY KEY,
  recipe_id      INTEGER NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  quantity       REAL,                  -- NULL when absent or unrepresentable
  quantity_max   REAL,                  -- set only for a range; NULL otherwise
  unit           TEXT,                  -- as written: dl, rkl, tl, kpl, g
  alt_quantity   REAL,                  -- a second measurement of the same item
  alt_unit       TEXT,                  -- in a different unit; both or neither
  ingredient_id  INTEGER NOT NULL REFERENCES ingredient(id),
  source_line    TEXT NOT NULL,         -- the sentence it was written as

  -- a second measurement is both halves or neither, and never stands alone
  CHECK ((alt_quantity IS NULL) = (alt_unit IS NULL)),
  CHECK (alt_quantity IS NULL OR quantity IS NOT NULL)
);
CREATE UNIQUE INDEX ingredient_line_order ON ingredient_line(recipe_id, position);
CREATE INDEX ingredient_line_by_ingredient ON ingredient_line(ingredient_id);

CREATE TABLE meal_entry (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES household(id),
  date          TEXT NOT NULL,          -- YYYY-MM-DD
  slot          TEXT NOT NULL CHECK (slot IN ('lunch','dinner')),
  recipe_id     INTEGER NOT NULL REFERENCES recipe(id),
  portions      INTEGER NOT NULL CHECK (portions > 0),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    INTEGER NOT NULL REFERENCES member(id)
);
CREATE INDEX meal_entry_by_date ON meal_entry(household_id, date, slot);
