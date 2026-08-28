-- A recipe may arrive from a web address (#192).
--
-- Two things change on `recipe`. It gains `source_url`, the address a recipe
-- was read from, kept so a household can go back to where the dish came from.
-- And `source_route` gains a third word, `linked`, so how a recipe arrived is
-- still recorded truthfully rather than a fetched page pretending to be a paste.
--
-- Wayfinder decision #4 ruled URL import out; #192 reverses that half of it.
-- See docs/adr/0011-a-web-address-is-a-third-way-in.md.
--
-- No table is rebuilt. `recipe` is the parent of several ON DELETE CASCADE
-- children and is referenced by four more tables, so a drop-and-recreate is
-- exactly the sequence docs/codebase/data-model.md warns about. It is not
-- needed: `source_route`'s CHECK is the column's own, so DROP COLUMN carries it
-- away, and RENAME COLUMN rewrites the replacement's CHECK to follow the name.

ALTER TABLE recipe ADD COLUMN source_url TEXT;

-- The default is only what the copy below overwrites a moment later; every
-- existing row keeps the route it already had.
ALTER TABLE recipe
  ADD COLUMN source_route_next TEXT NOT NULL DEFAULT 'pasted'
    CHECK (source_route_next IN ('pasted', 'photographed', 'linked'));

UPDATE recipe SET source_route_next = source_route;

ALTER TABLE recipe DROP COLUMN source_route;
ALTER TABLE recipe RENAME COLUMN source_route_next TO source_route;
