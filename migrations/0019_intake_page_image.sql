-- The picture a linked import found on the page it read (#205).
--
-- `image_refs` was not reused for this, and the schema is what said so: 0018's
-- table-level CHECK requires `image_refs IS NULL` on a linked job, because
-- those are the pages of a *photographed* import — the input the model reads,
-- deleted the moment a draft exists. What #205 stores is the opposite thing: a
-- photograph of the finished dish, wanted after the draft exists and handed to
-- the recipe at save. One column cannot honestly mean both.
--
-- Two ADD COLUMNs rather than a rebuild. The table-level CHECKs name
-- `source_route`, `source_text`, `source_url` and `image_refs` and would have
-- to be rewritten if this were part of them — but these columns are outside
-- every one of them, and `ALTER TABLE ADD COLUMN` takes a column's own CHECK.
-- That is the case docs/codebase/data-model.md says not to reach for the
-- rebuild sequence for.
--
-- Which route may carry a picture is left to `intake-jobs.ts`, not written as
-- a constraint: it is a rule about what the consumer does, and the two other
-- routes simply never write here.

ALTER TABLE intake_job ADD COLUMN page_image_key TEXT;

ALTER TABLE intake_job ADD COLUMN page_image_type TEXT
  CHECK (page_image_type IS NULL
         OR page_image_type IN ('image/jpeg', 'image/png', 'image/webp'));
