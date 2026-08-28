import assert from "node:assert/strict";
import test from "node:test";

import {
  alternativeGroup,
  alternativeSets,
  chosenAlternatives,
  normalizeGroups,
} from "../src/alternatives.ts";

/**
 * The rules behind a `tai` line (#183), tested straight.
 *
 * All four of them are decisions rather than arithmetic — what counts as a
 * group, where a group renders, which option gets bought, and what a save
 * writes down — so they are worth stating here rather than only through a
 * browser that would agree with any implementation that grouped *something*.
 */

interface Line {
  name: string;
  alternativeGroup: number | null;
}

function line(name: string, group: number | null = null): Line {
  return { name, alternativeGroup: group };
}

function names(lines: readonly Line[]): string[] {
  return lines.map((one) => one.name);
}

test("a group number is a positive whole number and nothing else", () => {
  assert.equal(alternativeGroup(1), 1);
  assert.equal(alternativeGroup("2"), 2);
  assert.equal(alternativeGroup(" 3 "), 3);

  assert.equal(alternativeGroup(null), null);
  assert.equal(alternativeGroup(undefined), null);
  assert.equal(alternativeGroup(0), null);
  assert.equal(alternativeGroup(-1), null);
  assert.equal(alternativeGroup(1.5), null);
  assert.equal(alternativeGroup(""), null);
  assert.equal(alternativeGroup("kaksi"), null);
  assert.equal(alternativeGroup(Number.NaN), null);
});

test("a plain line is its own set, in list order", () => {
  const sets = alternativeSets([line("voi"), line("suola")]);
  assert.deepEqual(sets.map((set) => names(set.options)), [["voi"], ["suola"]]);
  assert.deepEqual(sets.map((set) => set.group), [null, null]);
});

test("options sharing a number become one set", () => {
  const sets = alternativeSets([
    line("lihaliemikuutio", 1),
    line("fondiannos", 1),
    line("suola"),
  ]);

  assert.deepEqual(sets.map((set) => names(set.options)), [
    ["lihaliemikuutio", "fondiannos"],
    ["suola"],
  ]);
  assert.equal(sets[0]?.group, 1);
});

test("a set sits where its first option sits, however far apart they are", () => {
  const sets = alternativeSets([
    line("kerma", 1),
    line("suola"),
    line("kookosmaito", 1),
  ]);

  assert.deepEqual(sets.map((set) => names(set.options)), [
    ["kerma", "kookosmaito"],
    ["suola"],
  ]);
});

test("the shopping list buys the first option of a group and no other", () => {
  const kept = chosenAlternatives(
    [line("kerma", 1), line("kookosmaito", 1), line("suola")],
    () => "b1:r1",
  );

  assert.deepEqual(names(kept), ["kerma", "suola"]);
});

test("the same recipe cooked twice buys its choice twice", () => {
  const first = [line("kerma", 1), line("kookosmaito", 1)];
  const second = [line("kerma", 1), line("kookosmaito", 1)];
  const kept = chosenAlternatives(
    [...first, ...second],
    (one) => (first.includes(one) ? "b1:r1" : "b2:r1"),
  );

  assert.deepEqual(names(kept), ["kerma", "kerma"]);
});

test("a dish and its part may each use group 1 without colliding", () => {
  const dish = [line("voi", 1), line("margariini", 1)];
  const part = [line("kerma", 1), line("kookosmaito", 1)];
  const kept = chosenAlternatives(
    [...dish, ...part],
    (one) => (dish.includes(one) ? "b1:r1" : "b1:r2"),
  );

  assert.deepEqual(names(kept), ["voi", "kerma"]);
});

test("saving renumbers the groups from one, in order of first appearance", () => {
  const saved = normalizeGroups([
    line("kerma", 40),
    line("voi", 7),
    line("kookosmaito", 40),
    line("margariini", 7),
  ]);

  assert.deepEqual(saved.map((one) => one.alternativeGroup), [1, 2, 1, 2]);
});

test("a group of one is not a choice, so saving dissolves it", () => {
  const saved = normalizeGroups([line("kerma", 3), line("suola")]);

  assert.deepEqual(saved.map((one) => one.alternativeGroup), [null, null]);
});

test("dissolving a singleton does not renumber past it", () => {
  const saved = normalizeGroups([
    line("kerma", 5),
    line("voi", 9),
    line("margariini", 9),
  ]);

  assert.deepEqual(saved.map((one) => one.alternativeGroup), [null, 1, 1]);
});

test("normalizing leaves the lines it was given alone", () => {
  const original = [line("voi", 4), line("margariini", 4)];
  normalizeGroups(original);

  assert.deepEqual(original.map((one) => one.alternativeGroup), [4, 4]);
});
