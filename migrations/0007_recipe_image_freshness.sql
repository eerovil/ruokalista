-- An image is bytes plus the question "is this still the dish?".
--
-- #89 stored the bytes and the key and nothing else, so nothing could tell a
-- picture that still matches its recipe from one taken before somebody swapped
-- the mince for lentils. These columns record what a *generated* picture was
-- made from, so `src/image-freshness.ts` can answer missing / fresh / stale
-- without a second guess.
--
-- image_origin is the only one that is not diagnostic. NULL means "we never
-- said", which every row #89 wrote is, and which reads as a manual upload —
-- the same as an explicit 'manual'. So no picture anybody uploaded by hand
-- becomes stale the moment this migration lands.

ALTER TABLE recipe ADD COLUMN image_origin TEXT
  CHECK (image_origin IS NULL OR image_origin IN ('manual', 'generated'));

-- The recipe fingerprint the generated picture was made from. Only ever set
-- alongside image_origin = 'generated'; a manual upload has nothing to compare.
ALTER TABLE recipe ADD COLUMN image_fingerprint TEXT;

-- Diagnostics: when it was generated, and by what.
ALTER TABLE recipe ADD COLUMN image_generated_at TEXT;
ALTER TABLE recipe ADD COLUMN image_generated_by TEXT;
