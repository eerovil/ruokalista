CREATE TABLE household (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE member (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES household(id),
  google_sub    TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  email         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX member_by_household ON member(household_id);

CREATE TABLE ingredient (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES household(id),
  name          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    INTEGER NOT NULL REFERENCES member(id)
);
CREATE UNIQUE INDEX ingredient_name_per_household
  ON ingredient(household_id, name);

CREATE TABLE recipe (
  id                 INTEGER PRIMARY KEY,
  household_id       INTEGER NOT NULL REFERENCES household(id),
  title              TEXT NOT NULL,
  yield_portions     INTEGER,
  source_text        TEXT NOT NULL,
  source_route       TEXT NOT NULL CHECK (source_route IN ('pasted','photographed')),
  structured_by      TEXT,
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
  quantity       REAL,
  quantity_max   REAL,
  unit           TEXT,
  alt_quantity   REAL,
  alt_unit       TEXT,
  ingredient_id  INTEGER NOT NULL REFERENCES ingredient(id),
  source_line    TEXT NOT NULL,
  CHECK ((alt_quantity IS NULL) = (alt_unit IS NULL)),
  CHECK (alt_quantity IS NULL OR quantity IS NOT NULL)
);
CREATE UNIQUE INDEX ingredient_line_order ON ingredient_line(recipe_id, position);
CREATE INDEX ingredient_line_by_ingredient ON ingredient_line(ingredient_id);

CREATE TABLE meal_entry (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES household(id),
  date          TEXT NOT NULL,
  slot          TEXT NOT NULL CHECK (slot IN ('lunch','dinner')),
  recipe_id     INTEGER NOT NULL REFERENCES recipe(id),
  portions      INTEGER NOT NULL CHECK (portions > 0),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    INTEGER NOT NULL REFERENCES member(id)
);
CREATE INDEX meal_entry_by_date ON meal_entry(household_id, date, slot);
