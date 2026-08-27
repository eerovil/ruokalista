import assert from "node:assert/strict";
import test from "node:test";

import { AMOUNT_IN_RECIPE, shoppingList, type ShoppingLine } from "../src/shopping.ts";

/**
 * The shopping list's arithmetic, tested straight rather than through a
 * browser: the rules it has to keep are all about numbers, and the screen is
 * only how they are read.
 */

function line(overrides: Partial<ShoppingLine>): ShoppingLine {
  return {
    batchId: 1,
    batchTitle: "Kaalilaatikko",
    portions: 4,
    yieldPortions: 4,
    partTitle: null,
    ingredientId: 1,
    ingredientName: "öljy",
    ean: null,
    externalProductName: null,
    externalProductImageUrl: null,
    quantity: null,
    quantityMax: null,
    unit: null,
    altQuantity: null,
    altUnit: null,
    sourceLine: "",
    ...overrides,
  };
}

function totals(items: ReturnType<typeof shoppingList>): Record<string, string> {
  return Object.fromEntries(items.map((item) => [item.name, item.total]));
}

test("the same unit is summed across batches", () => {
  const items = shoppingList([
    line({ batchId: 1, quantity: 2, unit: "dl" }),
    line({ batchId: 2, batchTitle: "Lasagne", quantity: 3, unit: "dl" }),
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0]!.total, "5 dl");
  assert.equal(items[0]!.contributions.length, 2);
});

test("the canonical ingredient's external product follows its total", () => {
  const items = shoppingList([
    line({
      ingredientName: "maito",
      quantity: 5,
      unit: "dl",
      ean: "6415712506032",
      externalProductName: "Kotimaista rasvaton maito 1 l",
      externalProductImageUrl: "https://cdn.example/maito.jpg",
    }),
  ]);

  assert.equal(items[0]!.ean, "6415712506032");
  assert.equal(items[0]!.externalProductName, "Kotimaista rasvaton maito 1 l");
  assert.equal(items[0]!.externalProductImageUrl, "https://cdn.example/maito.jpg");
});

test("different units stay a plus expression rather than converting", () => {
  const items = shoppingList([
    line({ ingredientName: "maito", quantity: 5, unit: "dl" }),
    line({ batchId: 2, ingredientName: "maito", quantity: 2, unit: "rkl" }),
  ]);

  assert.equal(items[0]!.total, "5 dl + 2 rkl");
});

test("case and stray space are the same unit, nothing further is", () => {
  const items = shoppingList([
    line({ quantity: 1, unit: "dl" }),
    line({ quantity: 2, unit: " DL " }),
    line({ quantity: 3, unit: "ruokalusikka" }),
  ]);

  assert.equal(items[0]!.total, "3 dl + 3 ruokalusikka");
});

test("two lines of one ingredient inside one recipe join the same total", () => {
  const items = shoppingList([
    line({ quantity: 1, unit: "dl", sourceLine: "1 dl öljyä taikinaan" }),
    line({ quantity: 2, unit: "dl", sourceLine: "2 dl öljyä paistamiseen" }),
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0]!.total, "3 dl");
  assert.equal(items[0]!.contributions.length, 2);
});

test("a part's line is scaled by the dish's factor and named by its part", () => {
  const items = shoppingList([
    line({
      batchTitle: "Lasagne",
      yieldPortions: 6,
      portions: 12,
      partTitle: "Juustokastike",
      ingredientName: "maito",
      quantity: 5,
      unit: "dl",
    }),
  ]);

  assert.equal(items[0]!.total, "10 dl");
  assert.equal(items[0]!.contributions[0]!.partTitle, "Juustokastike");
  assert.equal(items[0]!.contributions[0]!.batchTitle, "Lasagne");
});

test("a dish with no stated yield is never scaled", () => {
  const items = shoppingList([
    line({ yieldPortions: null, portions: 12, quantity: 2, unit: "dl" }),
  ]);

  assert.equal(items[0]!.total, "2 dl");
});

test("the total is the sum of the rounded contributions, so it adds up", () => {
  // 5 dl at 4/3 rounds to 6½ dl on the recipe screen; two of them read 13 dl,
  // not the 13½ an exact sum would round to.
  const items = shoppingList([
    line({ yieldPortions: 3, portions: 4, quantity: 5, unit: "dl" }),
    line({ batchId: 2, yieldPortions: 3, portions: 4, quantity: 5, unit: "dl" }),
  ]);

  assert.equal(items[0]!.contributions[0]!.amount, "6½ dl");
  assert.equal(items[0]!.total, "13 dl");
});

test("a range keeps both ends and stays a range", () => {
  const items = shoppingList([
    line({ ingredientName: "vesi", quantity: 1, quantityMax: 1.5, unit: "l" }),
    line({ batchId: 2, ingredientName: "vesi", quantity: 1, unit: "l" }),
  ]);

  assert.equal(items[0]!.total, "2–2½ l");
});

test("a second measurement is shown but never counted twice", () => {
  const items = shoppingList([
    line({
      ingredientName: "valkokaali",
      quantity: 0.5,
      unit: "kpl",
      altQuantity: 500,
      altUnit: "g",
      sourceLine: "½ (500 g) valkokaali",
    }),
  ]);

  assert.equal(items[0]!.total, "½ kpl");
  assert.equal(items[0]!.contributions[0]!.amount, "½ kpl (500 g)");
});

test("a line with no stated amount stays on the list", () => {
  const items = shoppingList([
    line({ ingredientName: "sitruunaruoho", sourceLine: "hieman sitruunaruohoa" }),
  ]);

  assert.equal(items[0]!.total, AMOUNT_IN_RECIPE);
  assert.equal(items[0]!.hasUnstated, true);
  assert.equal(items[0]!.contributions[0]!.sourceLine, "hieman sitruunaruohoa");
});

test("a source line that only repeats the amount is left off", () => {
  const items = shoppingList([
    line({ ingredientName: "maito", quantity: 5, unit: "dl", sourceLine: "5 dl maitoa" }),
  ]);

  assert.equal(items[0]!.contributions[0]!.sourceLine, "");
});

test("a source line the scaling contradicted is kept", () => {
  const items = shoppingList([
    line({
      ingredientName: "maito",
      yieldPortions: 2,
      portions: 4,
      quantity: 5,
      unit: "dl",
      sourceLine: "5 dl maitoa",
    }),
  ]);

  assert.equal(items[0]!.contributions[0]!.amount, "10 dl");
  assert.equal(items[0]!.contributions[0]!.sourceLine, "5 dl maitoa");
});

test("an unstated amount is carried alongside a stated one, not swallowed", () => {
  const items = shoppingList([
    line({ quantity: 2, unit: "dl" }),
    line({ batchId: 2, sourceLine: "öljyä paistamiseen" }),
  ]);

  assert.equal(items[0]!.total, `2 dl + ${AMOUNT_IN_RECIPE}`);
  assert.equal(items[0]!.hasUnstated, true);
});

test("the list reads in Finnish alphabetical order", () => {
  const items = shoppingList([
    line({ ingredientId: 3, ingredientName: "öljy", quantity: 1, unit: "dl" }),
    line({ ingredientId: 2, ingredientName: "vesi", quantity: 1, unit: "l" }),
    line({ ingredientId: 1, ingredientName: "ananas", quantity: 1, unit: "kpl" }),
  ]);

  assert.deepEqual(Object.keys(totals(items)), ["ananas", "vesi", "öljy"]);
});

test("nothing selected is an empty list rather than a thrown error", () => {
  assert.deepEqual(shoppingList([]), []);
});
