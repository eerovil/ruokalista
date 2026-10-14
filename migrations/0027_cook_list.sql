-- The dish to-do list replaces the meal calendar (#345).
--
-- A dish on the list is still one cooking, so it is still a planned batch —
-- one with no occurrences, because the list has no days. Ticking it as cooked
-- writes the day here and takes it off the list, and that day is what the
-- recipe's cooking history counts from.
--
-- The calendar's own batches keep their occurrences and leave this NULL. They
-- are no longer shown or written, and still count in the history by the day
-- they were planned on, as they always did.
ALTER TABLE planned_batch ADD COLUMN cooked_on TEXT
  CHECK (cooked_on IS NULL
         OR cooked_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');

CREATE INDEX planned_batch_by_cooked
  ON planned_batch(household_id, cooked_on, id);
