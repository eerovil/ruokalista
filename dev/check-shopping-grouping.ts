import assert from "node:assert/strict";
import test from "node:test";

import {
  SHARED_GROUP_TITLE,
  groupByRecipe,
  shoppingList,
  type ShoppingLine,
} from "../src/shopping.ts";

/**
 * Cutting the shopping list into one section per dish (#318).
 *
 * The rows are the same rows the flat list draws — this only decides which
 * section each one lands in and in what order the sections come. So what is
 * worth testing straight is exactly that: nothing is lost, nothing is drawn
 * twice, a row several dishes want is its own pile, and the sections follow
 * the week rather than the rows. The screen around it is checked in
 * `tests/shopping.spec.ts`.
 */

function line(overrides: Partial<ShoppingLine>): ShoppingLine {
  return {
    batchId: 1,
    batchTitle: "Kanapasta",
    multiplier: 1,
    partTitle: null,
    recipeId: 1,
    sourceRecipeId: 1,
    alternativeGroup: null,
    phase: null,
    ingredientId: 1,
    ingredientName: "öljy",
    products: [],
    override: null,
    quantity: 1,
    quantityMax: null,
    unit: "dl",
    altQuantity: null,
    altUnit: null,
    sourceLine: "1 dl öljyä",
    ...overrides,
  };
}

/** Two dishes: one shares its oil with the other, the rest are its own. */
function twoDishes(): ReturnType<typeof shoppingList> {
  return shoppingList([
    line({ batchId: 1, batchTitle: "Kanapasta", recipeId: 1, ingredientId: 1 }),
    line({
      batchId: 1,
      batchTitle: "Kanapasta",
      recipeId: 1,
      ingredientId: 2,
      ingredientName: "pasta",
    }),
    line({ batchId: 2, batchTitle: "Lasagne", recipeId: 2, ingredientId: 1 }),
    line({
      batchId: 2,
      batchTitle: "Lasagne",
      recipeId: 2,
      ingredientId: 3,
      ingredientName: "jauheliha",
    }),
  ]);
}

function shape(groups: ReturnType<typeof groupByRecipe>) {
  return groups.map((group) => [
    group.title,
    group.items.map((item) => item.name),
  ]);
}

test("a row one dish wants goes under that dish, a shared one on its own", () => {
  const groups = groupByRecipe(twoDishes(), [1, 2]);

  assert.deepEqual(shape(groups), [
    ["Kanapasta", ["pasta"]],
    ["Lasagne", ["jauheliha"]],
    [SHARED_GROUP_TITLE, ["öljy"]],
  ]);
});

test("every row is drawn exactly once, whatever the grouping", () => {
  const items = twoDishes();
  const drawn = groupByRecipe(items, [1, 2]).flatMap((group) =>
    group.items.map((item) => item.key),
  );

  assert.deepEqual([...drawn].sort(), items.map((item) => item.key).sort());
  assert.equal(new Set(drawn).size, drawn.length);
});

test("the sections come in the order the week does", () => {
  const groups = groupByRecipe(twoDishes(), [2, 1]);

  assert.deepEqual(
    groups.map((group) => group.title),
    ["Lasagne", "Kanapasta", SHARED_GROUP_TITLE],
  );
});

test("the same dish cooked twice is still one section", () => {
  const items = shoppingList([
    line({ batchId: 1, batchTitle: "Kanapasta", recipeId: 1, ingredientId: 2,
      ingredientName: "pasta" }),
    line({ batchId: 2, batchTitle: "Kanapasta", recipeId: 1, ingredientId: 2,
      ingredientName: "pasta" }),
  ]);

  assert.deepEqual(shape(groupByRecipe(items, [1, 1])), [
    ["Kanapasta", ["pasta"]],
  ]);
});

test("a dish the order never names keeps its section rather than its rows", () => {
  // The order comes from the selected cookings and the rows come from the same
  // selection, so this should not happen — but dropping a section here would
  // drop its rows off the list, which is the one outcome worth ruling out.
  // With nothing to order them by they fall back to the order the rows first
  // mentioned them, which is the list's own: jauheliha before pasta.
  const groups = groupByRecipe(twoDishes(), []);

  assert.deepEqual(shape(groups), [
    ["Lasagne", ["jauheliha"]],
    ["Kanapasta", ["pasta"]],
    [SHARED_GROUP_TITLE, ["öljy"]],
  ]);
});

test("nothing shared means no shared section at all", () => {
  const items = shoppingList([
    line({ batchId: 1, batchTitle: "Kanapasta", recipeId: 1, ingredientId: 2,
      ingredientName: "pasta" }),
  ]);

  assert.deepEqual(shape(groupByRecipe(items, [1])), [["Kanapasta", ["pasta"]]]);
});

test("an empty list has no sections", () => {
  assert.deepEqual(groupByRecipe([], [1, 2]), []);
});
