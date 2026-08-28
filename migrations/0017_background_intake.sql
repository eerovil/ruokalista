-- A model-backed import outlives the browser request that started it (#186).
-- The queue carries only this id; the source, status and validated result stay
-- household-scoped in D1 until the recipe is saved.
CREATE TABLE intake_job (
  id TEXT PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  created_by INTEGER NOT NULL REFERENCES member(id),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'ready', 'failed')),
  lease_id TEXT,
  source_route TEXT NOT NULL CHECK (source_route IN ('pasted', 'photographed')),
  source_text TEXT,
  image_refs TEXT,
  draft_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (source_route = 'pasted' AND source_text IS NOT NULL AND image_refs IS NULL)
    OR
    (source_route = 'photographed' AND source_text IS NULL AND image_refs IS NOT NULL)
  ),
  CHECK (status != 'ready' OR draft_json IS NOT NULL),
  CHECK (status != 'failed' OR error_message IS NOT NULL),
  CHECK (
    (status = 'running' AND lease_id IS NOT NULL)
    OR (status != 'running' AND lease_id IS NULL)
  )
);

CREATE INDEX intake_job_household_updated
  ON intake_job(household_id, updated_at DESC);
