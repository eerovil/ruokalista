-- One preferred S-group product for each canonical global ingredient (#147).
-- The integration is intentionally used by one configured household, so this
-- remains a detail of the ingredient rather than a household/provider table.
ALTER TABLE ingredient ADD COLUMN ean TEXT;
ALTER TABLE ingredient ADD COLUMN external_product_name TEXT;
ALTER TABLE ingredient ADD COLUMN external_product_image_url TEXT;
