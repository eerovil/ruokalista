-- Local development data. Never applied to the real database.
--
-- Two households on purpose: household 2 exists so that anything leaking across
-- the household_id filter shows up immediately in what household 1 can see.

DELETE FROM meal_entry;
DELETE FROM ingredient_line;
DELETE FROM recipe_step;
DELETE FROM recipe;
DELETE FROM ingredient;
DELETE FROM member;
DELETE FROM household;

INSERT INTO household (id, name) VALUES
  (1, 'Koti'),
  (2, 'Naapuri');

INSERT INTO member (id, household_id, google_sub, display_name, email) VALUES
  (1, 1, 'dev-seed-koti',    'Eero',   'eero@example.com'),
  (2, 2, 'dev-seed-naapuri', 'Naapuri', NULL);

INSERT INTO ingredient (id, household_id, name, created_by) VALUES
  (1, 1, 'öljy',           1),
  (2, 1, 'vesi',           1),
  (3, 1, 'valkokaali',     1),
  (4, 1, 'sitruunaruoho',  1),
  (5, 1, 'ananas',         1),  -- used by nothing, so its count must be 0
  (6, 2, 'naapurin suola', 2);  -- household 2, must never appear for member 1

INSERT INTO recipe
  (id, household_id, title, yield_portions, source_text, source_route, created_by, updated_by)
VALUES
  (1, 1, 'Kaalilaatikko', 4,
   'Kaalilaatikko' || char(10) || '½ dl öljyä' || char(10) || '1–1 ja ½ l vettä'
     || char(10) || '½ (500 g) valkokaali' || char(10) || 'hieman sitruunaruohoa',
   'pasted', 1, 1);

INSERT INTO recipe_step (recipe_id, position, text) VALUES
  (1, 1, 'Kuullota kaali öljyssä.'),
  (1, 2, 'Lisää vesi ja hauduta.');

-- One line of each awkward shape the schema exists to hold: a plain amount, a
-- range, a second measurement in another unit, and no amount at all.
INSERT INTO ingredient_line
  (recipe_id, position, quantity, quantity_max, unit, alt_quantity, alt_unit, ingredient_id, source_line)
VALUES
  (1, 1, 0.5, NULL, 'dl',  NULL, NULL, 1, '½ dl öljyä'),
  (1, 2, 1,   1.5,  'l',   NULL, NULL, 2, '1–1 ja ½ l vettä'),
  (1, 3, 0.5, NULL, 'kpl', 500,  'g',  3, '½ (500 g) valkokaali'),
  (1, 4, NULL, NULL, NULL, NULL, NULL, 4, 'hieman sitruunaruohoa');
