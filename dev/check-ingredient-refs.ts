import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeDraftRefs,
  encodeDraftRefs,
  mentionResolves,
  parseStepRefs,
  resolveMentions,
  serializeStepRefs,
  type StepIngredientRef,
} from "../src/ingredient-refs.ts";
import { amountsByIngredient, type RecipeLine } from "../src/recipes.ts";

/**
 * The resolver is the part of issue #120 that has to be right without anybody
 * watching: it runs on every step of every recipe, against text that has been
 * edited since the links were made. Its two failure modes are opposite and
 * only one of them is acceptable — losing a link is a mention that reads as
 * ordinary text, while placing one wrongly puts the wrong amount into a
 * sentence somebody is cooking from.
 */

const ref = (
  ingredientId: number,
  matchedText: string,
  approxPosition: number,
): StepIngredientRef => ({
  ingredientId,
  matchedText,
  approxPosition,
});

/** The linked words, in order, as `id:text`. */
function mentions(
  text: string,
  refs: StepIngredientRef[],
): string[] {
  return resolveMentions(text, refs)
    .filter((segment) => segment.kind === "mention")
    .map((segment) =>
      segment.kind === "mention"
        ? `${segment.ingredientId}:${segment.text}`
        : "",
    );
}

test("the segments put the text back together exactly", () => {
  const text = "Lisää tomaatit ja crème fraîche ja keitä muutama minuutti.";
  const twoRefs = [ref(1, "tomaatit", 6), ref(2, "crème fraîche", 18)];
  const segments = resolveMentions(text, twoRefs);

  assert.equal(segments.map((segment) => segment.text).join(""), text);
  assert.deepEqual(mentions(text, [ref(1, "tomaatit", 6), ref(2, "crème fraîche", 18)]), [
    "1:tomaatit",
    "2:crème fraîche",
  ]);
});

test("an edit earlier in the sentence still resolves the same word", () => {
  // The step was linked as "Lisää tomaatit…", then somebody put a clause in
  // front of it. Every position after that point moved, and the reference did
  // not — which is the whole reason it is approximate.
  const edited = "Kun kastike kiehuu, lisää tomaatit ja keitä hetki.";
  assert.deepEqual(mentions(edited, [ref(1, "tomaatit", 6)]), ["1:tomaatit"]);
});

test("the occurrence nearest the recorded position wins", () => {
  const text = "Kuullota sipuli, lisää sipuli ja paista.";
  assert.deepEqual(mentions(text, [ref(1, "sipuli", 23)]), ["1:sipuli"]);

  const segments = resolveMentions(text, [ref(1, "sipuli", 23)]);
  // The second one, not the first: the text before it is the whole first
  // clause, and the text after it is only what follows the second.
  assert.equal(segments[0]?.text, "Kuullota sipuli, lisää ");
});

test("wording that is no longer in the step is left unlinked", () => {
  const text = "Lisää kasvikset ja keitä.";
  assert.deepEqual(mentions(text, [ref(1, "tomaatit", 6)]), []);
  assert.deepEqual(
    resolveMentions(text, [ref(1, "tomaatit", 6)]),
    [{ kind: "text", text }],
  );
});

test("a word that only contains the wording is not a match", () => {
  // The step was linked while it read "Lisää suola." and has since been edited.
  // A plain substring search would still find "suola" inside "suolakurkut" and
  // put the salt amount in the middle of a word about gherkins.
  assert.deepEqual(mentions("Lisää suolakurkut.", [ref(1, "suola", 6)]), []);
  // The same on the other side, and with a Finnish letter as the neighbour —
  // an ASCII-only boundary rule would call "ö" a boundary and match here.
  assert.deepEqual(mentions("Lisää merisuola.", [ref(1, "suola", 6)]), []);
  assert.deepEqual(mentions("Lisää suolaöljy.", [ref(1, "suola", 6)]), []);
  assert.deepEqual(mentions("Lisää suola2.", [ref(1, "suola", 6)]), []);

  // The word on its own still resolves, next to a space or any punctuation.
  assert.deepEqual(mentions("Lisää suola.", [ref(1, "suola", 6)]), ["1:suola"]);
  assert.deepEqual(mentions("Lisää suola, hyvin.", [ref(1, "suola", 6)]), [
    "1:suola",
  ]);
  assert.deepEqual(mentions("Suola sekaan.", [ref(1, "suola", 0)]), ["1:Suola"]);
});

test("the stored wording is matched as written, inflection and all", () => {
  // The model records what the step said, so an inflected form is the needle
  // rather than something derived from the ingredient's name.
  assert.deepEqual(mentions("Lisää tomaatteja.", [ref(1, "tomaatteja", 6)]), [
    "1:tomaatteja",
  ]);
  // And a step re-inflected after the link was made loses it rather than
  // guessing — the harmless half of the same rule.
  assert.deepEqual(mentions("Lisää tomaatteja.", [ref(1, "tomaatit", 6)]), []);
});

test("wording that carries its own punctuation is not held to a boundary", () => {
  // Only the sides where the needle itself ends in a word character are
  // checked, so a reference that brought a bracket along still resolves.
  assert.deepEqual(
    mentions("Käytä (valkokaali) tässä.", [ref(1, "(valkokaali)", 6)]),
    ["1:(valkokaali)"],
  );
});

test("case is folded, so a sentence-initial mention still matches", () => {
  assert.deepEqual(mentions("Tomaatit halkaistaan.", [ref(1, "tomaatit", 0)]), [
    "1:Tomaatit",
  ]);
});

test("two references landing on the same words keep only one", () => {
  const text = "Lisää crème fraîche.";
  // A stale reference to "crème" overlapping a live one to "crème fraîche".
  const overlapping = [ref(1, "crème fraîche", 6), ref(2, "crème", 6)];
  const segments = resolveMentions(text, overlapping);
  assert.deepEqual(
    segments.filter((segment) => segment.kind === "mention").length,
    1,
  );
  assert.equal(segments.map((segment) => segment.text).join(""), text);
});

test("an empty or blank matched text never links anything", () => {
  assert.deepEqual(mentions("Lisää suola.", [ref(1, "", 0)]), []);
  assert.equal(mentionResolves("Lisää suola.", "   "), false);
  assert.equal(mentionResolves("Lisää suola.", "suola"), true);
});

function line(
  position: number,
  ingredientId: number,
  quantity: number | null,
  unit: string | null,
): RecipeLine {
  return {
    position,
    ingredientId,
    quantity,
    quantityMax: null,
    unit,
    altQuantity: null,
    altUnit: null,
    ingredient: "öljy",
    sourceLine: "",
    phase: null,
  };
}

test("duplicate ingredient lines join every distinct amount", () => {
  const amounts = amountsByIngredient(
    [line(1, 7, 2, "rkl"), line(2, 7, 1, "dl")],
    null,
  );
  assert.equal(amounts.get(7), "2 rkl / 1 dl");
});

test("blank amounts do not create empty pieces", () => {
  const amounts = amountsByIngredient(
    [line(1, 7, 2, "rkl"), line(2, 7, null, null)],
    null,
  );
  assert.equal(amounts.get(7), "2 rkl");
  assert.equal(amountsByIngredient([line(1, 8, null, null)], null).has(8), false);
});

test("identical amounts on duplicate lines appear once", () => {
  const amounts = amountsByIngredient(
    [line(1, 7, 2, "rkl"), line(2, 7, 2, "rkl")],
    null,
  );
  assert.equal(amounts.get(7), "2 rkl");
});

test("the saved column round-trips, and an empty list is NULL", () => {
  const refs = [ref(7, "tomaatit", 6), ref(9, "crème fraîche", 18)];
  const stored = serializeStepRefs(refs);
  assert.notEqual(stored, null);
  assert.deepEqual(parseStepRefs(stored), refs);
  assert.equal(serializeStepRefs([]), null);
  assert.deepEqual(parseStepRefs(null), []);
});

test("a malformed column reads as no references rather than throwing", () => {
  assert.deepEqual(parseStepRefs("not json at all"), []);
  assert.deepEqual(parseStepRefs('{"ingredientId":1}'), []);
  assert.deepEqual(
    parseStepRefs('[{"ingredientId":0,"matchedText":"x","approxPosition":1}]'),
    [],
  );
  assert.deepEqual(
    parseStepRefs('[{"ingredientId":1,"matchedText":"","approxPosition":1}]'),
    [],
  );
  assert.deepEqual(
    parseStepRefs('[{"ingredientId":1,"matchedText":"x","approxPosition":-1}]'),
    [],
  );
  assert.deepEqual(
    parseStepRefs('[{"ingredientId":1,"matchedText":"x","approxPosition":1}]'),
    [ref(1, "x", 1)],
  );
});

test("the form field round-trips and refuses junk", () => {
  const refs = [
    { lineIndex: 2, matchedText: "kaali", approxPosition: 10, expectedIngredientId: 3 },
  ];
  assert.deepEqual(decodeDraftRefs(encodeDraftRefs(refs)), refs);

  // An import's reference has no ingredient to expect, and null is a value
  // here rather than a missing field.
  const fromImport = [
    { lineIndex: 0, matchedText: "kaali", approxPosition: 9, expectedIngredientId: null },
  ];
  assert.deepEqual(decodeDraftRefs(encodeDraftRefs(fromImport)), fromImport);

  assert.equal(encodeDraftRefs([]), "");
  assert.deepEqual(decodeDraftRefs(""), []);
  assert.deepEqual(decodeDraftRefs("["), []);
  assert.deepEqual(decodeDraftRefs('[[1,"kaali"]]'), []);
  assert.deepEqual(decodeDraftRefs('[[1,"kaali",0]]'), []);
  assert.deepEqual(decodeDraftRefs('[[-1,"kaali",0,3]]'), []);
  assert.deepEqual(decodeDraftRefs('[[1,"kaali",0,0]]'), []);
  assert.deepEqual(decodeDraftRefs('[[1,"kaali",0,"3"]]'), []);
});

test("a step may not carry an unbounded number of mentions", () => {
  const many = Array.from({ length: 40 }, (_, index) =>
    ref(index + 1, "suola", index),
  );
  assert.ok((serializeStepRefs(many) ?? "").length > 0);
  assert.equal(parseStepRefs(serializeStepRefs(many)).length, 12);
});
