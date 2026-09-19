import assert from "node:assert/strict";
import test from "node:test";

import type { CookHistory } from "../src/cook-history.ts";
import {
  askedSort,
  browseHref,
  cookLine,
  DEFAULT_SORT,
  searchKey,
  sortRecipes,
} from "../src/recipe-browser.ts";
import type { RecipeSummary } from "../src/recipe-read.ts";

/**
 * The shared recipe browser's own decisions (#307).
 *
 * Everything here is pure: what order a list comes out in, what a row says
 * about a household's cooking, and what address a chip leads to. The screens
 * themselves are `tests/recipe-browser.spec.ts`, which drives both places the
 * browser is used.
 */

function recipe(id: number, title: string, extra: Partial<RecipeSummary> = {}) {
  return {
    id,
    title,
    createdAt: "2026-01-01 00:00:00",
    createdBy: "Eero",
    yieldPortions: null,
    imageKey: null,
    householdId: 1,
    householdName: "Koti",
    publishedAt: null,
    shareCount: 0,
    categories: [],
    ...extra,
  } satisfies RecipeSummary;
}

const LASAGNE = recipe(1, "Lasagne");
const KEITTO = recipe(2, "Kaalikeitto");
const UUSI = recipe(3, "Uusi tuttavuus");

const HISTORY: CookHistory = new Map([
  [1, { times: 5, lastCooked: "2026-09-12" }],
  [2, { times: 1, lastCooked: "2026-02-03" }],
]);

const titles = (recipes: readonly RecipeSummary[]) =>
  recipes.map((one) => one.title);

test("the default order is the one the query already gave", () => {
  assert.deepEqual(
    titles(sortRecipes([LASAGNE, KEITTO, UUSI], DEFAULT_SORT, HISTORY)),
    ["Lasagne", "Kaalikeitto", "Uusi tuttavuus"],
  );
});

test("viimeksi kokatut puts the most recent cooking first", () => {
  assert.deepEqual(titles(sortRecipes([KEITTO, UUSI, LASAGNE], "kokattu", HISTORY)), [
    "Lasagne",
    "Kaalikeitto",
    // Never cooked is not recent, so it goes last rather than at either end
    // that a missing date would sort it to by accident.
    "Uusi tuttavuus",
  ]);
});

test("kauan kokkaamatta puts what has never been cooked first", () => {
  assert.deepEqual(
    titles(sortRecipes([LASAGNE, KEITTO, UUSI], "unohtuneet", HISTORY)),
    ["Uusi tuttavuus", "Kaalikeitto", "Lasagne"],
  );
});

test("recipes cooked alike keep the order they arrived in", () => {
  const a = recipe(10, "A");
  const b = recipe(11, "B");
  const same: CookHistory = new Map([
    [10, { times: 1, lastCooked: "2026-05-05" }],
    [11, { times: 2, lastCooked: "2026-05-05" }],
  ]);
  assert.deepEqual(titles(sortRecipes([a, b], "kokattu", same)), ["A", "B"]);
  assert.deepEqual(titles(sortRecipes([b, a], "kokattu", same)), ["B", "A"]);
});

test("an unknown order is the default one, not an error", () => {
  assert.equal(askedSort("kokattu"), "kokattu");
  assert.equal(askedSort("wellington"), DEFAULT_SORT);
  assert.equal(askedSort(null), DEFAULT_SORT);
});

test("a row says how many times this kitchen has cooked it", () => {
  assert.equal(cookLine(HISTORY, LASAGNE), "Kokattu 5× · viimeksi 12.9.");
  assert.equal(cookLine(HISTORY, KEITTO), "Kokattu 1× · viimeksi 3.2.");
  assert.equal(cookLine(HISTORY, UUSI), "Ei vielä kokattu");
});

test("the default order and an empty search leave the address bare", () => {
  assert.equal(
    browseHref({ path: "/recipes" }, { query: "", category: null, sort: DEFAULT_SORT }),
    "/recipes",
  );
});

test("one address carries the search, the category and the order together", () => {
  assert.equal(
    browseHref(
      { path: "/picker", carried: { date: "2026-09-21", slot: "dinner" } },
      { query: "kaali", category: "keitto", sort: "unohtuneet" },
    ),
    "/picker?date=2026-09-21&slot=dinner&q=kaali&kategoria=keitto&jarjestys=unohtuneet",
  );
});

test("the instant search matches a name whatever case it is typed in", () => {
  // Finnish folding, in memory, for the same reason the server's search is:
  // SQLite's case-insensitivity is ASCII-only, and Ä is not ASCII.
  assert.equal(searchKey(recipe(4, "Öljykastike")), "öljykastike koti");
  assert.ok(searchKey(recipe(5, "KAALI", { householdName: "Naapuri" })).includes("kaali"));
  // A shared recipe is findable by the household that shared it, too.
  assert.ok(searchKey(recipe(6, "Uunikala", { householdName: "Naapuri" })).includes("naapuri"));
});
