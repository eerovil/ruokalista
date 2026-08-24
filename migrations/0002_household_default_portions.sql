ALTER TABLE household
ADD COLUMN default_portions INTEGER NOT NULL DEFAULT 4 CHECK (default_portions > 0);
