/**
 * Recipe parts stop at one level, at the write boundary (#258).
 *
 * These checks use the real migrations and save functions. The race check
 * reparents a recipe after the save's explanatory read but before its batch,
 * proving the mutation-time condition rather than only the preflight message.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { Member } from "../src/members.ts";
import {
  replaceRecipe,
  SaveRefused,
  saveRecipe,
  type LineToSave,
  type RecipeToSave,
} from "../src/recipe-save.ts";
import { shoppingLinesFor } from "../src/shopping.ts";
import { migratedDatabase, type FakeD1 } from "./support/d1.ts";

const MEMBER: Member = {
  id: 1,
  householdId: 1,
  displayName: "Eero",
  email: "eero@example.com",
  isAdmin: true,
};

function household(fake: FakeD1): void {
  fake.sql.exec(`
    INSERT INTO household (id, name) VALUES (1, 'Koti');
    INSERT INTO member (id, household_id, google_sub, email, display_name, is_admin)
      VALUES (1, 1, 'sub-1', 'eero@example.com', 'Eero', 1);
    INSERT INTO ingredient (id, name, created_by) VALUES
      (1, 'sipuli', 1),
      (2, 'tomaatti', 1);
  `);
}

function line(
  ingredientId: number,
  sourceLine: string,
  section: string | null,
  formIndex = 0,
  quantity = 1,
): LineToSave {
  return {
    quantity,
    quantityMax: null,
    unit: "kpl",
    altQuantity: null,
    altUnit: null,
    ingredient: { kind: "existing", id: ingredientId },
    sourceLine,
    section,
    phase: section === null ? "after_parts" : null,
    alternativeGroup: null,
    formIndex,
  };
}

function recipe(
  title: string,
  lines: LineToSave[],
  steps: RecipeToSave["steps"] = [],
): RecipeToSave {
  return {
    title,
    yieldPortions: 4,
    sourceText: title,
    sourceRoute: "pasted",
    structuredBy: null,
    lines,
    steps,
    categories: [],
  };
}

function row(fake: FakeD1, id: number): Record<string, unknown> {
  return fake.sql
    .prepare("SELECT title, parent_id, revision FROM recipe WHERE id = ?")
    .get(id) as Record<string, unknown>;
}

test("the common save boundary refuses a grandchild without changing the part", async () => {
  const fake = migratedDatabase();
  household(fake);

  const dishId = await saveRecipe(
    fake.db,
    MEMBER,
    recipe("Lasagne", [line(1, "1 sipuli", "Kastike")]),
  );
  const part = fake.sql
    .prepare("SELECT id FROM recipe WHERE parent_id = ?")
    .get(dishId) as { id: number };
  const before = row(fake, part.id);

  await assert.rejects(
    () =>
      replaceRecipe(
        fake.db,
        MEMBER,
        part.id,
        Number(before.revision),
        recipe("Kastike", [line(2, "1 tomaatti", "Sipulipohja")]),
      ),
    (error: unknown) => {
      assert.ok(error instanceof SaveRefused);
      assert.match(error.message, /osalle ei voi lisätä omia osia/);
      return true;
    },
  );

  assert.deepEqual(row(fake, part.id), before);
  assert.equal(
    (fake.sql
      .prepare("SELECT count(*) AS n FROM recipe WHERE parent_id = ?")
      .get(part.id) as { n: number }).n,
    0,
  );
  assert.equal(
    (fake.sql
      .prepare("SELECT ingredient_id FROM ingredient_line WHERE recipe_id = ?")
      .get(part.id) as { ingredient_id: number }).ingredient_id,
    1,
  );
});

test("reparenting between validation and mutation cannot create a grandchild", async () => {
  const fake = migratedDatabase();
  household(fake);

  const targetId = await saveRecipe(
    fake.db,
    MEMBER,
    recipe("Kastike", [line(1, "1 sipuli", null)]),
  );
  const newParentId = await saveRecipe(
    fake.db,
    MEMBER,
    recipe("Lasagne", [line(2, "1 tomaatti", null)]),
  );
  const before = row(fake, targetId);

  fake.beforeBatch(() => {
    fake.sql
      .prepare("UPDATE recipe SET parent_id = ?, part_position = 1 WHERE id = ?")
      .run(newParentId, targetId);
  });
  const nested = recipe(
    "Uusi kastike",
    [line(1, "1 valkosipuli", "Sipulipohja")],
  );
  nested.lines[0]!.ingredient = { kind: "new", name: "valkosipuli" };

  await assert.rejects(
    () =>
      replaceRecipe(
        fake.db,
        MEMBER,
        targetId,
        Number(before.revision),
        nested,
      ),
    (error: unknown) => {
      assert.ok(error instanceof SaveRefused);
      assert.match(error.message, /osalle ei voi lisätä omia osia/);
      return true;
    },
  );

  const after = row(fake, targetId);
  assert.equal(after.title, before.title);
  assert.equal(after.revision, before.revision);
  assert.equal(after.parent_id, newParentId);
  assert.equal(
    (fake.sql
      .prepare("SELECT count(*) AS n FROM recipe WHERE parent_id = ?")
      .get(targetId) as { n: number }).n,
    0,
  );
  assert.equal(
    (fake.sql
      .prepare("SELECT source_line FROM ingredient_line WHERE recipe_id = ?")
      .get(targetId) as { source_line: string }).source_line,
    "1 sipuli",
  );
  assert.equal(
    (fake.sql
      .prepare("SELECT count(*) AS n FROM ingredient WHERE name = 'valkosipuli'")
      .get() as { n: number }).n,
    0,
  );
});

test("top-level parts and a valid part edit still reach the shopping list intact", async () => {
  const fake = migratedDatabase();
  household(fake);

  const dishId = await saveRecipe(
    fake.db,
    MEMBER,
    recipe(
      "Lasagne",
      [
        line(1, "1 sipuli", "Kastike", 0),
        line(2, "1 tomaatti", null, 1),
      ],
      [
        {
          text: "Pilko sipuli.",
          section: "Kastike",
          phase: null,
          refs: [{ lineIndex: 0, expectedIngredientId: null, matchedText: "sipuli", approxPosition: 6 }],
        },
      ],
    ),
  );
  const part = fake.sql
    .prepare("SELECT id, revision FROM recipe WHERE parent_id = ?")
    .get(dishId) as { id: number; revision: number };

  await replaceRecipe(
    fake.db,
    MEMBER,
    part.id,
    part.revision,
    recipe(
      "Tomaattikastike",
      [line(1, "2 sipulia", null, 0, 2)],
      [
        {
          text: "Pilko sipuli tarkasti.",
          section: null,
          phase: null,
          refs: [{ lineIndex: 0, expectedIngredientId: 1, matchedText: "sipuli", approxPosition: 6 }],
        },
      ],
    ),
    { allowEmpty: true },
  );

  const stored = fake.sql
    .prepare(
      `SELECT recipe.title, ingredient_line.quantity, ingredient_line.source_line,
              recipe_step.text, recipe_step.ingredient_refs
         FROM recipe
         JOIN ingredient_line ON ingredient_line.recipe_id = recipe.id
         JOIN recipe_step ON recipe_step.recipe_id = recipe.id
        WHERE recipe.id = ?`,
    )
    .get(part.id) as {
      title: string;
      quantity: number;
      source_line: string;
      text: string;
      ingredient_refs: string;
    };
  assert.deepEqual(
    {
      title: stored.title,
      quantity: stored.quantity,
      sourceLine: stored.source_line,
      text: stored.text,
      refs: JSON.parse(stored.ingredient_refs),
    },
    {
      title: "Tomaattikastike",
      quantity: 2,
      sourceLine: "2 sipulia",
      text: "Pilko sipuli tarkasti.",
      refs: [{ ingredientId: 1, matchedText: "sipuli", approxPosition: 6 }],
    },
  );

  fake.sql
    .prepare(
      `INSERT INTO planned_batch
         (id, household_id, recipe_id, multiplier, created_by)
       VALUES (1, 1, ?, 1, 1)`,
    )
    .run(dishId);
  const shopping = await shoppingLinesFor(fake.db, MEMBER.householdId, [1]);
  assert.deepEqual(
    shopping.map((item) => ({
      ingredient: item.ingredientName,
      part: item.partTitle,
      quantity: item.quantity,
      source: item.sourceLine,
    })),
    [
      { ingredient: "tomaatti", part: null, quantity: 1, source: "1 tomaatti" },
      {
        ingredient: "sipuli",
        part: "Tomaattikastike",
        quantity: 2,
        source: "2 sipulia",
      },
    ],
  );
});
