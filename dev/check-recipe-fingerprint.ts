import assert from "node:assert/strict";
import test from "node:test";

import { imageStatus, type StoredImage } from "../src/image-freshness.ts";
import {
  canonicalRecipe,
  recipeFingerprint,
  type FingerprintLine,
  type FingerprintRecipe,
} from "../src/recipe-fingerprint.ts";

/**
 * The fingerprint decides when the app spends money regenerating a picture, so
 * it is checked directly rather than through a browser. What matters is not
 * that two hashes differ once — it is which changes move it and which cannot,
 * and a browser test can only ever demonstrate one of those at a time.
 */

function line(
  ingredient: string,
  fields: Partial<FingerprintLine> = {},
): FingerprintLine {
  return {
    quantity: null,
    quantityMax: null,
    unit: null,
    altQuantity: null,
    altUnit: null,
    ingredient,
    ...fields,
  };
}

function dish(
  lines: FingerprintLine[],
  extra: Partial<FingerprintRecipe> = {},
): FingerprintRecipe {
  return { title: "Kaalilaatikko", lines, parts: [], ...extra };
}

const KAALILAATIKKO = dish([
  line("valkokaali", { quantity: 1, unit: "kg" }),
  line("jauheliha", { quantity: 400, unit: "g" }),
  line("suola"),
]);

test("the same content hashes the same, every time", async () => {
  const once = await recipeFingerprint(KAALILAATIKKO);
  const again = await recipeFingerprint(structuredClone(KAALILAATIKKO));
  assert.equal(once, again);
  assert.match(once, /^[0-9a-f]{64}$/);
});

test("a changed quantity is a different dish", async () => {
  const heavier = dish([
    line("valkokaali", { quantity: 1, unit: "kg" }),
    line("jauheliha", { quantity: 600, unit: "g" }),
    line("suola"),
  ]);
  assert.notEqual(
    await recipeFingerprint(KAALILAATIKKO),
    await recipeFingerprint(heavier),
  );
});

test("a changed ingredient is a different dish", async () => {
  const lentils = dish([
    line("valkokaali", { quantity: 1, unit: "kg" }),
    line("linssit", { quantity: 400, unit: "g" }),
    line("suola"),
  ]);
  assert.notEqual(
    await recipeFingerprint(KAALILAATIKKO),
    await recipeFingerprint(lentils),
  );
});

test("adding and removing an ingredient both move it", async () => {
  const base = await recipeFingerprint(KAALILAATIKKO);

  const added = dish([...KAALILAATIKKO.lines, line("siirappi", { quantity: 1, unit: "rkl" })]);
  const removed = dish(KAALILAATIKKO.lines.slice(0, 2));

  assert.notEqual(await recipeFingerprint(added), base);
  assert.notEqual(await recipeFingerprint(removed), base);
});

test("putting the ingredients back gives the same fingerprint again", async () => {
  const before = await recipeFingerprint(KAALILAATIKKO);

  const edited = dish([
    line("valkokaali", { quantity: 1, unit: "kg" }),
    line("linssit", { quantity: 400, unit: "g" }),
    line("suola"),
  ]);
  assert.notEqual(await recipeFingerprint(edited), before);

  const restored = dish([
    line("valkokaali", { quantity: 1, unit: "kg" }),
    line("jauheliha", { quantity: 400, unit: "g" }),
    line("suola"),
  ]);
  assert.equal(await recipeFingerprint(restored), before);
});

test("the title is part of it", async () => {
  assert.notEqual(
    await recipeFingerprint(KAALILAATIKKO),
    await recipeFingerprint(dish([...KAALILAATIKKO.lines], { title: "Kaalipata" })),
  );
});

test("row order and everything not about the food are not part of it", async () => {
  const reordered = dish([
    line("suola"),
    line("jauheliha", { quantity: 400, unit: "g" }),
    line("valkokaali", { quantity: 1, unit: "kg" }),
  ]);
  assert.equal(
    await recipeFingerprint(reordered),
    await recipeFingerprint(KAALILAATIKKO),
  );

  // A `Recipe` from the store carries all of this, and none of it belongs in a
  // picture's freshness. Passing it in has to make no difference at all.
  const noisy = {
    ...KAALILAATIKKO,
    id: 7,
    revision: 12,
    sourceText: "aivan eri teksti",
    sourceRoute: "photographed" as const,
    yieldPortions: 8,
    steps: [{ text: "Paista jauheliha.", phase: null }],
    createdAt: "2026-08-26 09:00:00",
    createdBy: "Eero",
    imageKey: "recipes/1/7/whatever.jpg",
  };
  assert.equal(
    await recipeFingerprint(noisy),
    await recipeFingerprint(KAALILAATIKKO),
  );
});

test("differences that are not differences are ignored", async () => {
  const fussy = dish([
    line("  valkokaali ", { quantity: 1, unit: "KG" }),
    line("jauheliha", { quantity: 400.0000001, unit: "g" }),
    line("suola"),
  ]);
  assert.equal(
    await recipeFingerprint(fussy),
    await recipeFingerprint(KAALILAATIKKO),
  );
});

test("a range and a second measurement are both in it", async () => {
  const base = dish([line("kerma", { quantity: 2, unit: "dl" })]);
  const ranged = dish([line("kerma", { quantity: 2, quantityMax: 3, unit: "dl" })]);
  const alsoGrams = dish([
    line("kerma", { quantity: 2, unit: "dl", altQuantity: 200, altUnit: "g" }),
  ]);

  const hashes = await Promise.all(
    [base, ranged, alsoGrams].map((one) => recipeFingerprint(one)),
  );
  assert.equal(new Set(hashes).size, 3);
});

test("which part an ingredient belongs to is part of the dish", async () => {
  const kastike = { title: "Juustokastike", lines: [line("juusto", { quantity: 200, unit: "g" })] };
  const liha = { title: "Jauhelihakastike", lines: [line("jauheliha", { quantity: 400, unit: "g" })] };

  const split = dish([], { title: "Lasagne", parts: [liha, kastike] });
  const swapped = dish([], {
    title: "Lasagne",
    parts: [
      { title: "Jauhelihakastike", lines: kastike.lines },
      { title: "Juustokastike", lines: liha.lines },
    ],
  });
  const flat = dish([...liha.lines, ...kastike.lines], { title: "Lasagne" });

  const asSplit = await recipeFingerprint(split);
  assert.notEqual(await recipeFingerprint(swapped), asSplit);
  assert.notEqual(await recipeFingerprint(flat), asSplit);

  // The order the parts are stored in is not the dish, though.
  const otherWayRound = dish([], { title: "Lasagne", parts: [kastike, liha] });
  assert.equal(await recipeFingerprint(otherWayRound), asSplit);
});

test("the canonical text says what moved, so a diff is readable", () => {
  assert.equal(
    canonicalRecipe(dish([line("suola"), line("kerma", { quantity: 2, unit: "dl" })])),
    ["v1", "dish Kaalilaatikko", "line 2||dl|||kerma", "line |||||suola"].join("\n"),
  );
});

// ------------------------------------------------------------ freshness

const FINGERPRINT = "a".repeat(64);

function stored(fields: Partial<StoredImage> = {}): StoredImage {
  return {
    imageKey: "recipes/1/1/one.jpg",
    imageOrigin: "generated",
    imageFingerprint: FINGERPRINT,
    ...fields,
  };
}

test("no picture is missing", () => {
  const none: StoredImage = {
    imageKey: null,
    imageOrigin: null,
    imageFingerprint: null,
  };
  assert.equal(imageStatus(none, FINGERPRINT), "missing");
});

test("a generated picture is fresh while its fingerprint holds", () => {
  assert.equal(imageStatus(stored(), FINGERPRINT), "fresh");
  assert.equal(imageStatus(stored(), "b".repeat(64)), "stale");
});

test("a manual upload is never queued for regeneration", () => {
  const manual = stored({ imageOrigin: "manual", imageFingerprint: null });
  assert.equal(imageStatus(manual, FINGERPRINT), "fresh");

  // Nor is one from before origins existed, which is every picture #89 stored.
  const legacy = stored({ imageOrigin: null, imageFingerprint: null });
  assert.equal(imageStatus(legacy, FINGERPRINT), "fresh");
});
