import assert from "node:assert/strict";
import test from "node:test";

import {
  remainingBundle,
  saveRecipesSequentially,
} from "../src/batch-save.ts";
import type { RecipeToSave } from "../src/recipe-save.ts";

test("a later batch failure keeps an exact retryable remainder", async () => {
  const recipes = ["Ensimmäinen", "Toinen", "Kolmas"].map(
    (title) => ({ title }) as RecipeToSave,
  );
  const result = await saveRecipesSequentially(recipes, async (recipe) => {
    if (recipe.title === "Toinen") throw new Error("test failure");
    return recipe.title === "Ensimmäinen" ? 11 : 33;
  });

  assert.deepEqual(result.saved, [{ id: 11, title: "Ensimmäinen" }]);
  assert.equal(result.failed?.index, 1);
  assert.deepEqual(
    JSON.parse(
      remainingBundle(
        JSON.stringify({ format_version: 1, recipes: [1, 2, 3] }),
        result.failed!.index,
      ),
    ).recipes,
    [2, 3],
  );
});
