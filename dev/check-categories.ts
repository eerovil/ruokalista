import assert from "node:assert/strict";
import test from "node:test";

import {
  CATEGORIES,
  categoryFilter,
  categoryLabel,
  isCategorySlug,
  readCategories,
  sortCategories,
} from "../src/categories.ts";

/**
 * The category vocabulary and the list filter's links (#196).
 *
 * Everything here is a pure module, so it is checked here rather than through a
 * browser: what a form submits becomes what a row stores, and what a chip links
 * to is worked out from a query string. `tests/categories.spec.ts` covers the
 * screens themselves.
 */

function form(...categories: string[]): FormData {
  const data = new FormData();
  for (const category of categories) data.append("category", category);
  return data;
}

test("slugs are ASCII, so nothing downstream has to think about ä", () => {
  for (const category of CATEGORIES) {
    assert.match(category.slug, /^[a-z]+$/);
  }
});

test("a submitted form becomes the categories it ticked", () => {
  assert.deepEqual(readCategories(form("keitto", "pasta")), ["pasta", "keitto"]);
});

test("a value outside the vocabulary is dropped rather than refused", () => {
  // A checkbox cannot produce one, so this is a hand-written request or a form
  // left open across a release. Neither is worth a refusal in front of somebody
  // who did nothing wrong.
  assert.deepEqual(readCategories(form("pasta", "wellington")), ["pasta"]);
  assert.equal(isCategorySlug("wellington"), false);
});

test("the same category ticked twice is one category", () => {
  // The table's key is (recipe_id, category), so a duplicate would be a failed
  // insert in the middle of a save batch rather than a harmless repeat.
  assert.deepEqual(readCategories(form("lisuke", "lisuke")), ["lisuke"]);
});

test("categories come back in vocabulary order, not arrival order", () => {
  assert.deepEqual(sortCategories(["lisuke", "pasta", "keitto"]), [
    "pasta",
    "keitto",
    "lisuke",
  ]);
});

test("a label is Finnish and a slug is not", () => {
  assert.equal(categoryLabel("jalkiruoka"), "Jälkiruoka");
  // An unknown slug prints as itself rather than as an empty chip.
  assert.equal(categoryLabel("wellington"), "wellington");
});

test("a chip keeps the name search it was tapped from", () => {
  const markup = categoryFilter("/recipes", "kaali", null, ["keitto"]).value;
  assert.ok(markup.includes('href="/recipes?q=kaali&amp;kategoria=keitto"'));
  // Kaikki drops the category and keeps the search, which is the way back.
  assert.ok(markup.includes('href="/recipes?q=kaali"'));
});

test("Kaikki with no search is the bare list path", () => {
  const markup = categoryFilter("/recipes", "", null, ["pasta"]).value;
  assert.ok(markup.includes('href="/recipes"'));
});

test("only categories something in the list has get a chip", () => {
  const markup = categoryFilter("/recipes", "", null, ["pasta"]).value;
  assert.ok(markup.includes("Pasta"));
  // A chip leading to an empty screen makes the reader do the work of finding
  // out it was empty.
  assert.ok(!markup.includes("Keitto"));
});

test("the chip being stood on stays even once it matches nothing", () => {
  // Otherwise unticking the last recipe in a category would take away the only
  // marker of where the reader is, and the screen would read as broken.
  const markup = categoryFilter("/recipes", "", "keitto", []).value;
  assert.ok(markup.includes("Keitto"));
  assert.ok(markup.includes('aria-current="page"'));
});

test("a list with nothing categorised offers no filter at all", () => {
  assert.equal(categoryFilter("/recipes", "", null, []).value, "");
});
