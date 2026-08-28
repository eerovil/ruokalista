import assert from "node:assert/strict";
import test from "node:test";

import type { ProductChoice } from "../src/ingredient-products.ts";
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
    multiplier: 1,
    partTitle: null,
    recipeId: 1,
    ingredientId: 1,
    ingredientName: "öljy",
    products: [],
    override: null,
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

function product(
  ean: string,
  name: string,
  packageQuantity: number | null = null,
  packageUnit: string | null = null,
): ProductChoice {
  return {
    ean,
    name,
    imageUrl: `https://cdn.example/${ean}.jpg`,
    packageQuantity,
    packageUnit,
  };
}

/** `2 × 400 g` — what the row ends up telling somebody at the shelf. */
function bought(item: ReturnType<typeof shoppingList>[number]): string[] {
  return item.chosen.map(({ product: one, count }) => `${count} × ${one.name}`);
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
      products: [product("6415712506032", "Kotimaista rasvaton maito 1 l", 1, "l")],
    }),
  ]);

  assert.equal(items[0]!.chosen.length, 1);
  assert.equal(items[0]!.chosen[0]!.product.ean, "6415712506032");
  assert.equal(items[0]!.chosen[0]!.count, 1);
  assert.equal(items[0]!.chosen[0]!.product.name, "Kotimaista rasvaton maito 1 l");
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

test("a part's line takes the dish's multiplier and is named by its part", () => {
  const items = shoppingList([
    line({
      batchTitle: "Lasagne",
      multiplier: 2,
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

test("a dish that never stated a yield scales like any other (#165)", () => {
  const items = shoppingList([
    line({ multiplier: 2, quantity: 2, unit: "dl" }),
  ]);

  assert.equal(items[0]!.total, "4 dl");
});

test("half a batch buys half the ingredients", () => {
  const items = shoppingList([
    line({ multiplier: 0.5, quantity: 5, unit: "dl" }),
  ]);

  assert.equal(items[0]!.total, "2½ dl");
});

test("the total is the sum of the rounded contributions, so it adds up", () => {
  // 5 dl at 4/3 rounds to 6½ dl on the recipe screen; two of them read 13 dl,
  // not the 13½ an exact sum would round to.
  const items = shoppingList([
    line({ multiplier: 4 / 3, quantity: 5, unit: "dl" }),
    line({ batchId: 2, multiplier: 4 / 3, quantity: 5, unit: "dl" }),
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
      multiplier: 2,
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

// ------------------------------------------------------- packages and overrides

/**
 * #161's arithmetic, at the level it actually decides anything: the need is
 * added up first, and only then does the shop's packaging come into it.
 */

const MINCE_400 = product("mince-400", "Naudan jauheliha 400 g", 400, "g");
const MINCE_700 = product("mince-700", "Naudan jauheliha 700 g", 700, "g");

function mince(quantity: number, batchId = 1): ShoppingLine {
  return line({
    batchId,
    ingredientId: 7,
    ingredientName: "jauheliha",
    quantity,
    unit: "g",
    products: [MINCE_400, MINCE_700],
  });
}

test("one packet is enough when the need fits inside it", () => {
  assert.deepEqual(bought(shoppingList([mince(350)])[0]!), ["1 × Naudan jauheliha 400 g"]);
  assert.deepEqual(bought(shoppingList([mince(400)])[0]!), ["1 × Naudan jauheliha 400 g"]);
});

test("the smallest packet that covers the need wins over a bigger one", () => {
  assert.deepEqual(bought(shoppingList([mince(600)])[0]!), ["1 × Naudan jauheliha 700 g"]);
  assert.deepEqual(bought(shoppingList([mince(700)])[0]!), ["1 × Naudan jauheliha 700 g"]);
});

test("two small packets beat one big one when they waste less", () => {
  const item = shoppingList([mince(750)])[0]!;
  assert.deepEqual(bought(item), ["2 × Naudan jauheliha 400 g"]);
  assert.equal(item.packageTotal, "800 g");
});

test("a need is covered by a mixture of sizes when that lands exactly", () => {
  const item = shoppingList([mince(1100)])[0]!;
  assert.deepEqual(bought(item).sort(), [
    "1 × Naudan jauheliha 400 g",
    "1 × Naudan jauheliha 700 g",
  ]);
  assert.equal(item.packageTotal, "1,1 kg");
});

test("the generic need is summed across recipes before the packets are chosen", () => {
  // 450 g in one dish and 300 g in another is one 750 g need, not two.
  const item = shoppingList([mince(450, 1), mince(300, 2)])[0]!;
  assert.deepEqual(bought(item), ["2 × Naudan jauheliha 400 g"]);
});

test("the same rule solves a different ingredient in different units", () => {
  const item = shoppingList([
    line({
      ingredientName: "maito",
      quantity: 12,
      unit: "dl",
      products: [
        product("milk-1l", "Maito 1 l", 1, "l"),
        product("milk-05", "Maito 5 dl", 5, "dl"),
      ],
    }),
  ])[0]!;
  assert.deepEqual(bought(item), ["1 × Maito 1 l", "1 × Maito 5 dl"]);
  assert.equal(item.packageTotal, "1,5 l");
});

test("a ranged need is covered at its top, not its bottom", () => {
  const item = shoppingList([
    line({
      ingredientName: "jauheliha",
      quantity: 300,
      quantityMax: 500,
      unit: "g",
      products: [MINCE_400, MINCE_700],
    }),
  ])[0]!;
  assert.deepEqual(bought(item), ["1 × Naudan jauheliha 700 g"]);
});

test("an unknown package size never produces a count", () => {
  const item = shoppingList([
    line({
      ingredientName: "kana",
      quantity: 450,
      unit: "g",
      products: [product("chicken", "Kanan rintafileesuikale marinoitu")],
    }),
  ])[0]!;
  assert.deepEqual(bought(item), ["1 × Kanan rintafileesuikale marinoitu"]);
  assert.equal(item.packageTotal, null);
});

test("a need this app cannot convert is left alone rather than guessed", () => {
  const item = shoppingList([
    line({ ingredientName: "jauheliha", quantity: 400, unit: "g", products: [MINCE_400] }),
    line({
      batchId: 2,
      ingredientName: "jauheliha",
      quantity: 2,
      unit: "rkl",
      products: [MINCE_400],
    }),
  ])[0]!;
  assert.equal(item.total, "400 g + 2 rkl");
  assert.deepEqual(bought(item), ["1 × Naudan jauheliha 400 g"]);
  assert.equal(item.packageTotal, null);
});

test("a package in another family is not used to cover the need", () => {
  const item = shoppingList([
    line({
      ingredientName: "maito",
      quantity: 5,
      unit: "dl",
      products: [product("weird", "Maitojauhe 400 g", 400, "g")],
    }),
  ])[0]!;
  assert.equal(item.packageTotal, null);
  assert.deepEqual(bought(item), ["1 × Maitojauhe 400 g"]);
});

test("an ingredient nothing is mapped to still has a row, with nothing chosen", () => {
  const item = shoppingList([mince(400)].map((one) => ({ ...one, products: [] })))[0]!;
  assert.deepEqual(item.chosen, []);
  assert.equal(item.total, "400 g");
});

const CHICKEN_MARINATED = product("chicken-c", "Marinoitu kanasuikale 400 g", 400, "g");
const CHICKEN_PLAIN = product("chicken-a", "Kanasuikale 500 g", 500, "g");

test("a recipe's own product is its own row and keeps its own amount", () => {
  const items = shoppingList([
    line({
      batchId: 1,
      batchTitle: "Kanapasta",
      recipeId: 11,
      ingredientId: 12,
      ingredientName: "kanasuikale",
      quantity: 450,
      unit: "g",
      products: [CHICKEN_PLAIN],
      override: CHICKEN_MARINATED,
    }),
    line({
      batchId: 2,
      batchTitle: "Kanacurry",
      recipeId: 12,
      ingredientId: 12,
      ingredientName: "kanasuikale",
      quantity: 300,
      unit: "g",
      products: [CHICKEN_PLAIN],
    }),
  ]);

  assert.equal(items.length, 2);
  const pinned = items.find((item) => item.recipeId === 11)!;
  const generic = items.find((item) => item.recipeId === null)!;

  // 450 g and 300 g are never added into one 750 g need: doing so would either
  // buy the curry a marinated packet or lose the pasta the one it asked for.
  assert.equal(pinned.total, "450 g");
  assert.equal(pinned.recipeTitle, "Kanapasta");
  assert.deepEqual(bought(pinned), ["2 × Marinoitu kanasuikale 400 g"]);
  assert.equal(generic.total, "300 g");
  assert.deepEqual(bought(generic), ["1 × Kanasuikale 500 g"]);
});

test("a recipe's own product beats the ingredient's defaults for that recipe", () => {
  const item = shoppingList([
    line({
      recipeId: 11,
      ingredientName: "kanasuikale",
      quantity: 400,
      unit: "g",
      products: [CHICKEN_PLAIN, MINCE_700],
      override: CHICKEN_MARINATED,
    }),
  ])[0]!;

  assert.deepEqual(item.products, [CHICKEN_MARINATED]);
  assert.deepEqual(bought(item), ["1 × Marinoitu kanasuikale 400 g"]);
});

test("two batches of one pinned recipe share its row and its packets", () => {
  const pinnedLine = (batchId: number) =>
    line({
      batchId,
      batchTitle: "Kanapasta",
      recipeId: 11,
      ingredientName: "kanasuikale",
      quantity: 400,
      unit: "g",
      products: [CHICKEN_PLAIN],
      override: CHICKEN_MARINATED,
    });

  const items = shoppingList([pinnedLine(1), pinnedLine(2)]);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.total, "800 g");
  assert.deepEqual(bought(items[0]!), ["2 × Marinoitu kanasuikale 400 g"]);
});
