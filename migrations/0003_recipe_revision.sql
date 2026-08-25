-- Optimistic editing. A form carries the revision it opened; saving increments
-- it only when that same revision is still current, so an older editor cannot
-- silently replace a newer edit.
--
-- edit_token identifies the one batch that won that revision update. Its child
-- deletes and inserts are conditional on the token, so seeing the same numeric
-- revision from somebody else's completed edit is never enough to rewrite it.
--
-- The defaults keep existing rows and the old Worker valid while a deploy is
-- between its migration and code steps.

ALTER TABLE recipe ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recipe ADD COLUMN edit_token TEXT;
