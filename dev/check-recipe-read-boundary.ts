import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readSource = readFileSync(
  new URL("../src/recipe-read.ts", import.meta.url),
  "utf8",
);
const editSource = readFileSync(
  new URL("../src/recipe-edit.ts", import.meta.url),
  "utf8",
);

test("recipe read model stays independent from HTTP and rendering", () => {
  for (const dependency of [
    "./html.ts",
    "./cast.ts",
    "./keep-awake.ts",
    "./categories.ts",
    "./router.ts",
  ]) {
    assert.equal(
      readSource.includes(dependency),
      false,
      `recipe-read.ts must not depend on ${dependency}`,
    );
  }
  assert.doesNotMatch(readSource, /\bRouteContext\b|\bResponse\.json\b|\bpage\(/);
});

test("domain edit reads recipes through the dependency-light layer", () => {
  assert.match(editSource, /from "\.\/recipe-read\.ts"/);
  assert.doesNotMatch(editSource, /from "\.\/recipes\.ts"/);
});
