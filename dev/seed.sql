INSERT OR IGNORE INTO household (id, name) VALUES (1, 'Kehityskoti');

INSERT OR IGNORE INTO member (id, household_id, google_sub, display_name, email)
VALUES (1, 1, 'dev-member-1', 'Kehittäjä', 'dev@example.invalid');

INSERT OR IGNORE INTO ingredient (id, household_id, name, created_by)
VALUES (1, 1, 'spagetti', 1),
       (2, 1, 'jauheliha', 1),
       (3, 1, 'tomaattimurska', 1);

INSERT OR IGNORE INTO recipe (
  id, household_id, title, yield_portions, source_text, source_route,
  created_by, updated_by
) VALUES (
  1, 1, 'Spagetti ja jauhelihakastike', 4,
  '400 g spagettia\n400 g jauhelihaa\n400 g tomaattimurskaa',
  'pasted', 1, 1
);

INSERT OR IGNORE INTO ingredient_line (
  id, recipe_id, position, quantity, unit, ingredient_id, source_line
) VALUES
  (1, 1, 1, 400, 'g', 1, '400 g spagettia'),
  (2, 1, 2, 400, 'g', 2, '400 g jauhelihaa'),
  (3, 1, 3, 400, 'g', 3, '400 g tomaattimurskaa');

INSERT OR IGNORE INTO recipe_step (recipe_id, position, text)
VALUES (1, 1, 'Keitä spagetti.'),
       (1, 2, 'Ruskista jauheliha ja lisää tomaattimurska.');
