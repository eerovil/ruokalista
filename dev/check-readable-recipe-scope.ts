import assert from "node:assert/strict";
import test from "node:test";

import { readableRecipeScope } from "../src/recipe-publish.ts";

function placeholderCount(sql: string): number {
  return [...sql.matchAll(/\?/g)].length;
}

test("readable recipe scope carries its household bindings with the SQL", () => {
  const scope = readableRecipeScope(42);

  assert.deepEqual(scope.bindings, [42, 42]);
  assert.equal(placeholderCount(scope.sql), scope.bindings.length);
  assert.match(scope.sql, /recipe\.household_id = \?/);
  assert.match(scope.sql, /recipe\.published_at IS NOT NULL/);
  assert.match(scope.sql, /recipe_share\.recipe_id = recipe\.id/);
  assert.match(scope.sql, /recipe_share\.household_id = \?/);
});

test("readable recipe scope supports an aliased recipe row", () => {
  const scope = readableRecipeScope(7, "parent");

  assert.deepEqual(scope.bindings, [7, 7]);
  assert.equal(placeholderCount(scope.sql), scope.bindings.length);
  assert.match(scope.sql, /parent\.household_id = \?/);
  assert.match(scope.sql, /parent\.published_at IS NOT NULL/);
  assert.match(scope.sql, /recipe_share\.recipe_id = parent\.id/);
});
