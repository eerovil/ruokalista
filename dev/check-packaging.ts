import assert from "node:assert/strict";
import test from "node:test";

import {
  baseAmount,
  formatBaseAmount,
  packageSizeFromName,
  planPackages,
  type PackageOption,
} from "../src/packaging.ts";

/**
 * Package sizes on their own, away from any shopping list: reading one off a
 * product name, and covering a need with the ones that are known.
 */

// ------------------------------------------------------------------ conversions

test("a unit converts only inside its own family", () => {
  assert.deepEqual(baseAmount(1, "kg"), { family: "mass", amount: 1000 });
  assert.deepEqual(baseAmount(5, "dl"), { family: "volume", amount: 500 });
  assert.deepEqual(baseAmount(2, "kpl"), { family: "count", amount: 2 });
  assert.equal(baseAmount(1, "g")!.family !== baseAmount(1, "ml")!.family, true);
});

test("a unit this app does not know has no base amount at all", () => {
  for (const unit of ["rkl", "tl", "pss", "prk", "nippu", "", null]) {
    assert.equal(baseAmount(2, unit), null, `${unit} should stay unknown`);
  }
});

test("a missing or nonsense amount has no base amount", () => {
  assert.equal(baseAmount(null, "g"), null);
  assert.equal(baseAmount(0, "g"), null);
  assert.equal(baseAmount(-5, "g"), null);
});

test("an amount reads the way a Finnish kitchen writes it", () => {
  assert.equal(formatBaseAmount({ family: "mass", amount: 800 }), "800 g");
  assert.equal(formatBaseAmount({ family: "mass", amount: 1100 }), "1,1 kg");
  assert.equal(formatBaseAmount({ family: "volume", amount: 500 }), "5 dl");
  assert.equal(formatBaseAmount({ family: "volume", amount: 1500 }), "1,5 l");
  assert.equal(formatBaseAmount({ family: "count", amount: 3 }), "3 kpl");
});

// ------------------------------------------------------------- reading a name

test("the size a product name states is read off it", () => {
  assert.deepEqual(packageSizeFromName("Atria naudan jauheliha 400 g"), {
    quantity: 400,
    unit: "g",
  });
  assert.deepEqual(packageSizeFromName("Kotimaista rasvaton maito 1 l"), {
    quantity: 1,
    unit: "l",
  });
  assert.deepEqual(packageSizeFromName("Rypsiöljy 1,5 l"), {
    quantity: 1.5,
    unit: "l",
  });
  assert.deepEqual(packageSizeFromName("Kananmunat 10 kpl"), {
    quantity: 10,
    unit: "kpl",
  });
});

test("a name that says nothing about a packet says nothing", () => {
  assert.equal(packageSizeFromName("Kanan rintafileesuikale marinoitu"), null);
  assert.equal(packageSizeFromName("Luomu banaani"), null);
});

test("a multipack is left for a person rather than multiplied out", () => {
  // 2 x 200 g is 400 g only if the 2 multiplies the packet, and a name is not
  // a promise about that. An empty field beats a confident wrong number.
  assert.equal(packageSizeFromName("Jogurtti 2 x 200 g"), null);
  assert.equal(packageSizeFromName("Makkara 4×125 g"), null);
});

test("two disagreeing sizes in one name are not a size", () => {
  assert.equal(packageSizeFromName("Kastike 500 g, sisältää 250 ml kermaa"), null);
});

test("the same size said twice is still that size", () => {
  assert.deepEqual(packageSizeFromName("Maito 1 l (1 l)"), { quantity: 1, unit: "l" });
});

test("a number that is not a size is not read as one", () => {
  assert.equal(packageSizeFromName("Kermaviili 15 %"), null);
  assert.equal(packageSizeFromName("Kaura 100 luomu"), null);
});

// ------------------------------------------------------------ covering a need

function options(...sizes: number[]): PackageOption[] {
  return sizes.map((amount) => ({
    key: String(amount),
    size: { family: "mass" as const, amount },
  }));
}

function plan(need: number, ...sizes: number[]): string[] {
  const result = planPackages({ family: "mass", amount: need }, options(...sizes));
  if (result === null) return [];
  return result.picks
    .map((pick) => `${pick.count}x${pick.key}`)
    .sort((a, b) => a.localeCompare(b));
}

test("the examples #161 spells out, in order", () => {
  assert.deepEqual(plan(350, 400, 700), ["1x400"]);
  assert.deepEqual(plan(400, 400, 700), ["1x400"]);
  assert.deepEqual(plan(600, 400, 700), ["1x700"]);
  assert.deepEqual(plan(700, 400, 700), ["1x700"]);
  assert.deepEqual(plan(750, 400, 700), ["2x400"]);
  assert.deepEqual(plan(1100, 400, 700), ["1x400", "1x700"]);
});

test("least waste first, fewest packets to break a tie", () => {
  // 1000 g from 500 g and 1 kg packets: both waste nothing, so the single
  // packet wins.
  assert.deepEqual(plan(1000, 500, 1000), ["1x1000"]);
});

test("a third size is used when it is what fits", () => {
  assert.deepEqual(plan(1000, 400, 700, 1000), ["1x1000"]);
});

test("two answers that are equally good by both rules are both allowed", () => {
  // 1400 g is 1000+400 or 700+700: no waste and two packets either way. The
  // issue asks for least waste then fewest packets and stops there, so this
  // asserts what was promised rather than pinning the search's own order.
  const result = planPackages({ family: "mass", amount: 1400 }, options(400, 700, 1000));
  assert.equal(result!.waste, 0);
  assert.equal(
    result!.picks.reduce((count, pick) => count + pick.count, 0),
    2,
  );
});

test("the plan says what it holds and how much of it is spare", () => {
  const result = planPackages({ family: "mass", amount: 750 }, options(400, 700));
  assert.equal(result!.total, 800);
  assert.equal(result!.waste, 50);
});

test("a package in another family is not offered at all", () => {
  const result = planPackages({ family: "volume", amount: 500 }, options(400));
  assert.equal(result, null);
});

test("nothing to choose from is no plan rather than an empty one", () => {
  assert.equal(planPackages({ family: "mass", amount: 500 }, []), null);
  assert.equal(planPackages({ family: "mass", amount: 0 }, options(400)), null);
});

test("a need beyond a sensible trolley gets no plan", () => {
  // Twelve packets is the cap. Thirteen of them is not a shopping list any
  // more, and saying nothing is better than saying something absurd.
  assert.equal(plan(5200, 400).length, 0);
  assert.deepEqual(plan(4800, 400), ["12x400"]);
});

test("one size that is far too small still covers a need it can reach", () => {
  assert.deepEqual(plan(900, 400), ["3x400"]);
});
