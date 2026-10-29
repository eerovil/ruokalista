import assert from "node:assert/strict";
import test from "node:test";

import { castRecipe } from "../src/cast.ts";
import type { Recipe, RecipeLine } from "../src/recipes.ts";

/**
 * The cast receiver draws plain strings and has nothing to tap, so a group
 * phrase (#376) has to carry its list in the step's own text, the same list the
 * recipe screen shows.
 */

function line(
  position: number,
  ingredientId: number,
  ingredient: string,
  quantity: number | null,
  unit: string | null,
): RecipeLine {
  return {
    position,
    ingredientId,
    ingredient,
    quantity,
    quantityMax: null,
    unit,
    altQuantity: null,
    altUnit: null,
    productImageUrl: null,
    sourceLine: "",
    phase: null,
    alternativeGroup: null,
  } as RecipeLine;
}

test("a cast step spells out what a group phrase stands for", () => {
  const recipe = {
    title: "Skonssit",
    parts: [],
    lines: [
      line(1, 1, "vehnäjauho", 3, "dl"),
      line(2, 2, "leivinjauhe", 2, "tl"),
      line(3, 3, "maito", 1, "dl"),
    ],
    steps: [{
      text: "Yhdistä kuivat aineet ja lisää maito.",
      phase: null,
      refs: [
        { ingredientId: 2, matchedText: "kuivat aineet", approxPosition: 8 },
        { ingredientId: 1, matchedText: "kuivat aineet", approxPosition: 8 },
        { ingredientId: 3, matchedText: "maito", approxPosition: 31 },
      ],
    }],
  } as unknown as Recipe;

  assert.deepEqual(castRecipe(recipe, 2).instructions, [{
    title: "",
    items: [
      "Yhdistä kuivat aineet (6 dl vehnäjauho, 4 tl leivinjauhe) ja lisää maito.",
    ],
  }]);
});
