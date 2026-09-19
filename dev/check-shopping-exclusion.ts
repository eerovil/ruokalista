import assert from "node:assert/strict";
import test from "node:test";

import {
  isRowKey,
  shoppingList,
  splitByExcluded,
  type ShoppingLine,
} from "../src/shopping.ts";
import type { ProductChoice } from "../src/ingredient-products.ts";

/**
 * Leaving a row off one shopping list (#313).
 *
 * The whole mechanism is a set of row keys, so what is worth testing straight
 * is exactly two things: that a key picks out the row it names and no other,
 * and that a key from a query string cannot be anything but a key. The screen
 * around it is checked in `tests/shopping.spec.ts`.
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

function product(ean: string, name: string): ProductChoice {
  return {
    ean,
    name,
    imageUrl: `https://cdn.example/${ean}.jpg`,
    packageQuantity: null,
    packageUnit: null,
  };
}

function names(items: ReturnType<typeof shoppingList>): string[] {
  return items.map((item) => item.key);
}

test("an excluded key takes its row off the buy list and keeps it whole", () => {
  const items = shoppingList([
    line({ ingredientId: 1, ingredientName: "öljy" }),
    line({ ingredientId: 2, ingredientName: "suola" }),
  ]);

  const { buy, excluded } = splitByExcluded(items, new Set(["2"]));

  assert.deepEqual(names(buy), ["1"]);
  assert.deepEqual(names(excluded), ["2"]);
  // The row is moved, not thinned out: the total and the breakdown that
  // explains it are the same ones the buy list would have shown.
  assert.equal(excluded[0]!.name, "suola");
  assert.equal(excluded[0]!.total, "1 dl");
  assert.equal(excluded[0]!.contributions.length, 1);
});

test("nothing excluded leaves the list exactly as it was", () => {
  const items = shoppingList([line({ ingredientId: 1 }), line({ ingredientId: 2 })]);

  const { buy, excluded } = splitByExcluded(items, new Set());

  assert.deepEqual(buy, items);
  assert.deepEqual(excluded, []);
});

test("a key for no row on this list changes nothing", () => {
  const items = shoppingList([line({ ingredientId: 1 })]);

  const { buy, excluded } = splitByExcluded(items, new Set(["999", "1:r4"]));

  assert.deepEqual(names(buy), ["1"]);
  assert.deepEqual(excluded, []);
});

test("a pinned row is excluded on its own, not with the generic pile", () => {
  // The same ingredient in two dishes, one of which insists on its own
  // product: `shoppingList` gives that dish its own row (#161), and leaving
  // one off must not take the other with it.
  const items = shoppingList([
    line({
      batchId: 1,
      batchTitle: "Kanapasta",
      recipeId: 1,
      ingredientId: 7,
      ingredientName: "kana",
      override: product("111", "Marinoitu kanafile 400 g"),
    }),
    line({
      batchId: 2,
      batchTitle: "Kanacurry",
      recipeId: 2,
      ingredientId: 7,
      ingredientName: "kana",
    }),
  ]);
  assert.deepEqual(names(items).sort(), ["7", "7:r1"]);

  const { buy, excluded } = splitByExcluded(items, new Set(["7:r1"]));

  assert.deepEqual(names(buy), ["7"]);
  assert.deepEqual(names(excluded), ["7:r1"]);
});

test("only a real row key shape is accepted from a query string", () => {
  for (const good of ["1", "12", "12:r7"]) {
    assert.equal(isRowKey(good), true, good);
  }
  for (const bad of [
    "",
    " 12",
    "12 ",
    "12:",
    "12:r",
    "12:7",
    "12:rr7",
    "-1",
    "1.5",
    "12:r7:r8",
    "<script>",
    "öljy",
  ]) {
    assert.equal(isRowKey(bad), false, bad);
  }
});
