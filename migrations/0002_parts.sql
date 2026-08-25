-- A dish may be written in named parts: a lasagne is a jauhelihakastike and a
-- juustokastike, each with its own ingredients and its own method.
--
-- A part is not a new kind of thing — it is a recipe. See
-- docs/adr/0002-a-part-is-a-recipe.md.
--
-- Both columns are nullable, so every recipe that already exists stays valid
-- and unchanged: parent_id NULL means "this is a dish, not a part of one".

ALTER TABLE recipe ADD COLUMN parent_id INTEGER REFERENCES recipe(id);
ALTER TABLE recipe ADD COLUMN part_position INTEGER;

CREATE INDEX recipe_by_parent ON recipe(parent_id, part_position);
