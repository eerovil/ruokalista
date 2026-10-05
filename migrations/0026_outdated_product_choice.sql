-- A saved product the shop no longer knows (#333).
--
-- A product choice is an EAN saved once and sent with every list after. When
-- the S-group catalogue retires that code, or it was an in-store code from
-- another shop, the S-list service can no longer turn it into a product and
-- the row reaches the phone as bare digits. The service now says so when an
-- add lands (`productFound: false`), and this column is where that answer is
-- kept: the moment it was heard, so the shopping screen can ask for a new
-- pick. Choosing the product again, or another one, clears it.
--
-- Both tables, because the EAN a send used came from one or the other: the
-- ingredient's own product or a dish's override of it.
ALTER TABLE ingredient_product ADD COLUMN outdated_at TEXT;
ALTER TABLE recipe_ingredient_product ADD COLUMN outdated_at TEXT;
