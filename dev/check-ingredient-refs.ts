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
): StepIngredientRef => ({ ingredientId, matchedText, approxPosition });

/** The linked words, in order, as `id:text`. */
function mentions(text: string, refs: StepIngredientRef[]): string[] {
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
  const segments = resolveMentions(text, [
    ref(1, "tomaatit", 6),
    ref(2, "crème fraîche", 18),
  ]);

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
  assert.deepEqual(resolveMentions(text, [ref(1, "tomaatit", 6)]), [
    { kind: "text", text },
  ]);
});

test("case is folded, so a sentence-initial mention still matches", () => {
  assert.deepEqual(mentions("Tomaatit halkaistaan.", [ref(1, "tomaatit", 0)]), [
    "1:Tomaatit",
  ]);
});

test("two references landing on the same words keep only one", () => {
  const text = "Lisää crème fraîche.";
  // A stale reference to "crème" overlapping a live one to "crème fraîche".
  const segments = resolveMentions(text, [
    ref(1, "crème fraîche", 6),
    ref(2, "crème", 6),
  ]);
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
});

test("the form field round-trips and refuses junk", () => {
  const refs = [{ lineIndex: 2, matchedText: "kaali", approxPosition: 10 }];
  assert.deepEqual(decodeDraftRefs(encodeDraftRefs(refs)), refs);
  assert.equal(encodeDraftRefs([]), "");
  assert.deepEqual(decodeDraftRefs(""), []);
  assert.deepEqual(decodeDraftRefs("["), []);
  assert.deepEqual(decodeDraftRefs('[[1,"kaali"]]'), []);
  assert.deepEqual(decodeDraftRefs('[[-1,"kaali",0]]'), []);
});

test("a step may not carry an unbounded number of mentions", () => {
  const many = Array.from({ length: 40 }, (_, index) =>
    ref(index + 1, "suola", index),
  );
  assert.ok((serializeStepRefs(many) ?? "").length > 0);
  assert.equal(parseStepRefs(serializeStepRefs(many)).length, 12);
});
