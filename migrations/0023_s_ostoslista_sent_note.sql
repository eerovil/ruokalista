-- What Ruokalista last sent one shopping row to the S-list as, in words.
--
-- An ingredient with no product chosen goes to the S-list as free text:
-- `juusto — 6 dl`. Choose a product for it later and the next send adds the
-- EAN product row — and, until #244, left the old text sitting beside it. In
-- the shop that reads as two different things to buy.
--
-- The S-list's delete is keyed by the exact note, and a note carries the
-- amount, so `juusto — 6 dl` and last week's `juusto — 4 dl` are two different
-- keys. Recomputing the key at send time therefore cannot find a note sent for
-- a different week's cooking. This table is that memory: the exact string this
-- app sent, kept until it has been taken off the list again.
--
-- Keyed by the shopping row rather than by the ingredient, because a dish
-- pinned to its own product is its own row (`12:r7` beside `12`, see
-- `shopping.ts::ShoppingItem.key`) and each may have sent its own note.
--
-- It records only what this app sent. A row the household typed on its phone
-- is never in here, and so is never deleted by a send — which is the whole
-- reason the note is remembered instead of guessed by name.
CREATE TABLE s_ostoslista_sent_note (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  row_key TEXT NOT NULL,
  note TEXT NOT NULL,
  sent_at TEXT NOT NULL
);

CREATE UNIQUE INDEX s_ostoslista_sent_note_unique
  ON s_ostoslista_sent_note(household_id, row_key);
