import assert from "node:assert/strict";
import test from "node:test";

import { splitByPantry } from "../src/pantry.ts";
import type { ShoppingItem } from "../src/shopping.ts";

/**
 * What the cupboard does to a shopping list, tested without a browser or a
 * database: the rule is a set membership test over ids, and everything that
 * could go wrong with it is visible here.
 */

function item(ingredientId: number, name: string, total: string): ShoppingItem {
  return {
    ingredientId,
    name,
    total,
    hasUnstated: false,
    contributions: [
      {
        batchId: 1,
        batchTitle: "Lasagne",
        partTitle: null,
        amount: total,
        sourceLine: "",
      },
    ],
  };
}

const SALT = item(1, "suola", "2 tl");
const MINCE = item(2, "jauheliha", "400 g");
const OIL = item(3, "öljy", "1 dl");

test("an ingredient the household keeps in moves to the other section", () => {
  const { buy, atHome } = splitByPantry([SALT, MINCE, OIL], new Set([1, 3]));

  assert.deepEqual(buy.map((one) => one.name), ["jauheliha"]);
  assert.deepEqual(atHome.map((one) => one.name), ["suola", "öljy"]);
});

test("an ingredient with no pantry entry is bought as normal", () => {
  const { buy, atHome } = splitByPantry([SALT, MINCE], new Set());

  assert.equal(buy.length, 2);
  assert.equal(atHome.length, 0);
});

test("a moved row keeps its total and its breakdown", () => {
  // The Löytyy section answers "why does the week need this at all" too, so
  // nothing is stripped on the way across (#125).
  const { atHome } = splitByPantry([SALT], new Set([1]));

  assert.equal(atHome[0]!.total, "2 tl");
  assert.equal(atHome[0]!.contributions.length, 1);
  assert.equal(atHome[0]!.contributions[0]!.batchTitle, "Lasagne");
});

test("the whole row moves, however much of it the week needs", () => {
  // v1's pantry entry is unlimited on purpose: there is no amount to subtract,
  // so a big number is not a reason to keep it on the buying side.
  const lots = item(1, "suola", "500 g");
  const { buy, atHome } = splitByPantry([lots], new Set([1]));

  assert.equal(buy.length, 0);
  assert.deepEqual(atHome.map((one) => one.total), ["500 g"]);
});

test("matching is by id, and a same-named other ingredient is not it", () => {
  const otherSalt = item(9, "suola", "1 tl");
  const { buy } = splitByPantry([SALT, otherSalt], new Set([1]));

  assert.deepEqual(buy.map((one) => one.ingredientId), [9]);
});

test("both sections keep the order the list put them in", () => {
  const { buy } = splitByPantry([SALT, MINCE, OIL], new Set([2]));

  assert.deepEqual(buy.map((one) => one.name), ["suola", "öljy"]);
});
