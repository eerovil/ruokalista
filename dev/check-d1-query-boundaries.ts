import assert from "node:assert/strict";
import test from "node:test";

import { categoriesForRecipes, loadVocabulary } from "../src/categories.ts";
import {
  addCategoryToRecipes,
  CategoryBulkRefused,
} from "../src/category-bulk.ts";
import { MAX_D1_BOUND_PARAMETERS } from "../src/d1-query.ts";
import {
  overridesForRecipes,
  productsForIngredients,
} from "../src/ingredient-products.ts";
import { preferredMultipliers } from "../src/recipe-preference.ts";
import { ownedDishes, publishRecipes } from "../src/recipe-publish.ts";
import {
  plannableRecipeSummaries,
  publicRecipeSummaries,
  recipeSummaries,
} from "../src/recipes.ts";
import { shoppingLinesFor, shoppingList } from "../src/shopping.ts";
import { migratedDatabase, type FakeD1 } from "./support/d1.ts";

const OWN_RECIPES = 350;
const PUBLIC_RECIPES = 110;
const SELECTED_RECIPES = 110;
const PRIVATE_RECIPES = 5;
const SHOPPING_ROWS = 205;

function insertFixtures(database: FakeD1): {
  ownIds: number[];
  sharedIds: number[];
  ingredientIds: number[];
  batchIds: number[];
  foreignBatchId: number;
} {
  const { sql } = database;
  sql.exec(`
    INSERT INTO household (id, name) VALUES (1, 'Koti'), (2, 'Naapuri');
    INSERT INTO member (id, household_id, google_sub, display_name)
      VALUES (1, 1, 'koti', 'Eero'), (2, 2, 'naapuri', 'Naapuri');
  `);

  const recipe = sql.prepare(`
    INSERT INTO recipe
      (id, household_id, title, source_text, source_route, created_by, updated_by,
       published_at)
    VALUES (?, ?, ?, '', 'pasted', ?, ?, ?)
  `);
  const category = sql.prepare(
    "INSERT INTO recipe_category (recipe_id, category) VALUES (?, ?)",
  );
  const preference = sql.prepare(`
    INSERT INTO recipe_preference
      (household_id, recipe_id, default_multiplier, updated_by)
    VALUES (1, ?, ?, 1)
  `);
  const share = sql.prepare(
    "INSERT INTO recipe_share (recipe_id, household_id, shared_by) VALUES (?, 1, 2)",
  );

  const ownIds: number[] = [];
  const sharedIds: number[] = [];
  sql.exec("BEGIN");
  try {
    for (let index = 1; index <= OWN_RECIPES; index += 1) {
      const id = index;
      const group = index <= 100
        ? "ExactlyA"
        : index <= 201
          ? "ExactlyB"
          : "Several";
      ownIds.push(id);
      recipe.run(id, 1, `${group} ${String(index).padStart(3, "0")}`, 1, 1, null);
      preference.run(id, 1 + index / 1000);
      if (index % 50 === 0) {
        category.run(id, "lisuke");
        category.run(id, "pasta");
      }
    }

    let nextId = 1001;
    for (let index = 0; index < PUBLIC_RECIPES; index += 1) {
      const id = nextId++;
      sharedIds.push(id);
      recipe.run(id, 2, `Public ${String(index).padStart(3, "0")}`, 2, 2, "2026-09-08");
      preference.run(id, 2);
      if ((index + 1) % 55 === 0) {
        category.run(id, "lisuke");
        category.run(id, "pasta");
      }
    }
    for (let index = 0; index < SELECTED_RECIPES; index += 1) {
      const id = nextId++;
      sharedIds.push(id);
      recipe.run(id, 2, `Selected ${String(index).padStart(3, "0")}`, 2, 2, null);
      share.run(id);
      preference.run(id, 3);
      if ((index + 1) % 55 === 0) {
        category.run(id, "lisuke");
        category.run(id, "pasta");
      }
    }
    for (let index = 0; index < PRIVATE_RECIPES; index += 1) {
      recipe.run(nextId++, 2, `Private ${String(index).padStart(3, "0")}`, 2, 2, null);
    }
    sql.exec("COMMIT");
  } catch (error) {
    sql.exec("ROLLBACK");
    throw error;
  }

  const ingredient = sql.prepare(
    "INSERT INTO ingredient (id, name, created_by) VALUES (?, ?, 1)",
  );
  const line = sql.prepare(`
    INSERT INTO ingredient_line
      (recipe_id, position, quantity, unit, ingredient_id, source_line)
    VALUES (?, 1, 1, 'g', ?, ?)
  `);
  const product = sql.prepare(`
    INSERT INTO ingredient_product
      (ingredient_id, ean, name, package_quantity, package_unit, position)
    VALUES (?, ?, ?, 100, 'g', 1)
  `);
  const override = sql.prepare(`
    INSERT INTO recipe_ingredient_product
      (household_id, recipe_id, ingredient_id, ean, name,
       package_quantity, package_unit)
    VALUES (1, ?, ?, ?, ?, 200, 'g')
  `);
  const batch = sql.prepare(`
    INSERT INTO planned_batch
      (id, household_id, recipe_id, multiplier, created_by, instance_key)
    VALUES (?, ?, ?, 1, ?, ?)
  `);

  const ingredientIds: number[] = [];
  const batchIds: number[] = [];
  sql.exec("BEGIN");
  try {
    for (let index = 1; index <= SHOPPING_ROWS; index += 1) {
      const ingredientId = index;
      const recipeId = ownIds[index - 1]!;
      const batchId = 2000 + index;
      const suffix = String(index).padStart(3, "0");
      ingredientIds.push(ingredientId);
      batchIds.push(batchId);
      ingredient.run(ingredientId, `Ingredient ${suffix}`);
      line.run(recipeId, ingredientId, `1 g ingredient ${suffix}`);
      product.run(ingredientId, `product-${suffix}`, `Product ${suffix}`);
      override.run(
        recipeId,
        ingredientId,
        `override-${suffix}`,
        `Override ${suffix}`,
      );
      batch.run(batchId, 1, recipeId, 1, `batch-${batchId}`);
    }
    sql.exec("COMMIT");
  } catch (error) {
    sql.exec("ROLLBACK");
    throw error;
  }

  const foreignBatchId = 9999;
  batch.run(foreignBatchId, 2, sharedIds[0]!, 2, `batch-${foreignBatchId}`);
  return { ownIds, sharedIds, ingredientIds, batchIds, foreignBatchId };
}

test("catalogs and picker load several hundred recipes within D1's bind limit", async () => {
  const database = migratedDatabase();
  const { ownIds, sharedIds } = insertFixtures(database);

  assert.equal((await recipeSummaries(database.db, 1, "ExactlyA")).length, 100);
  assert.equal((await recipeSummaries(database.db, 1, "ExactlyB")).length, 101);
  const own = await recipeSummaries(database.db, 1, "");
  assert.equal(own.length, OWN_RECIPES);
  assert.deepEqual(
    own.find((item) => item.id === 50)?.categories,
    ["pasta", "lisuke"],
  );

  const shared = await publicRecipeSummaries(database.db, 1, "");
  assert.equal(shared.length, PUBLIC_RECIPES + SELECTED_RECIPES);
  assert.ok(shared.some((item) => item.title.startsWith("Public")));
  assert.ok(shared.some((item) => item.title.startsWith("Selected")));
  assert.ok(shared.every((item) => !item.title.startsWith("Private")));
  assert.equal(shared.filter((item) => item.categories.length > 0).length, 4);
  assert.deepEqual(
    shared.find((item) => item.id === sharedIds.at(-1))?.categories,
    ["pasta", "lisuke"],
  );

  assert.equal(
    (await plannableRecipeSummaries(database.db, 1, "ExactlyA")).length,
    100,
  );
  assert.equal(
    (await plannableRecipeSummaries(database.db, 1, "ExactlyB")).length,
    101,
  );
  const queriesBeforePicker = database.bindingCounts.length;
  const plannable = await plannableRecipeSummaries(database.db, 1, "");
  assert.equal(plannable.length, ownIds.length + sharedIds.length);
  assert.ok(database.bindingCounts.length - queriesBeforePicker <= 10);
  assert.deepEqual(
    plannable.slice(0, ownIds.length).map((item) => item.householdId),
    Array(ownIds.length).fill(1),
  );

  const multipliers = await preferredMultipliers(
    database.db,
    1,
    [...ownIds, ...sharedIds, ownIds[0]!, sharedIds[0]!],
  );
  assert.equal(multipliers.size, ownIds.length + sharedIds.length);
  assert.equal(multipliers.get(sharedIds[0]!), 2);
  assert.ok(database.bindingCounts.every((count) => count <= MAX_D1_BOUND_PARAMETERS));
});

test("large category and publication mutations keep their existing batch contracts", async () => {
  const database = migratedDatabase();
  const { ownIds } = insertFixtures(database);
  const vocabulary = await loadVocabulary(database.db);
  const member = {
    id: 1,
    householdId: 1,
    displayName: "Eero",
    email: null,
    isAdmin: false,
  };

  const queriesBeforeCategory = database.bindingCounts.length;
  const categorised = await addCategoryToRecipes(
    database.db,
    vocabulary,
    member,
    ownIds,
    "keitto",
  );
  assert.equal(categorised.changed.length, OWN_RECIPES);
  assert.equal(
    database.bindingCounts.length - queriesBeforeCategory,
    OWN_RECIPES + 8,
  );
  assert.equal(
    (database.sql.prepare(
      "SELECT count(*) AS n FROM recipe_category WHERE category = 'keitto'",
    ).get() as { n: number }).n,
    OWN_RECIPES,
  );

  database.beforeBatch(() => {
    database.sql.exec(`
      DELETE FROM recipe_category WHERE category = 'pasta';
      DELETE FROM category WHERE slug = 'pasta';
    `);
  });
  await assert.rejects(
    () => addCategoryToRecipes(database.db, vocabulary, member, ownIds, "pasta"),
    CategoryBulkRefused,
  );
  assert.equal(
    (database.sql.prepare(
      "SELECT count(*) AS n FROM recipe_category WHERE category = 'pasta'",
    ).get() as { n: number }).n,
    0,
  );

  const queriesBeforePublish = database.bindingCounts.length;
  const published = await publishRecipes(database.db, member, ownIds);
  assert.equal(published.changed.length, OWN_RECIPES);
  assert.equal(
    database.bindingCounts.length - queriesBeforePublish,
    OWN_RECIPES * 2 + 4,
  );
  assert.equal(
    (database.sql.prepare(
      "SELECT count(*) AS n FROM recipe WHERE household_id = 1 AND published_at IS NOT NULL",
    ).get() as { n: number }).n,
    OWN_RECIPES,
  );
  assert.ok(database.bindingCounts.every((count) => count <= MAX_D1_BOUND_PARAMETERS));
});

test("bounded mapping reads preserve empty, duplicate, ordering, and tenant behavior", async () => {
  const database = migratedDatabase();
  const { ownIds, ingredientIds } = insertFixtures(database);

  assert.deepEqual(await categoriesForRecipes(database.db, []), new Map());
  assert.deepEqual(
    await categoriesForRecipes(database.db, [ownIds[49]!, ownIds[49]!]),
    new Map([[ownIds[49]!, ["pasta", "lisuke"]]]),
  );

  const dishes = await ownedDishes(
    database.db,
    1,
    [...ownIds.toReversed(), ownIds[0]!, 1001],
  );
  assert.equal(dishes.length, ownIds.length);
  assert.equal(dishes[0]?.title, "ExactlyA 001");
  assert.equal(dishes.at(-1)?.title, "Several 350");

  const products = await productsForIngredients(
    database.db,
    [...ingredientIds, ingredientIds[0]!, ingredientIds[100]!],
  );
  assert.equal(products.size, SHOPPING_ROWS);
  assert.equal(products.get(ingredientIds[100]!)?.[0]?.name, "Product 101");

  const overrides = await overridesForRecipes(database.db, 1, ownIds);
  assert.equal(overrides.size, SHOPPING_ROWS);
  assert.equal(overrides.get(`${ownIds[100]}:${ingredientIds[100]}`)?.name, "Override 101");
  assert.ok(database.bindingCounts.includes(MAX_D1_BOUND_PARAMETERS));
  assert.ok(database.bindingCounts.every((count) => count <= MAX_D1_BOUND_PARAMETERS));
});

test("shopping keeps every line, product, override, total, and fixed-bind boundary", async () => {
  const database = migratedDatabase();
  const { batchIds, foreignBatchId } = insertFixtures(database);

  const atBoundary = await shoppingLinesFor(database.db, 1, batchIds.slice(0, 99));
  assert.equal(atBoundary.length, 99);

  const acrossBoundary = await shoppingLinesFor(database.db, 1, batchIds.slice(0, 100));
  assert.equal(acrossBoundary.length, 100);

  const queriesBeforeAll = database.bindingCounts.length;
  const all = await shoppingLinesFor(
    database.db,
    1,
    [...batchIds.toReversed(), foreignBatchId, batchIds[0]!, batchIds[100]!],
  );
  assert.equal(all.length, SHOPPING_ROWS);
  assert.ok(database.bindingCounts.length - queriesBeforeAll <= 9);
  assert.deepEqual(all.map((line) => line.batchId), batchIds);
  assert.ok(all.every((line) => line.products.length === 1));
  assert.ok(all.every((line) => line.override !== null));

  const totals = shoppingList(all);
  assert.equal(totals.length, SHOPPING_ROWS);
  assert.ok(totals.every((item) => item.total === "1 g"));
  assert.ok(database.bindingCounts.includes(MAX_D1_BOUND_PARAMETERS));
  assert.ok(database.bindingCounts.every((count) => count <= MAX_D1_BOUND_PARAMETERS));
});
