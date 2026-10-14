-- Which rows on the S-ostoslista this app created (#358).
--
-- The S-list service does not say who added a row, and the household asked for
-- one button that takes off everything Ruokalista put there. The service's row
-- id is the only exact handle: deleting by EAN would also take the household's
-- own row for the same product, and the service keeps one id per row for both
-- its own copy and the phone's.
--
-- A send writes an id here only for a row it created — one the list it read
-- first did not already hold. A row the household had added that a send merely
-- corrected stays theirs.
CREATE TABLE s_ostoslista_sent_item (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  sent_at TEXT NOT NULL
);

CREATE UNIQUE INDEX s_ostoslista_sent_item_unique
  ON s_ostoslista_sent_item(household_id, item_id);
