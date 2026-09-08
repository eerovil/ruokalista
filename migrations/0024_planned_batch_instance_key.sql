-- `planned_batch.id` is a SQLite rowid alias, so deleting the highest batch
-- lets a later insert reuse its id. Keep that compact internal id for the
-- occurrence foreign key, and give each concrete batch a non-reused identity
-- for update/delete preconditions (#255).
ALTER TABLE planned_batch ADD COLUMN instance_key TEXT;

UPDATE planned_batch
   SET instance_key = lower(hex(randomblob(16)));

CREATE UNIQUE INDEX planned_batch_by_instance_key
  ON planned_batch(instance_key);

-- SQLite cannot add a non-constant generated default or a NOT NULL column to
-- existing rows in one ALTER. These triggers make the additive migration as
-- strict as a rebuilt table would have been, without risking the occurrences
-- that cascade from this parent.
CREATE TRIGGER planned_batch_instance_key_required
BEFORE INSERT ON planned_batch
WHEN NEW.instance_key IS NULL OR trim(NEW.instance_key) = ''
BEGIN
  SELECT RAISE(ABORT, 'planned_batch.instance_key is required');
END;

CREATE TRIGGER planned_batch_instance_key_immutable
BEFORE UPDATE OF instance_key ON planned_batch
WHEN NEW.instance_key IS NOT OLD.instance_key
BEGIN
  SELECT RAISE(ABORT, 'planned_batch.instance_key is immutable');
END;
