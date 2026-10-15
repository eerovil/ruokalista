-- A household can start a recipe's cooking count over (#366).
--
-- The count is read from the batches themselves, so a reset marks the ones
-- it has counted so far rather than deleting them: an old calendar batch and
-- its days stay as they were, and only stop counting.
ALTER TABLE planned_batch ADD COLUMN count_reset INTEGER NOT NULL DEFAULT 0
  CHECK (count_reset IN (0, 1));
