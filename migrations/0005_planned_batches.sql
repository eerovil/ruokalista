CREATE TABLE planned_batch (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES household(id),
  recipe_id     INTEGER NOT NULL REFERENCES recipe(id),
  portions      INTEGER NOT NULL CHECK (portions > 0),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    INTEGER NOT NULL REFERENCES member(id)
);

CREATE INDEX planned_batch_by_household
  ON planned_batch(household_id, id);

CREATE TABLE batch_occurrence (
  batch_id      INTEGER NOT NULL REFERENCES planned_batch(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,
  slot          TEXT NOT NULL CHECK (slot IN ('lunch','dinner')),
  PRIMARY KEY (batch_id, date, slot)
);

CREATE INDEX batch_occurrence_by_date
  ON batch_occurrence(date, slot, batch_id);

-- Every existing planned food is the smallest possible batch: one occurrence.
INSERT INTO planned_batch
  (id, household_id, recipe_id, portions, created_at, created_by)
SELECT id, household_id, recipe_id, portions, created_at, created_by
  FROM meal_entry;

INSERT INTO batch_occurrence (batch_id, date, slot)
SELECT id, date, slot FROM meal_entry;

DROP INDEX meal_entry_by_date;
DROP TABLE meal_entry;
