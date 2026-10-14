-- One import may carry text, web addresses and photographs at once (#350).
--
-- Until now an import had exactly one source: photographs won over an address
-- and an address over pasted text, and the table's route CHECK said so — a
-- photographed job could hold no text and no address. The new add screen has
-- one box (a name, a link or a whole recipe, links anywhere in it) and the
-- photo buttons beside it, and everything given is material for one recipe.
--
-- So two things change:
--
-- * `source_text` is now always what the member typed, on every route, and a
--   photographed job may carry it and an address too. `source_route` still
--   names the main way in, because `recipe.source_route` keeps its three
--   values: photographs, else a link, else text.
-- * The pages read from the links get a column of their own, `link_reads`: a
--   JSON array of `{url, text}` or `{url, failure}`, one per address, written
--   by the queue consumer before the model runs. Before this the one page's
--   text was written over `source_text`, which only worked while a linked job
--   had nothing typed. A non-null `link_reads` means the links were read, so a
--   retry after a model failure does not read the sites again.
--
-- The route CHECK names `source_route`, so this is a rebuild rather than a
-- column swap. Nothing references `intake_job` (it is the child of `recipe`,
-- `household` and `member`, never a parent), so the plain sequence is safe —
-- no cascade takes rows with the DROP and no REFERENCES clause follows the
-- rename. 0018 is the same rebuild for the same reason.

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
  page_image_key TEXT,
  page_image_type TEXT
    CHECK (page_image_type IS NULL
           OR page_image_type IN ('image/jpeg', 'image/png', 'image/webp')),
  target_recipe_id INTEGER REFERENCES recipe(id) ON DELETE CASCADE,
  target_revision INTEGER,
  edit_mode TEXT CHECK (edit_mode IN ('extend', 'replace')),
  target_recipe_json TEXT CHECK (
    (target_recipe_id IS NULL AND target_revision IS NULL AND edit_mode IS NULL
      AND target_recipe_json IS NULL)
    OR
    (target_recipe_id IS NOT NULL AND target_revision IS NOT NULL
      AND edit_mode IS NOT NULL AND target_recipe_json IS NOT NULL)
  ),
  import_guidance TEXT
    CHECK (import_guidance IS NULL OR length(import_guidance) <= 2000),
  link_reads TEXT CHECK (link_reads IS NULL OR json_valid(link_reads)),
  CHECK (
    (source_route = 'pasted'
      AND source_text IS NOT NULL AND source_url IS NULL AND image_refs IS NULL)
    OR
    (source_route = 'photographed' AND image_refs IS NOT NULL)
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

-- A linked job that has already been read holds the page's text in
-- `source_text`. It moves to `link_reads`, so `source_text` means "what the
-- member typed" on every row and the job is not read again on retry.
INSERT INTO intake_job_next
  (id, household_id, created_by, status, lease_id, source_route, source_text,
   source_url, image_refs, draft_json, error_message, created_at, updated_at,
   page_image_key, page_image_type, target_recipe_id, target_revision,
   edit_mode, target_recipe_json, import_guidance, link_reads)
SELECT
  id, household_id, created_by, status, lease_id, source_route,
  CASE WHEN source_route = 'linked' THEN NULL ELSE source_text END,
  source_url, image_refs, draft_json, error_message, created_at, updated_at,
  page_image_key, page_image_type, target_recipe_id, target_revision,
  edit_mode, target_recipe_json, import_guidance,
  CASE
    WHEN source_route = 'linked' AND source_text IS NOT NULL
      THEN json_array(json_object('url', source_url, 'text', source_text))
    ELSE NULL
  END
FROM intake_job;

DROP TABLE intake_job;

ALTER TABLE intake_job_next RENAME TO intake_job;

CREATE INDEX intake_job_household_updated
  ON intake_job(household_id, updated_at DESC);
