import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { Vocabulary } from "../src/category-data.ts";

const DATA_SOURCE = readFileSync(
  new URL("../src/category-data.ts", import.meta.url),
  "utf8",
);

const vocabulary = new Vocabulary([
  { slug: "pasta", label: "Pasta" },
  { slug: "keitto", label: "Keitto" },
  { slug: "salaatti", label: "Salaatti" },
]);

test("category data stays independent from rendering", () => {
  assert.doesNotMatch(DATA_SOURCE, /(?:\.\/|\.\.\/)html\.ts/);
  assert.doesNotMatch(DATA_SOURCE, /\bhtml`|\braw\(/);
});

test("Vocabulary preserves ordering, fallback and submitted-category filtering", () => {
  assert.equal(vocabulary.has("keitto"), true);
  assert.equal(vocabulary.has("tuntematon"), false);
  assert.equal(vocabulary.label("keitto"), "Keitto");
  assert.equal(vocabulary.label("vanha-slug"), "vanha-slug");
  assert.deepEqual(
    vocabulary.sort(["salaatti", "pasta", "salaatti"]),
    ["pasta", "salaatti"],
  );

  const form = new FormData();
  form.append("category", "salaatti");
  form.append("category", "tuntematon");
  form.append("category", "pasta");
  form.append("category", "pasta");
  assert.deepEqual(vocabulary.read(form), ["pasta", "salaatti"]);
});
