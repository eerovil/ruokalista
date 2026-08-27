import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MAX_CELLS } from "../src/contact-sheet.ts";
import {
  dishBrief,
  GENERATED_BY,
  sheetPrompt,
  STYLE_VERSION,
} from "../src/image-generation.ts";
import type { FingerprintRecipe } from "../src/recipe-fingerprint.ts";

/**
 * The prompt and the brief.
 *
 * Since #111 there is no image request to make: the prompt is copied by an
 * admin into whichever image tool they like, and the sheet comes back as a
 * file. That makes these checks more important rather than less. The prompt is
 * now a *contract* between two things that never meet — the words a person
 * pastes into some other tool, and the splitter that cuts what they bring back
 * — and nothing at runtime can notice the two disagreeing.
 *
 * Three parts of it are load-bearing, and all three fail silently: a grid that
 * stops being sixteen cells moves every cell a recipe was mapped to, rendered
 * text gives a positional mapping something to be misread against, and a brief
 * that lost a multipart dish's parts describes an empty plate. None of those
 * would make anything error — they would produce a sheet that cut cleanly into
 * pictures of the wrong dishes.
 */

function line(ingredient: string) {
  return {
    ingredient,
    quantity: null,
    quantityMax: null,
    unit: null,
    altQuantity: null,
    altUnit: null,
  };
}

function recipe(
  title: string,
  ingredients: string[],
  parts: FingerprintRecipe["parts"] = [],
): FingerprintRecipe {
  return { title, lines: ingredients.map(line), parts };
}

test("the prompt always asks for sixteen cells, whatever the batch size", () => {
  for (const count of [1, 3, 16]) {
    const dishes = Array.from({ length: count }, (_, at) =>
      dishBrief(at + 1, recipe(`Ruoka ${at + 1}`, ["peruna"])),
    );
    const prompt = sheetPrompt(dishes);

    assert.match(prompt, /exactly 16 food illustrations/, `${count} dishes`);
    assert.match(prompt, /4-column by 4-row grid/, `${count} dishes`);
    assert.match(prompt, new RegExp(`Cell ${count}: Ruoka ${count}`), `${count} dishes`);
    assert.doesNotMatch(prompt, new RegExp(`Cell ${count + 1}:`), `${count} dishes`);
  }
});

test("a partial batch says the rest must be left empty and not rearranged", () => {
  const prompt = sheetPrompt([dishBrief(1, recipe("Kaalilaatikko", ["kaali"]))]);
  assert.match(prompt, /Cells 2 to 16 are unused/);
  assert.match(prompt, /completely empty and fully transparent/);
  assert.match(prompt, /do not rearrange the used cells/);
});

test("a full batch does not talk about unused cells", () => {
  const dishes = Array.from({ length: MAX_CELLS }, (_, at) =>
    dishBrief(at + 1, recipe(`Ruoka ${at + 1}`, ["peruna"])),
  );
  assert.match(sheetPrompt(dishes), /All sixteen cells are used/);
});

test("the prompt forbids text and asks for the gutters the splitter needs", () => {
  const prompt = sheetPrompt([dishBrief(1, recipe("Uunikaali", ["kaali"]))]);
  assert.match(prompt, /no text, no numbers, no labels/);
  assert.match(prompt, /fully transparent background/);
  assert.match(prompt, /generous fully transparent gutters/);
  assert.match(prompt, /never touching or crossing the cell boundary/);
  assert.match(prompt, /may overlap or touch another cell's dish/);
});

test("a brief is the dish's own title and ingredients", () => {
  const brief = dishBrief(7, recipe("  Uunikaali  ", ["kaali", "riisi", "maito"]));
  assert.deepEqual(brief, {
    recipeId: 7,
    title: "Uunikaali",
    ingredients: ["kaali", "riisi", "maito"],
  });
});

test("a multipart dish's parts are in its brief", () => {
  const brief = dishBrief(
    3,
    recipe("Lasagne", ["lasagnelevy"], [
      recipe("Jauhelihakastike", ["jauheliha", "tomaatti"]),
      recipe("Juustokastike", ["juusto", "maito"]),
    ]),
  );
  assert.deepEqual(brief.ingredients, [
    "lasagnelevy",
    "jauheliha",
    "tomaatti",
    "juusto",
    "maito",
  ]);
});

test("an ingredient named twice is described once", () => {
  const brief = dishBrief(
    4,
    recipe("Kastike", ["Maito", "voi"], [recipe("Pohja", ["maito", "jauho"])]),
  );
  assert.deepEqual(brief.ingredients, ["Maito", "voi", "jauho"]);
});

test("a long ingredient list is cut down, not pasted whole", () => {
  const many = Array.from({ length: 30 }, (_, at) => `aines-${at}`);
  assert.equal(dishBrief(5, recipe("Iso", many)).ingredients.length, 8);
});

test("a dish with no ingredients still gets a usable brief", () => {
  const prompt = sheetPrompt([dishBrief(6, recipe("Pannukakku", []))]);
  assert.match(prompt, /Cell 1: Pannukakku — no ingredient list available/);
});

test("a batch bigger than a sheet is a programming error", () => {
  const dishes = Array.from({ length: MAX_CELLS + 1 }, (_, at) =>
    dishBrief(at + 1, recipe("Ruoka", ["peruna"])),
  );
  assert.throws(() => sheetPrompt(dishes), RangeError);
  assert.throws(() => sheetPrompt([]), RangeError);
});

/**
 * What a stored picture records about where it came from.
 *
 * It used to name the provider and the model that were paid for the sheet.
 * Nothing is paid now and nothing knows which tool the admin used, so what it
 * records is the part that is true and useful: a person supplied the sheet,
 * drawn to our prompt under this style version. The style version is the half
 * that must not be hard-coded — it is what dates every picture in a household
 * when the style text changes.
 */
test("what gets stored says a person supplied it, and under which style", () => {
  assert.equal(GENERATED_BY, `supplied:manual/${STYLE_VERSION}`);
  assert.ok(GENERATED_BY.endsWith(`/${STYLE_VERSION}`), GENERATED_BY);
  assert.doesNotMatch(GENERATED_BY, /openai/);
});

/**
 * The removed half, asserted as removed.
 *
 * #96 called OpenAI from the Worker. #111 deleted that, because on the Workers
 * Free plan it could not finish: 10 ms of CPU a request against well over a
 * second of pixel work, which killed the one live attempt after 178 seconds and
 * threw away the sheet it had bought. This module is the prompt and nothing
 * else now, and this check is what notices if a request creeps back into it —
 * a paid call nobody meant to add is not the kind of thing to find in a bill.
 */
test("this module makes no network request of any kind", async () => {
  const source = await readFile(
    new URL("../src/image-generation.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /fetch\(/);
  assert.doesNotMatch(source, /api\.openai\.com/);
  assert.doesNotMatch(source, /OPENAI_API_KEY/);
  // And it needs no environment at all, which is the structural version of the
  // same claim: a module that cannot see a key cannot spend one.
  assert.doesNotMatch(source, /from "\.\/env\.ts"/);
});
