import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeDraftRefs,
  encodeDraftRefs,
  lineForRef,
  mentionResolves,
  parseStepRefs,
  resolveMentions,
  serializeStepRefs,
  type RefLine,
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
  linePosition: number = ingredientId,
): StepIngredientRef => ({
  ingredientId,
  linePosition,
  matchedText,
  approxPosition,
});

/**
 * The recipe these references would make sense against: one line each, sitting
 * exactly where the reference says it is. Tests about *which line* a reference
 * finds pass their own list instead.
 */
function linesFrom(refs: StepIngredientRef[]): RefLine[] {
  const lines = new Map<number, RefLine>();
  for (const one of refs) {
    lines.set(one.linePosition, {
      position: one.linePosition,
      ingredientId: one.ingredientId,
    });
  }
  return [...lines.values()];
}

/** The linked words, in order, as `id:text`. */
function mentions(
  text: string,
  refs: StepIngredientRef[],
  lines: RefLine[] = linesFrom(refs),
): string[] {
  return resolveMentions(text, refs, lines)
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
  const segments = resolveMentions(text, twoRefs, linesFrom(twoRefs));

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

  const segments = resolveMentions(text, [ref(1, "sipuli", 23)], linesFrom([ref(1, "sipuli", 23)]));
  // The second one, not the first: the text before it is the whole first
  // clause, and the text after it is only what follows the second.
  assert.equal(segments[0]?.text, "Kuullota sipuli, lisää ");
});

test("wording that is no longer in the step is left unlinked", () => {
  const text = "Lisää kasvikset ja keitä.";
  assert.deepEqual(mentions(text, [ref(1, "tomaatit", 6)]), []);
  assert.deepEqual(
    resolveMentions(text, [ref(1, "tomaatit", 6)], linesFrom([ref(1, "tomaatit", 6)])),
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
  const segments = resolveMentions(text, overlapping, linesFrom(overlapping));
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

/**
 * A recipe may list one ingredient twice, at two amounts, for two stages of the
 * cooking. Nothing in the schema stops it and nothing should — so a mention has
 * to name a *line*, not an ingredient, or the second mention would show the
 * first line's figure and read as an instruction rather than as a broken link.
 */
test("two lines of the same ingredient keep their own mentions apart", () => {
  // Salt at position 2 and again at position 4.
  const lines: RefLine[] = [
    { position: 1, ingredientId: 9 },
    { position: 2, ingredientId: 7 },
    { position: 3, ingredientId: 8 },
    { position: 4, ingredientId: 7 },
  ];

  assert.deepEqual(lineForRef({ ingredientId: 7, linePosition: 2 }, lines), {
    position: 2,
    ingredientId: 7,
  });
  assert.deepEqual(lineForRef({ ingredientId: 7, linePosition: 4 }, lines), {
    position: 4,
    ingredientId: 7,
  });

  // And through the resolver, which is what the screen actually calls.
  const segments = resolveMentions(
    "Suolaa taikina ja suolaa kastike.",
    [ref(7, "Suolaa", 0, 2), ref(7, "suolaa", 17, 4)],
    lines,
  );
  const linked = segments.filter((segment) => segment.kind === "mention");
  assert.deepEqual(
    linked.map((segment) =>
      segment.kind === "mention" ? segment.linePosition : 0,
    ),
    [2, 4],
  );
});

test("reordering keeps a mention of an ingredient listed only once", () => {
  // The line moved from position 3 to position 1. There is no second candidate,
  // so which line was meant is not in doubt and the mention survives.
  const lines: RefLine[] = [
    { position: 1, ingredientId: 7 },
    { position: 2, ingredientId: 9 },
  ];
  assert.deepEqual(lineForRef({ ingredientId: 7, linePosition: 3 }, lines), {
    position: 1,
    ingredientId: 7,
  });
});

test("an ambiguous reference resolves to nothing rather than guessing", () => {
  const lines: RefLine[] = [
    { position: 1, ingredientId: 7 },
    { position: 2, ingredientId: 7 },
  ];
  // The recorded position now holds a different ingredient — or nothing at all
  // — and two lines could be meant. Picking one would be a confident lie.
  assert.equal(lineForRef({ ingredientId: 7, linePosition: 5 }, lines), null);
  assert.deepEqual(
    mentions("Lisää suola.", [ref(7, "suola", 6, 5)], lines),
    [],
  );

  // An ingredient no longer on the recipe at all is the same answer.
  assert.equal(lineForRef({ ingredientId: 99, linePosition: 1 }, lines), null);
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
    parseStepRefs('[{"ingredientId":0,"linePosition":1,"matchedText":"x","approxPosition":1}]'),
    [],
  );
  assert.deepEqual(
    parseStepRefs('[{"ingredientId":1,"linePosition":1,"matchedText":"","approxPosition":1}]'),
    [],
  );
  assert.deepEqual(
    parseStepRefs('[{"ingredientId":1,"linePosition":1,"matchedText":"x","approxPosition":-1}]'),
    [],
  );
  // A reference that cannot say which line it means is not a reference. The
  // column ships with this change, so there is no older shape to accept.
  assert.deepEqual(
    parseStepRefs('[{"ingredientId":1,"matchedText":"x","approxPosition":1}]'),
    [],
  );
  assert.deepEqual(
    parseStepRefs('[{"ingredientId":1,"linePosition":0,"matchedText":"x","approxPosition":1}]'),
    [],
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
