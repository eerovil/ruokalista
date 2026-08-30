import assert from "node:assert/strict";
import test from "node:test";

import { DROPPED_NOTE, usableAmounts } from "../src/draft-amounts.ts";
import { formatDecimal, formatQuantity } from "../src/quantities.ts";

function line(over: Partial<Parameters<typeof usableAmounts>[0]> = {}) {
  return {
    quantity: null,
    quantityMax: null,
    unit: null,
    altQuantity: null,
    altUnit: null,
    note: null,
    ...over,
  };
}

test("an ordinary amount is left exactly as the source wrote it", () => {
  const kept = usableAmounts(line({ quantity: 0.5, unit: "kg" }));
  assert.deepEqual(kept, line({ quantity: 0.5, unit: "kg" }));

  const range = usableAmounts(
    line({ quantity: 1, quantityMax: 1.5, unit: "l" }),
  );
  assert.deepEqual(range, line({ quantity: 1, quantityMax: 1.5, unit: "l" }));
});

test("a zero amount is dropped rather than shown as an amount", () => {
  const repaired = usableAmounts(line({ quantity: 0, unit: "kg" }));

  assert.equal(repaired.quantity, null);
  assert.equal(repaired.unit, null);
  assert.equal(repaired.note, DROPPED_NOTE);
});

test("a negative amount goes the same way as a zero", () => {
  const repaired = usableAmounts(line({ quantity: -2, unit: "dl" }));

  assert.equal(repaired.quantity, null);
  assert.equal(repaired.note, DROPPED_NOTE);
});

test("the model's own note is kept over the dropped-amount one", () => {
  const repaired = usableAmounts(
    line({ quantity: 0, unit: "kg", note: "Määrä oli sanallinen." }),
  );

  assert.equal(repaired.note, "Määrä oli sanallinen.");
});

test("a tiny amount gets the smaller unit instead of rounding away", () => {
  assert.deepEqual(usableAmounts(line({ quantity: 0.0005, unit: "kg" })), {
    ...line({ quantity: 0.5, unit: "g" }),
  });
  // The chain stops at the first unit that reads: 0,02 dl is a number a member
  // can see, so there is no reason to go on to millilitres.
  assert.deepEqual(usableAmounts(line({ quantity: 0.002, unit: "l" })), {
    ...line({ quantity: 0.02, unit: "dl" }),
  });
  assert.deepEqual(usableAmounts(line({ quantity: 0.00002, unit: "l" })), {
    ...line({ quantity: 0.02, unit: "ml" }),
  });
});

test("both ends of a range move to the same smaller unit", () => {
  const repaired = usableAmounts(
    line({ quantity: 0.001, quantityMax: 0.002, unit: "kg" }),
  );

  assert.deepEqual(repaired, line({ quantity: 1, quantityMax: 2, unit: "g" }));
});

test("an amount no unit can rescue is dropped", () => {
  const repaired = usableAmounts(line({ quantity: 0.0001, unit: "g" }));

  assert.equal(repaired.quantity, null);
  assert.equal(repaired.unit, null);
  assert.equal(repaired.note, DROPPED_NOTE);
});

test("a second measurement is repaired on its own unit", () => {
  const repaired = usableAmounts(
    line({ quantity: 0.5, unit: "kpl", altQuantity: 0.0005, altUnit: "kg" }),
  );

  assert.equal(repaired.quantity, 0.5);
  assert.equal(repaired.altQuantity, 0.5);
  assert.equal(repaired.altUnit, "g");
  assert.equal(repaired.note, null);
});

test("a second measurement never outlives the amount it stands beside", () => {
  const repaired = usableAmounts(
    line({ quantity: 0, unit: "kpl", altQuantity: 500, altUnit: "g" }),
  );

  assert.equal(repaired.quantity, null);
  assert.equal(repaired.altQuantity, null);
  assert.equal(repaired.altUnit, null);
  assert.equal(repaired.note, DROPPED_NOTE);
});

test("a bad upper end costs the range rather than the line", () => {
  const repaired = usableAmounts(
    line({ quantity: 2, quantityMax: 0, unit: "dl" }),
  );

  assert.deepEqual(repaired, line({ quantity: 2, unit: "dl" }));
});

test("an upper end with nothing under it is dropped", () => {
  const repaired = usableAmounts(line({ quantityMax: 3, unit: "dl" }));

  assert.equal(repaired.quantity, null);
  assert.equal(repaired.quantityMax, null);
  assert.equal(repaired.note, DROPPED_NOTE);
});

test("a stated null amount is untouched and earns no note", () => {
  assert.deepEqual(usableAmounts(line({ unit: "dl" })), line({ unit: "dl" }));
});

/**
 * The point of the whole exercise: every amount that survives is one the member
 * reads as a number and the editor hands back as the same number, so nothing
 * the save refuses can reach a screen.
 */
test("what survives is legible on the screen and in the editor's box", () => {
  const sources = [0, -1, 0.0005, 0.002, 0.004, 0.5, 1, 0.0001];
  const units = ["kg", "l", "dl", "g", null];

  for (const quantity of sources) {
    for (const unit of units) {
      const repaired = usableAmounts(line({ quantity, unit }));
      if (repaired.quantity === null) continue;

      assert.ok(
        repaired.quantity > 0,
        `${quantity} ${unit} stayed at or below zero`,
      );
      assert.notEqual(
        formatQuantity(repaired.quantity),
        "0",
        `${quantity} ${unit} still reads as 0 on the screen`,
      );
      assert.ok(
        Number(formatDecimal(repaired.quantity).replace(",", ".")) > 0,
        `${quantity} ${unit} still comes back from the editor as 0`,
      );
    }
  }
});
