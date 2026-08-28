/**
 * Scaling arithmetic and its rounding. Free to run, and the place where "6,666
 * dl" either becomes something a cook can pour or does not.
 *
 *   ./scripts/node.sh npm run check
 */

import assert from "node:assert/strict";
import test from "node:test";

import { formatMeasurement } from "../src/quantities.ts";
import {
  formatMultiplier,
  isMultiplier,
  parseMultiplier,
  roundForKitchen,
  scaleMeasurement,
} from "../src/scaling.ts";

const line = (over: Partial<Parameters<typeof scaleMeasurement>[0]> = {}) => ({
  quantity: null,
  quantityMax: null,
  unit: null,
  altQuantity: null,
  altUnit: null,
  ...over,
});

test("a typed multiplier takes the Finnish comma, and the x with it", () => {
  assert.equal(parseMultiplier("1,5"), 1.5);
  assert.equal(parseMultiplier("1.5"), 1.5);
  assert.equal(parseMultiplier(" 2× "), 2);
  assert.equal(parseMultiplier("0,5x"), 0.5);
});

test("a multiplier that is not one is refused rather than repaired", () => {
  assert.equal(parseMultiplier(""), null);
  assert.equal(parseMultiplier("0"), null);
  assert.equal(parseMultiplier("-2"), null);
  assert.equal(parseMultiplier("puolikas"), null);
});

test("the domain accepts every finite positive multiplier without rounding it", () => {
  assert.equal(parseMultiplier("1,333"), 1.333);
  assert.equal(parseMultiplier("200"), 200);
  assert.equal(parseMultiplier("0,004"), 0.004);
  assert.equal(isMultiplier(200), true);
  assert.equal(isMultiplier(0), false);
  assert.equal(isMultiplier(Number.NaN), false);
});

test("a multiplier reads with a Finnish comma and no trailing zeros", () => {
  assert.equal(formatMultiplier(1), "1×");
  assert.equal(formatMultiplier(0.5), "0,5×");
  assert.equal(formatMultiplier(1.5), "1,5×");
  assert.equal(formatMultiplier(2), "2×");
  assert.equal(formatMultiplier(1.333), "1,333×");
});

test("the recipe as written comes back untouched at 1x", () => {
  const written = line({ quantity: 6.666, unit: "dl" });
  assert.deepEqual(scaleMeasurement(written, 1), written);
});

test("a stored multiplier that is not one scales nothing", () => {
  // Belt and braces against a row no migration should ever leave behind.
  const written = line({ quantity: 5, unit: "dl" });
  assert.deepEqual(scaleMeasurement(written, 0), written);
  assert.deepEqual(scaleMeasurement(written, Number.NaN), written);
});

test("small amounts keep their quarters", () => {
  // ¼ vs ½ a teaspoon is a real difference.
  assert.equal(roundForKitchen(0.75, "dl"), 0.75);
  assert.equal(roundForKitchen(0.66, "tl"), 0.75);
  assert.equal(roundForKitchen(2.666, "dl"), 2.75);
});

test("larger amounts go to halves, then to whole numbers", () => {
  assert.equal(roundForKitchen(6.666, "dl"), 6.5);
  assert.equal(roundForKitchen(3.3, "dl"), 3.5);
  assert.equal(roundForKitchen(26.4, "dl"), 26);
});

test("weights round the way a scale reads", () => {
  assert.equal(roundForKitchen(533.3, "g"), 530);
  assert.equal(roundForKitchen(42.2, "g"), 40);
  assert.equal(roundForKitchen(1.24, "kg"), 1.2);
});

test("an amount is never rounded away to nothing", () => {
  assert.equal(roundForKitchen(0.05, "dl"), 0.25);
  assert.equal(roundForKitchen(1.2, "g"), 5);
});

test("a line with no stated amount is left alone", () => {
  const hint = line({ unit: null });
  assert.deepEqual(scaleMeasurement(hint, 1.5), hint);
  assert.equal(formatMeasurement(scaleMeasurement(hint, 1.5)), "");
});

test("Kaalilaatikko at 1,5×", () => {
  const factor = 1.5;

  // ½ dl öljyä
  assert.equal(
    formatMeasurement(scaleMeasurement(line({ quantity: 0.5, unit: "dl" }), factor)),
    "¾ dl",
  );

  // 1–1½ l vettä — both ends of the range move.
  assert.equal(
    formatMeasurement(
      scaleMeasurement(
        line({ quantity: 1, quantityMax: 1.5, unit: "l" }),
        factor,
      ),
    ),
    "1½–2¼ l",
  );

  // ½ (500 g) valkokaali — a second measurement scales with the first.
  assert.equal(
    formatMeasurement(
      scaleMeasurement(
        line({ quantity: 0.5, unit: "kpl", altQuantity: 500, altUnit: "g" }),
        factor,
      ),
    ),
    "¾ kpl (750 g)",
  );
});

test("Lasagne at 4/3×, where the rounding does the work", () => {
  const factor = 8 / 6;

  // 400 g jauhelihaa -> 533.3, which a scale would show as 530.
  assert.equal(
    formatMeasurement(scaleMeasurement(line({ quantity: 400, unit: "g" }), factor)),
    "530 g",
  );

  // 5 dl maitoa -> 6.666, which nobody pours. 6½ dl.
  assert.equal(
    formatMeasurement(scaleMeasurement(line({ quantity: 5, unit: "dl" }), factor)),
    "6½ dl",
  );

  // 2 dl juustoa -> 2.666, small enough to keep a quarter.
  assert.equal(
    formatMeasurement(scaleMeasurement(line({ quantity: 2, unit: "dl" }), factor)),
    "2¾ dl",
  );
});

test("halving works as well as doubling", () => {
  const factor = 0.5;
  assert.equal(
    formatMeasurement(scaleMeasurement(line({ quantity: 5, unit: "dl" }), factor)),
    "2½ dl",
  );
});
