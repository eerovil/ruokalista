import assert from "node:assert/strict";
import test from "node:test";

import { editRecipe, recipeEditSnapshot } from "../src/recipe-edit.ts";
import type { Member } from "../src/members.ts";
import {
  saveRecipe,
  StaleRecipe,
  type LineToSave,
  type RecipeToSave,
} from "../src/recipe-save.ts";
import { findRecipe } from "../src/recipes.ts";
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
  section: string | null = null,
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
    phase: null,
    alternativeGroup: null,
    formIndex: 0,
  };
}

function recipe(
  title: string,
  lines: LineToSave[],
  categories: string[] = [],
): RecipeToSave {
  return {
    title,
    yieldPortions: 4,
    sourceText: "Alkuperäinen lähdeteksti",
    sourceRoute: "linked",
    sourceUrl: "https://example.com/original",
    structuredBy: "fixture-model",
    lines,
    steps: [],
    categories,
  };
}

async function loaded(fake: FakeD1, id: number) {
  const found = await findRecipe(fake.db, MEMBER.householdId, id);
  assert.ok(found);
  return found;
}

test("edit intent cannot replace immutable source fields and may create a first part", async () => {
  const fake = migratedDatabase();
  household(fake);
  const id = await saveRecipe(fake.db, MEMBER, recipe("Pata", [line(1, "1 sipuli")]));
  const before = await loaded(fake, id);

  await editRecipe(
    fake.db,
    MEMBER,
    recipeEditSnapshot(before),
    {
      title: "Pata kastikkeella",
      yieldPortions: 4,
      lines: [line(2, "2 tomaattia", "Kastike", 2)],
      steps: [],
      categories: [],
    },
  );

  const after = await loaded(fake, id);
  assert.equal(after.title, "Pata kastikkeella");
  assert.equal(after.sourceText, "Alkuperäinen lähdeteksti");
  assert.equal(after.sourceRoute, "linked");
  assert.equal(after.sourceUrl, "https://example.com/original");
  assert.equal(after.parts.length, 1);
  assert.equal(after.parts[0]?.title, "Kastike");
  assert.equal(after.parts[0]?.sourceText, "Alkuperäinen lähdeteksti");
  assert.equal(after.parts[0]?.sourceRoute, "linked");
  assert.equal(after.parts[0]?.sourceUrl, "https://example.com/original");
});

test("a stale dish snapshot refuses without overwriting the newer edit", async () => {
  const fake = migratedDatabase();
  household(fake);
  const id = await saveRecipe(fake.db, MEMBER, recipe("Pata", [line(1, "1 sipuli")]));
  const snapshot = recipeEditSnapshot(await loaded(fake, id));

  fake.sql.prepare(
    "UPDATE recipe SET title = 'Toinen muutos', revision = revision + 1 WHERE id = ?",
  ).run(id);

  await assert.rejects(
    () => editRecipe(fake.db, MEMBER, snapshot, {
      title: "Vanha ehdotus",
      yieldPortions: 4,
      lines: [line(2, "1 tomaatti")],
      steps: [],
      categories: [],
    }),
    StaleRecipe,
  );

  assert.equal((await loaded(fake, id)).title, "Toinen muutos");
});

test("a stale part snapshot refuses the whole dish edit", async () => {
  const fake = migratedDatabase();
  household(fake);
  const id = await saveRecipe(
    fake.db,
    MEMBER,
    recipe("Lasagne", [line(1, "1 sipuli", "Kastike")]),
  );
  const snapshot = recipeEditSnapshot(await loaded(fake, id));
  const partId = snapshot.parts[0]!.id;

  fake.sql.prepare(
    "UPDATE recipe SET revision = revision + 1 WHERE id = ?",
  ).run(partId);

  await assert.rejects(
    () => editRecipe(fake.db, MEMBER, snapshot, {
      title: "Lasagne muutettuna",
      yieldPortions: 4,
      lines: [line(2, "2 tomaattia", "Kastike", 2)],
      steps: [],
      categories: [],
    }),
    (error: unknown) => {
      assert.ok(error instanceof StaleRecipe);
      assert.match(error.message, /osa on muuttunut tai poistettu/);
      return true;
    },
  );

  assert.equal((await loaded(fake, id)).title, "Lasagne");
});

test("a category change is part of the same optimistic-lock contract", async () => {
  const fake = migratedDatabase();
  household(fake);
  const categories = fake.sql
    .prepare("SELECT slug FROM category ORDER BY position, slug LIMIT 2")
    .all() as Array<{ slug: string }>;
  assert.equal(categories.length, 2, "migrations should seed at least two categories");
  const first = categories[0]!.slug;
  const second = categories[1]!.slug;

  const id = await saveRecipe(
    fake.db,
    MEMBER,
    recipe("Pata", [line(1, "1 sipuli")], [first]),
  );
  const snapshot = recipeEditSnapshot(await loaded(fake, id));

  // Bulk category editing changes recipe_category directly and intentionally
  // does not advance recipe.revision. The edit snapshot must still catch it.
  fake.sql.prepare(
    "INSERT INTO recipe_category (recipe_id, category) VALUES (?, ?)",
  ).run(id, second);

  await assert.rejects(
    () => editRecipe(fake.db, MEMBER, snapshot, {
      title: "Vanha ehdotus",
      yieldPortions: 4,
      lines: [line(2, "1 tomaatti")],
      steps: [],
      categories: [first],
    }),
    (error: unknown) => {
      assert.ok(error instanceof StaleRecipe);
      assert.match(error.message, /kategoriat ovat muuttuneet/);
      return true;
    },
  );

  const after = await loaded(fake, id);
  assert.equal(after.title, "Pata");
  assert.deepEqual(new Set(after.categories), new Set([first, second]));
});

test("the editor may deliberately keep an empty quick-saved recipe empty", async () => {
  const fake = migratedDatabase();
  household(fake);
  const id = await saveRecipe(
    fake.db,
    MEMBER,
    recipe("Muistissa oleva ruoka", []),
    { allowEmpty: true },
  );
  const snapshot = recipeEditSnapshot(await loaded(fake, id));

  await editRecipe(
    fake.db,
    MEMBER,
    snapshot,
    {
      title: "Muistissa oleva ruoka",
      yieldPortions: null,
      lines: [],
      steps: [],
      categories: [],
    },
    { allowEmpty: true },
  );

  assert.equal((await loaded(fake, id)).revision, snapshot.revision + 1);
});
