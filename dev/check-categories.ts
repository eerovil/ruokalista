import assert from "node:assert/strict";
import test from "node:test";

import {
  Vocabulary,
  categoryBulkControls,
  categoryFilter,
} from "../src/categories.ts";
import { doneNotice } from "../src/category-bulk.ts";
import { slugFor } from "../src/category-admin.ts";

/**
 * The category vocabulary, the list filter's links, and the slug an admin's
 * typed label becomes (#196, #199).
 *
 * Everything here is pure, so it is checked here rather than through a browser:
 * what a form submits becomes what a row stores, what a chip links to is worked
 * out from a query string, and a slug is worked out from a word.
 * `tests/categories.spec.ts` covers the screens themselves.
 *
 * The vocabulary is a table since #199, so these build one by hand rather than
 * importing a constant. It is the same nine the migration seeds.
 */

const VOCABULARY = new Vocabulary([
  { slug: "pasta", label: "Pasta" },
  { slug: "keitto", label: "Keitto" },
  { slug: "salaatti", label: "Salaatti" },
  { slug: "uuniruoka", label: "Uuniruoka" },
  { slug: "kastike", label: "Kastike" },
  { slug: "pizza-piirakka", label: "Pizza/piirakka" },
  { slug: "leivonta", label: "Leivonta" },
  { slug: "jalkiruoka", label: "Jälkiruoka" },
  { slug: "lisuke", label: "Lisuke" },
]);

function form(...categories: string[]): FormData {
  const data = new FormData();
  for (const category of categories) data.append("category", category);
  return data;
}

test("slugs are ASCII, so nothing downstream has to think about ä", () => {
  for (const category of VOCABULARY.categories) {
    assert.match(category.slug, /^[a-z0-9-]+$/);
  }
});

test("a submitted form becomes the categories it ticked", () => {
  assert.deepEqual(VOCABULARY.read(form("keitto", "pasta")), ["pasta", "keitto"]);
});

test("a value outside the vocabulary is dropped rather than refused", () => {
  // A checkbox cannot produce one, so this is a hand-written request or a form
  // left open across a release. Neither is worth a refusal in front of somebody
  // who did nothing wrong.
  assert.deepEqual(VOCABULARY.read(form("pasta", "wellington")), ["pasta"]);
  assert.equal(VOCABULARY.has("wellington"), false);
});

test("the same category ticked twice is one category", () => {
  // The table's key is (recipe_id, category), so a duplicate would be a failed
  // insert in the middle of a save batch rather than a harmless repeat.
  assert.deepEqual(VOCABULARY.read(form("lisuke", "lisuke")), ["lisuke"]);
});

test("categories come back in vocabulary order, not arrival order", () => {
  assert.deepEqual(VOCABULARY.sort(["lisuke", "pasta", "keitto"]), [
    "pasta",
    "keitto",
    "lisuke",
  ]);
});

test("a label is Finnish and a slug is not", () => {
  assert.equal(VOCABULARY.label("jalkiruoka"), "Jälkiruoka");
  // An unknown slug prints as itself rather than as an empty chip.
  assert.equal(VOCABULARY.label("wellington"), "wellington");
});

test("a chip keeps the name search it was tapped from", () => {
  const markup = categoryFilter(VOCABULARY, "/recipes", "kaali", null, ["keitto"]).value;
  assert.ok(markup.includes('href="/recipes?q=kaali&amp;kategoria=keitto"'));
  // Kaikki drops the category and keeps the search, which is the way back.
  assert.ok(markup.includes('href="/recipes?q=kaali"'));
});

test("Kaikki with no search is the bare list path", () => {
  const markup = categoryFilter(VOCABULARY, "/recipes", "", null, ["pasta"]).value;
  assert.ok(markup.includes('href="/recipes"'));
});

test("only categories something in the list has get a chip", () => {
  const markup = categoryFilter(VOCABULARY, "/recipes", "", null, ["pasta"]).value;
  assert.ok(markup.includes("Pasta"));
  // A chip leading to an empty screen makes the reader do the work of finding
  // out it was empty.
  assert.ok(!markup.includes("Keitto"));
});

test("the chip being stood on stays even once it matches nothing", () => {
  // Otherwise unticking the last recipe in a category would take away the only
  // marker of where the reader is, and the screen would read as broken.
  const markup = categoryFilter(VOCABULARY, "/recipes", "", "keitto", []).value;
  assert.ok(markup.includes("Keitto"));
  assert.ok(markup.includes('aria-current="page"'));
});

test("a list with nothing categorised offers no filter at all", () => {
  assert.equal(categoryFilter(VOCABULARY, "/recipes", "", null, []).value, "");
});

/**
 * What a bulk category edit says it did (#199).
 *
 * The sentence is the whole feedback a member gets, so it is checked here
 * rather than only through the two browser cases that happen to render one.
 */

test("a bulk add counts what moved, not what was ticked", () => {
  assert.equal(
    doneNotice(VOCABULARY, "add", "keitto", { changed: ["A", "B"], unchanged: [] }).message,
    "Kategoria Keitto lisättiin 2 reseptille.",
  );
  assert.equal(
    doneNotice(VOCABULARY, "add", "keitto", { changed: ["A"], unchanged: ["B", "C"] })
      .message,
    "Kategoria Keitto lisättiin yhdelle reseptille. 2 reseptillä se oli jo.",
  );
});

test("a bulk removal says so in its own words", () => {
  assert.equal(
    doneNotice(VOCABULARY, "remove", "lisuke", { changed: ["A"], unchanged: [] }).message,
    "Kategoria Lisuke poistettiin yhdeltä reseptiltä.",
  );
  assert.equal(
    doneNotice(VOCABULARY, "remove", "lisuke", { changed: ["A", "B"], unchanged: ["C"] })
      .message,
    "Kategoria Lisuke poistettiin 2 reseptiltä. 1 reseptillä sitä ei ollut.",
  );
});

test("nothing moved is said plainly, and is not a refusal", () => {
  const added = doneNotice(VOCABULARY, "add", "pasta", { changed: [], unchanged: ["A"] });
  assert.equal(added.message, "Valituilla resepteillä oli jo kategoria Pasta.");
  assert.equal(added.refused, false);

  assert.equal(
    doneNotice(VOCABULARY, "remove", "pasta", { changed: [], unchanged: ["A"] }).message,
    "Valituilla resepteillä ei ollut kategoriaa Pasta.",
  );
});

test("the bulk control keeps the category that was chosen", () => {
  const markup = categoryBulkControls(VOCABULARY, "keitto").value;
  // `selected` sits inside the Keitto option and no other: after that option
  // opens and before the next one does.
  assert.ok(
    markup.indexOf('value="keitto"') <
      markup.indexOf("selected") &&
      markup.indexOf("selected") < markup.indexOf('value="salaatti"'),
  );
  // And offers every category, whichever one is standing selected.
  for (const category of VOCABULARY.categories) {
    assert.ok(markup.includes(`value="${category.slug}"`));
  }
});

test("with nothing chosen the control selects nothing", () => {
  assert.ok(!categoryBulkControls(VOCABULARY, null).value.includes("selected"));
});

/**
 * The slug an admin's typed label becomes (#199).
 *
 * It is the identity a recipe stores, so it is derived once and never again —
 * which makes getting the derivation right the whole of the safety here.
 */

test("a Finnish label folds to an ASCII slug", () => {
  assert.equal(slugFor("Jälkiruoka"), "jalkiruoka");
  assert.equal(slugFor("Uuniruoka"), "uuniruoka");
  // Folded, not dropped: `jalkiruoka` and never `jlkiruoka`.
  assert.ok(slugFor("Jälkiruoka").startsWith("jalki"));
});

test("punctuation becomes one hyphen, and never a leading or trailing one", () => {
  assert.equal(slugFor("Pizza/piirakka"), "pizza-piirakka");
  assert.equal(slugFor("  Wokki  "), "wokki");
  assert.equal(slugFor("Pata / laatikko"), "pata-laatikko");
  assert.equal(slugFor("Aamupala & välipala"), "aamupala-valipala");
});

test("a label with nothing to slug has no slug", () => {
  // The caller refuses on this rather than storing an empty identifier.
  assert.equal(slugFor("///"), "");
  assert.equal(slugFor(""), "");
});

test("a slug is stable under a later rename", () => {
  // The point of deriving once: renaming the label must not move the identity,
  // or every recipe carrying it would have to be rewritten.
  const first = slugFor("Kastike");
  assert.equal(first, "kastike");
  assert.notEqual(slugFor("Kastikkeet"), first);
});
