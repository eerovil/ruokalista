/**
 * A category cannot be removed out from under a save (#210).
 *
 * The vocabulary is a table an admin edits (#199), and every writer checks a
 * category exists before storing it. That check is a separate read, so it
 * leaves a window: remove the category in between, and a request already past
 * its check would store a slug nothing can filter by, nothing can clear, and no
 * screen will ever show as anything but itself.
 *
 * `0019_category_vocabulary.sql` closes it by giving `recipe_category.category`
 * a foreign key onto `category`, which moves the rule from just-before-the-write
 * to the write. These checks are what say so: each one removes the category in
 * exactly that window and then asks the database whether an orphan exists.
 *
 * A browser test cannot be aimed at a window this small, so this runs the real
 * write paths against a real SQLite database built from the real migrations
 * (`dev/support/d1.ts`), with a hook that fires between the validation and the
 * batch.
 *
 *   ./scripts/node.sh npm run check
 */

import assert from "node:assert/strict";
import test from "node:test";

import { loadVocabulary } from "../src/categories.ts";
import { deleteCategory } from "../src/category-admin.ts";
import {
  addCategoryToRecipes,
  CategoryBulkRefused,
} from "../src/category-bulk.ts";
import type { Member } from "../src/members.ts";
import { SaveRefused, saveRecipe, replaceRecipe } from "../src/recipe-save.ts";
import type { RecipeToSave } from "../src/recipe-save.ts";
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
    INSERT INTO ingredient (id, name, created_by) VALUES (1, 'kaali', 1);
  `);
}

function recipe(categories: string[], title = "Kaalikeitto"): RecipeToSave {
  return {
    title,
    yieldPortions: 4,
    sourceText: "Kaalia ja vettä.",
    sourceRoute: "pasted",
    structuredBy: null,
    steps: [{ text: "Keitä.", section: null, phase: null, refs: [] }],
    lines: [
      {
        quantity: 1,
        quantityMax: null,
        unit: "kpl",
        altQuantity: null,
        altUnit: null,
        ingredient: { kind: "existing", id: 1 },
        sourceLine: "1 kpl kaalia",
        section: null,
        phase: null,
        alternativeGroup: null,
        formIndex: 0,
      },
    ],
    categories,
  };
}

/** Every stored category, so an orphan is visible as itself. */
function storedCategories(fake: FakeD1): string[] {
  return (
    fake.sql
      .prepare("SELECT category FROM recipe_category ORDER BY category")
      .all() as Array<{ category: string }>
  ).map((row) => row.category);
}

/** Whichever stored categories the vocabulary no longer has. Should be none. */
function orphans(fake: FakeD1): string[] {
  return (
    fake.sql
      .prepare(
        `SELECT recipe_category.category
           FROM recipe_category
           LEFT JOIN category ON category.slug = recipe_category.category
          WHERE category.slug IS NULL`,
      )
      .all() as Array<{ category: string }>
  ).map((row) => row.category);
}

test("the vocabulary is the seeded nine, and a save stores one of them", async () => {
  const fake = migratedDatabase();
  household(fake);

  const vocabulary = await loadVocabulary(fake.db);
  assert.equal(vocabulary.categories.length, 9);
  assert.equal(vocabulary.has("keitto"), true);

  await saveRecipe(fake.db, MEMBER, recipe(["keitto"]));
  assert.deepEqual(storedCategories(fake), ["keitto"]);
  assert.deepEqual(orphans(fake), []);
});

test("a category removed between a save's check and its write leaves no orphan", async () => {
  const fake = migratedDatabase();
  household(fake);

  // The admin's removal lands in the one moment the race is about: after
  // saveRecipe has read the vocabulary and agreed 'keitto' exists, before the
  // batch that would have written it.
  fake.beforeBatch(() => {
    fake.sql.exec("DELETE FROM category WHERE slug = 'keitto'");
  });

  await assert.rejects(
    () => saveRecipe(fake.db, MEMBER, recipe(["keitto"])),
    SaveRefused,
  );

  assert.deepEqual(orphans(fake), []);
  assert.deepEqual(storedCategories(fake), []);
  // A D1 batch is one transaction, so the refusal took the whole recipe with
  // it. Half a recipe with no category would be the worse outcome, not a
  // better one.
  const saved = fake.sql.prepare("SELECT count(*) AS n FROM recipe").get() as {
    n: number;
  };
  assert.equal(saved.n, 0);
});

test("a category removed under an edit leaves the recipe exactly as it was", async () => {
  const fake = migratedDatabase();
  household(fake);

  const id = await saveRecipe(fake.db, MEMBER, recipe(["keitto"]));
  const before = fake.sql
    .prepare("SELECT title, revision FROM recipe WHERE id = ?")
    .get(id) as { title: string; revision: number };

  fake.beforeBatch(() => {
    fake.sql.exec("DELETE FROM recipe_category WHERE category = 'pasta'");
    fake.sql.exec("DELETE FROM category WHERE slug = 'pasta'");
  });

  await assert.rejects(
    () =>
      replaceRecipe(fake.db, MEMBER, id, before.revision, {
        ...recipe(["pasta"], "Kaalipata"),
      }),
    SaveRefused,
  );

  assert.deepEqual(orphans(fake), []);
  // Not merely no orphan: nothing about the recipe moved either. The edit's
  // first statement deletes the old categories, and a batch that half-ran would
  // have left the dish with none.
  assert.deepEqual(storedCategories(fake), ["keitto"]);
  const after = fake.sql
    .prepare("SELECT title, revision FROM recipe WHERE id = ?")
    .get(id) as { title: string; revision: number };
  assert.deepEqual(after, before);
});

test("a category removed under the bulk add leaves no orphan, and no recipe moved", async () => {
  const fake = migratedDatabase();
  household(fake);

  const first = await saveRecipe(fake.db, MEMBER, recipe([], "Kaalikeitto"));
  const second = await saveRecipe(fake.db, MEMBER, recipe([], "Kaalipata"));
  const vocabulary = await loadVocabulary(fake.db);

  fake.beforeBatch(() => {
    fake.sql.exec("DELETE FROM category WHERE slug = 'keitto'");
  });

  await assert.rejects(
    () => addCategoryToRecipes(fake.db, vocabulary, MEMBER, [first, second], "keitto"),
    CategoryBulkRefused,
  );

  assert.deepEqual(orphans(fake), []);
  assert.deepEqual(storedCategories(fake), []);
});

test("removing a category still detaches its recipes rather than being refused", async () => {
  const fake = migratedDatabase();
  household(fake);

  const id = await saveRecipe(fake.db, MEMBER, recipe(["keitto"]));

  // The new key has no ON DELETE action, so this only works because
  // deleteCategory detaches first, in the same batch. It is the order that
  // satisfies the constraint, and this is the check that says so.
  const affected = await deleteCategory(fake.db, "keitto");
  assert.equal(affected, 1);

  assert.deepEqual(storedCategories(fake), []);
  assert.deepEqual(orphans(fake), []);
  const still = fake.sql
    .prepare("SELECT count(*) AS n FROM recipe WHERE id = ?")
    .get(id) as { n: number };
  assert.equal(still.n, 1);
});

test("the database refuses an orphan slug even when no application code is involved", async () => {
  const fake = migratedDatabase();
  household(fake);
  const id = await saveRecipe(fake.db, MEMBER, recipe([]));

  assert.throws(() => {
    fake.sql
      .prepare("INSERT INTO recipe_category (recipe_id, category) VALUES (?, ?)")
      .run(id, "wellington");
  }, /FOREIGN KEY/);
});
