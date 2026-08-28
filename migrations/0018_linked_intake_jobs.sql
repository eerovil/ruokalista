-- A web address is a third kind of background import (#192).
--
-- `intake_job` was written in 0017 for the two routes that existed then. A
-- linked import is a third: what is persisted at the start is the address, not
-- the text, because the page is fetched by the queue consumer rather than by
-- the request that started the job. Fetching in the request is exactly what
-- #186 moved away from — a slow site would hold a request open, and a browser
-- that navigated away would lose the import.
--
-- `source_text` is therefore nullable for a linked job until the consumer has
-- read the page, and is filled in once it has. That is what lets a retry after
-- a *model* failure reuse the text already read rather than fetching the site
-- again, and what lets a failed linked job show the text it did manage to read.
--
-- This rebuilds the table rather than swapping a column. `source_route`'s own
-- CHECK would come away with a DROP COLUMN, but the two table-level CHECKs
-- below name `source_route` as well, and those cannot be altered away. Nothing
-- references `intake_job`, so the rebuild is the plain sequence and not the one
-- docs/codebase/data-model.md warns about — no child carries rows away with a
-- DROP, and no REFERENCES clause elsewhere follows the rename.

CREATE TABLE intake_job_next (
  id TEXT PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  created_by INTEGER NOT NULL REFERENCES member(id),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'ready', 'failed')),
  lease_id TEXT,
  source_route TEXT NOT NULL CHECK (source_route IN ('pasted', 'photographed', 'linked')),
  source_text TEXT,
  source_url TEXT,
  image_refs TEXT,
  draft_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (source_route = 'pasted'
      AND source_text IS NOT NULL AND source_url IS NULL AND image_refs IS NULL)
    OR
    (source_route = 'photographed'
      AND source_text IS NULL AND source_url IS NULL AND image_refs IS NOT NULL)
    OR
    (source_route = 'linked'
      AND source_url IS NOT NULL AND image_refs IS NULL)
  ),
  CHECK (status != 'ready' OR draft_json IS NOT NULL),
  CHECK (status != 'failed' OR error_message IS NOT NULL),
  CHECK (
    (status = 'running' AND lease_id IS NOT NULL)
    OR (status != 'running' AND lease_id IS NULL)
  )
);

-- Imports already in flight keep going. They are all pasted or photographed,
-- so every one of them satisfies the widened constraint unchanged.
INSERT INTO intake_job_next
  (id, household_id, created_by, status, lease_id, source_route, source_text,
   image_refs, draft_json, error_message, created_at, updated_at)
SELECT
  id, household_id, created_by, status, lease_id, source_route, source_text,
  image_refs, draft_json, error_message, created_at, updated_at
FROM intake_job;

DROP TABLE intake_job;

ALTER TABLE intake_job_next RENAME TO intake_job;

CREATE INDEX intake_job_household_updated
  ON intake_job(household_id, updated_at DESC);
