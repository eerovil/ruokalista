-- Optional member guidance for structuring a recipe fetched from a web page
-- (#219). It belongs to the queued job rather than the saved recipe: the model
-- reads it once, while source_text remains the page's own durable source.
--
-- A column addition is enough. The existing route checks do not name this
-- field, and intake-jobs.ts is the narrow gate that only writes it for linked
-- imports.

ALTER TABLE intake_job ADD COLUMN import_guidance TEXT
  CHECK (import_guidance IS NULL OR length(import_guidance) <= 2000);
