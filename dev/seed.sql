-- Local development data. Never applied to the real database.
--
-- Two households on purpose: household 2 exists so that anything leaking across
-- the household_id filter shows up immediately in what household 1 can see.

DELETE FROM batch_occurrence;
DELETE FROM planned_batch;
DELETE FROM ingredient_line;
DELETE FROM recipe_step;
DELETE FROM recipe;
DELETE FROM ingredient;
DELETE FROM member;
DELETE FROM household;

INSERT INTO household (id, name) VALUES
  (1, 'Koti'),
  (2, 'Naapuri');

-- Member 1 is the ordinary member almost every test signs in as: not an admin,
-- so anything that quietly stopped refusing shows up as a screen it can suddenly
-- reach. Member 3 is the household's admin, and exists only so the gate has both
-- sides to be proved against.
INSERT INTO member (id, household_id, google_sub, display_name, email, is_admin) VALUES
  (1, 1, 'dev-seed-koti',    'Eero',        'eero@example.com', 0),
  (2, 2, 'dev-seed-naapuri', 'Naapuri',     NULL,               0),
  (3, 1, 'dev-seed-admin',   'Ylläpitäjä',  NULL,               1);

INSERT INTO ingredient (id, household_id, name, created_by) VALUES
  (1, 1, 'öljy',           1),
  (2, 1, 'vesi',           1),
  (3, 1, 'valkokaali',     1),
  (4, 1, 'sitruunaruoho',  1),
  (5, 1, 'ananas',         1),  -- used by nothing, so its count must be 0
  (6, 2, 'naapurin suola', 2),  -- household 2, must never appear for member 1
  (7, 1, 'jauheliha',      1),
  (8, 1, 'juusto',         1),
  (9, 1, 'maito',          1),
  (10, 1, 'lasagnelevy',   1);

INSERT INTO recipe
  (id, household_id, title, yield_portions, source_text, source_route, created_by, updated_by)
VALUES
  (1, 1, 'Kaalilaatikko', 4,
   'Kaalilaatikko' || char(10) || '½ dl öljyä' || char(10) || '1–1 ja ½ l vettä'
     || char(10) || '½ (500 g) valkokaali' || char(10) || 'hieman sitruunaruohoa',
   'pasted', 1, 1);

-- No yield_portions: the source never said, so the screen has to admit the
-- recipe cannot be scaled rather than hide it.
INSERT INTO recipe
  (id, household_id, title, yield_portions, source_text, source_route, created_by, updated_by)
VALUES
  (2, 1, 'Öljykastike', NULL,
   'Öljykastike' || char(10) || 'öljyä' || char(10) || 'vettä',
   'photographed', 1, 1);

-- A dish written in named parts: the lasagne itself, plus one recipe per part.
-- See docs/adr/0002-a-part-is-a-recipe.md.
INSERT INTO recipe
  (id, household_id, title, yield_portions, source_text, source_route,
   created_by, updated_by, parent_id, part_position)
VALUES
  (3, 1, 'Lasagne', 6,
   'Lasagne' || char(10) || 'Jauhelihakastike' || char(10) || '400 g jauhelihaa'
     || char(10) || 'Juustokastike' || char(10) || '5 dl maitoa'
     || char(10) || '2 dl juustoa',
   'pasted', 1, 1, NULL, NULL),
  (4, 1, 'Jauhelihakastike', NULL,
   'Lasagne', 'pasted', 1, 1, 3, 1),
  (5, 1, 'Juustokastike', NULL,
   'Lasagne', 'pasted', 1, 1, 3, 2);

INSERT INTO recipe_step (recipe_id, position, text, phase) VALUES
  (1, 1, 'Kuullota kaali öljyssä.', NULL),
  (1, 2, 'Lisää vesi ja hauduta.', NULL),
  (2, 1, 'Sekoita.', NULL),
  -- A legacy parent step remains explicitly unclassified and keeps its old
  -- parent-first position after the phase migration.
  (3, 1, 'Voitele vuoka.', NULL),
  (3, 2, 'Lämmitä uuni 200 asteeseen.', 'before_parts'),
  (3, 3, 'Kokoa vuokaan ja paista 40 minuuttia.', 'after_parts'),
  (4, 1, 'Ruskista jauheliha.', NULL),
  (5, 1, 'Kuumenna maito ja sulata juusto joukkoon.', NULL);

-- One line of each awkward shape the schema exists to hold: a plain amount, a
-- range, a second measurement in another unit, and no amount at all.
INSERT INTO ingredient_line
  (recipe_id, position, quantity, quantity_max, unit, alt_quantity, alt_unit, ingredient_id, source_line, phase)
VALUES
  (1, 1, 0.5, NULL, 'dl',  NULL, NULL, 1, '½ dl öljyä', NULL),
  (1, 2, 1,   1.5,  'l',   NULL, NULL, 2, '1–1 ja ½ l vettä', NULL),
  (1, 3, 0.5, NULL, 'kpl', 500,  'g',  3, '½ (500 g) valkokaali', NULL),
  (1, 4, NULL, NULL, NULL, NULL, NULL, 4, 'hieman sitruunaruohoa', NULL),
  (2, 1, NULL, NULL, NULL, NULL, NULL, 1, 'öljyä', NULL),
  (2, 2, NULL, NULL, NULL, NULL, NULL, 2, 'vettä', NULL),
  (3, 1, 12,  NULL, 'kpl', NULL, NULL, 10, '12 lasagnelevyä', 'after_parts'),
  (4, 1, 400, NULL, 'g',  NULL, NULL, 7, '400 g jauhelihaa', NULL),
  (5, 1, 5,   NULL, 'dl', NULL, NULL, 9, '5 dl maitoa', NULL),
  (5, 2, 2,   NULL, 'dl', NULL, NULL, 8, '2 dl juustoa', NULL);
