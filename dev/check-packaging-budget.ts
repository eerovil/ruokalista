import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PACKAGE_SEARCH_STEPS,
  planPackages,
  type BaseAmount,
  type PackageOption,
  type PackagePlan,
  type PackageSearchStats,
  type UnitFamily,
} from "../src/packaging.ts";

function options(sizes: number[], family: UnitFamily = "mass"): PackageOption[] {
  return sizes.map((amount, index) => ({
    key: `ean-${index}`,
    size: { family, amount },
  }));
}

function stats(): PackageSearchStats {
  return { steps: 0, exhausted: false };
}

test("1/5/10/15 equal-sized EANs take the same bounded search and keep the first", () => {
  for (const count of [1, 5, 10, 15]) {
    const work = stats();
    const result = planPackages(
      { family: "mass", amount: 4800 },
      options(Array(count).fill(400)),
      work,
    );
    assert.deepEqual(result, {
      picks: [{ key: "ean-0", count: 12 }],
      total: 4800,
      waste: 0,
    });
    assert.deepEqual(work, { steps: 12, exhausted: false });
  }
});

test("equivalent sizes keep caller preference alongside different sizes", () => {
  const choices = options([400, 700, 400]);
  assert.deepEqual(planPackages({ family: "mass", amount: 1100 }, choices), {
    picks: [{ key: "ean-1", count: 1 }, { key: "ean-0", count: 1 }],
    total: 1100,
    waste: 0,
  });
  assert.deepEqual(planPackages({ family: "mass", amount: 1100 }, [
    choices[2]!, choices[1]!, choices[0]!,
  ]), {
    picks: [{ key: "ean-1", count: 1 }, { key: "ean-2", count: 1 }],
    total: 1100,
    waste: 0,
  });
});

test("equal-objective distinct-size ties retain the earlier larger-size plan", () => {
  const choices = options([400, 700, 1000]);
  const expected = {
    picks: [{ key: "ean-2", count: 1 }, { key: "ean-0", count: 1 }],
    total: 1400,
    waste: 0,
  };
  assert.deepEqual(planPackages({ family: "mass", amount: 1400 }, choices), expected);
  assert.deepEqual(planPackages({ family: "mass", amount: 1400 }, choices), expected);
});

test("a recipe-pinned single product remains the only selected EAN", () => {
  const choices = [{ key: "pinned-ean", size: { family: "mass" as const, amount: 400 } }];
  assert.deepEqual(planPackages({ family: "mass", amount: 750 }, choices), {
    picks: [{ key: "pinned-ean", count: 2 }], total: 800, waste: 50,
  });
});

test("equivalence is inside the requested mass/volume/count family only", () => {
  for (const family of ["mass", "volume", "count"] as const) {
    const choices: PackageOption[] = ["mass", "volume", "count"].map((value) => ({
      key: value,
      size: { family: value as UnitFamily, amount: 2 },
    }));
    assert.deepEqual(planPackages({ family, amount: 3 }, choices), {
      picks: [{ key: family, count: 2 }], total: 4, waste: 1,
    });
  }
});

test("distinct sizes exhaust the fixed budget without returning a partial best", () => {
  const choices = options(Array.from({ length: 15 }, (_, i) => 400 + i));
  const work = stats();
  // 12 x 414 already covers this need and is tried first. It must not escape
  // as the answer when the rest of the search could still improve it.
  assert.equal(planPackages({ family: "mass", amount: 4800 }, choices, work), null);
  assert.equal(work.exhausted, true);
  assert.equal(work.steps, MAX_PACKAGE_SEARCH_STEPS);
});

test("pruned trials count toward the budget too", () => {
  const choices = options(Array.from({ length: 1200 }, (_, i) => 100 + i));
  const work = stats();
  // Every single packet covers 10, so no recursive expansion is needed; most
  // counts overshoot the current best. Those iterations must still be bounded.
  assert.equal(planPackages({ family: "mass", amount: 10 }, choices, work), null);
  assert.deepEqual(work, { steps: MAX_PACKAGE_SEARCH_STEPS, exhausted: true });
});

test("thousands of distinct sizes cannot grow the call stack with skipped sizes", () => {
  const choices = options(Array.from({ length: 20_000 }, (_, i) => i + 1));
  const work = stats();
  assert.equal(planPackages({ family: "mass", amount: 220_001 }, choices, work), null);
  assert.deepEqual(work, { steps: MAX_PACKAGE_SEARCH_STEPS, exhausted: true });
});

test("an impossible-to-cover need is rejected without spending the search budget", () => {
  const choices = options(Array.from({ length: 15 }, (_, i) => 400 + i));
  const work = stats();
  assert.equal(planPackages({ family: "mass", amount: 4969 }, choices, work), null);
  assert.deepEqual(work, { steps: 0, exhausted: false });
});

test("a proved single-packet exact fit stops before unnecessary wide-list search", () => {
  const work = stats();
  const choices = options(Array.from({ length: 20_000 }, (_, i) => i + 1));
  assert.deepEqual(planPackages({ family: "mass", amount: 20_000 }, choices, work), {
    picks: [{ key: "ean-19999", count: 1 }], total: 20_000, waste: 0,
  });
  assert.deepEqual(work, { steps: 12, exhausted: false });
});

test("invalid needs and sizes cannot yield non-finite plans", () => {
  for (const amount of [NaN, Infinity, -Infinity, 0, -1]) {
    const work = { steps: 999, exhausted: true };
    assert.equal(planPackages({ family: "mass", amount }, options([400]), work), null);
    assert.deepEqual(work, { steps: 0, exhausted: false });
  }
  assert.deepEqual(planPackages(
    { family: "mass", amount: 500 }, options([NaN, Infinity, -Infinity, 0, -1, 400]),
  ), {
    picks: [{ key: "ean-5", count: 2 }], total: 800, waste: 300,
  });
  assert.equal(planPackages({ family: "mass", amount: 500 }, options([NaN, Infinity])), null);
  assert.deepEqual(planPackages({ family: "mass", amount: 1e308 }, options([1e308])), {
    picks: [{ key: "ean-0", count: 1 }], total: 1e308, waste: 0,
  });
  assert.equal(planPackages({ family: "mass", amount: 1.7e308 }, options([1e308])), null);
});

test("caller data is unchanged and diagnostic state is reset between calls", () => {
  const choices = options([400, 700, 400]);
  const before = structuredClone(choices);
  for (const option of choices) {
    Object.freeze(option.size);
    Object.freeze(option);
  }
  Object.freeze(choices);
  const work = { steps: MAX_PACKAGE_SEARCH_STEPS, exhausted: true };
  assert.notEqual(planPackages({ family: "mass", amount: 750 }, choices, work), null);
  assert.equal(work.exhausted, false);
  assert.ok(work.steps > 0 && work.steps < MAX_PACKAGE_SEARCH_STEPS);
  assert.deepEqual(choices, before);
  assert.equal(planPackages({ family: "mass", amount: 500 }, [], work), null);
  assert.deepEqual(work, { steps: 0, exhausted: false });
});

/**
 * Independent small-input oracle: enumerate every count vector with at most
 * twelve packets, without deduplication or waste/reach pruning. Tie-breaking
 * explicitly prefers lexicographically higher counts in stable size order;
 * it does not depend on the planner's traversal to find the expected answer.
 */
function exhaustive(need: BaseAmount, offered: PackageOption[]): PackagePlan | null {
  const choices = offered.filter((option) => option.size.family === need.family)
    .sort((a, b) => b.size.amount - a.size.amount);
  let best: { counts: number[]; total: number; used: number } | null = null;
  const counts = choices.map(() => 0);
  function enumerate(index: number, remaining: number): void {
    if (index < choices.length) {
      for (let count = 0; count <= remaining; count += 1) {
        counts[index] = count;
        enumerate(index + 1, remaining - count);
      }
      return;
    }
    const total = choices.reduce((sum, option, i) => sum + option.size.amount * counts[i]!, 0);
    const used = 12 - remaining;
    if (total < need.amount) return;
    if (best !== null) {
      if (total > best.total || (total === best.total && used > best.used)) return;
      if (total === best.total && used === best.used) {
        const firstDifference = counts.findIndex((count, i) => count !== best!.counts[i]);
        if (firstDifference < 0 || counts[firstDifference]! < best.counts[firstDifference]!) return;
      }
    }
    best = { counts: [...counts], total, used };
  }
  enumerate(0, 12);
  // TypeScript does not narrow assignments performed by the recursive closure.
  const result = best as { counts: number[]; total: number; used: number } | null;
  return result === null ? null : {
    picks: choices.map((option, i) => ({ key: option.key, count: result.counts[i]! }))
      .filter((pick) => pick.count > 0),
    total: result.total,
    waste: result.total - need.amount,
  };
}

test("500 deterministic small cases match exhaustive optimal quantities and EAN ties", () => {
  let seed = 260;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const families: UnitFamily[] = ["mass", "volume", "count"];
  for (let trial = 0; trial < 500; trial += 1) {
    const family = families[trial % families.length]!;
    // Binary fractions also cover fractional sizes without introducing a new
    // decimal-rounding policy into this work-budget change.
    const sizes = Array.from({ length: 1 + (next() >>> 16) % 4 }, () => (1 + (next() >>> 16) % 32) / 4);
    const choices = options(sizes, family);
    const need = { family, amount: (1 + (next() >>> 16) % 400) / 4 };
    const work = stats();
    assert.deepEqual(planPackages(need, choices, work), exhaustive(need, choices),
      JSON.stringify({ trial, need, sizes }));
    assert.equal(work.exhausted, false);
    assert.ok(work.steps <= MAX_PACKAGE_SEARCH_STEPS);
  }
});
