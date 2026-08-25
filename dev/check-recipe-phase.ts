import assert from "node:assert/strict";
import test from "node:test";

import { recipePhase } from "../src/recipe-phase.ts";

test("model phases parse only the two semantic values", () => {
  assert.equal(recipePhase("before_parts"), "before_parts");
  assert.equal(recipePhase("after_parts"), "after_parts");
  assert.equal(recipePhase(null), null);
  assert.equal(recipePhase("during_parts"), null);
  assert.equal(recipePhase(""), null);
});
