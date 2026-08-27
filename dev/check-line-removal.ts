import assert from "node:assert/strict";
import test from "node:test";

import { encodeDraftRefs } from "../src/ingredient-refs.ts";
import type { LineFormValues, StepFormValues } from "../src/line-form.ts";
import { removalConflicts } from "../src/line-removal.ts";

/**
 * The guard that stops a one-tap removal leaving the preparation steps talking
 * about an ingredient the recipe no longer lists (issue #128).
 *
 * It is a rule over form values and the step links, so it is all visible here:
 * no browser, no database, and every way out of the refusal spelled out.
 */

const INGREDIENTS = [
  { id: 1, name: "öljy" },
  { id: 3, name: "valkokaali" },
  { id: 4, name: "sitruunaruoho" },
];

function row(
  ingredientChoice: string,
  extra: Partial<LineFormValues> = {},
): LineFormValues {
  return {
    position: "",
    quantity: "",
    quantityMax: "",
    unit: "",
    altQuantity: "",
    altUnit: "",
    section: "",
    phase: "",
    ingredientChoice,
    newName: "",
    sourceLine: "",
    note: "",
    remove: false,
    ...extra,
  };
}

function step(
  text: string,
  refs: Array<{ lineIndex: number; matchedText: string; ingredientId: number | null }>,
): StepFormValues {
  return {
    index: 0,
    position: "",
    text,
    section: "",
    phase: "",
    refs: encodeDraftRefs(
      refs.map((ref) => ({
        lineIndex: ref.lineIndex,
        matchedText: ref.matchedText,
        approxPosition: Math.max(0, text.indexOf(ref.matchedText)),
        expectedIngredientId: ref.ingredientId,
      })),
    ),
  };
}

const KUULLOTA = step("Kuullota kaali öljyssä.", [
  { lineIndex: 2, matchedText: "kaali", ingredientId: 3 },
  { lineIndex: 0, matchedText: "öljyssä", ingredientId: 1 },
]);

test("removing an ingredient a step still names is refused", () => {
  const conflicts = removalConflicts(
    [row("1", { remove: true }), row("3")],
    [KUULLOTA],
    INGREDIENTS,
  );

  assert.deepEqual(conflicts.map((one) => one.name), ["öljy"]);
  assert.deepEqual(conflicts[0]?.steps.map((one) => one.number), [1]);
  assert.deepEqual(conflicts[0]?.steps[0]?.mentions, ["öljyssä"]);
});

test("removing an ingredient nothing names goes through", () => {
  assert.deepEqual(
    removalConflicts(
      [row("1"), row("3"), row("4", { remove: true })],
      [KUULLOTA],
      INGREDIENTS,
    ),
    [],
  );
});

test("a step edited to drop the wording stops being a reason to refuse", () => {
  // The link is still on the form — nothing asks a member to maintain those —
  // but the words it points at are gone, so it is not a mention any more. This
  // is how somebody gets out of the refusal.
  const edited: StepFormValues = { ...KUULLOTA, text: "Kuullota kaali." };

  assert.deepEqual(
    removalConflicts([row("1", { remove: true }), row("3")], [edited], INGREDIENTS),
    [],
  );
});

test("another row carrying the same ingredient keeps the removal safe", () => {
  // The mention still has an amount to reveal, which is the same rule the save
  // itself applies when it decides whether a reference survives.
  assert.deepEqual(
    removalConflicts(
      [row("1", { remove: true }), row("1"), row("3")],
      [KUULLOTA],
      INGREDIENTS,
    ),
    [],
  );
});

test("repointing and removing a linked row still guards the saved ingredient", () => {
  const linked = step("Mausta sitruunaruoholla.", [
    { lineIndex: 2, matchedText: "sitruunaruoholla", ingredientId: 4 },
  ]);

  const conflicts = removalConflicts(
    [row("1"), row("3"), row("3", { remove: true })],
    [linked],
    INGREDIENTS,
  );

  assert.deepEqual(conflicts.map((one) => one.name), ["sitruunaruoho"]);
  assert.deepEqual(conflicts[0]?.steps[0]?.mentions, ["sitruunaruoholla"]);
});

test("every mentioning step is named, not just the first", () => {
  const second = step("Mausta kaalilla uudelleen.", [
    { lineIndex: 2, matchedText: "kaalilla", ingredientId: 3 },
  ]);

  const conflicts = removalConflicts(
    [row("1"), row("3", { remove: true })],
    [KUULLOTA, second],
    INGREDIENTS,
  );

  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0]?.steps.map((one) => one.number), [1, 2]);
});

test("two removals in one save are reported separately", () => {
  const conflicts = removalConflicts(
    [row("1", { remove: true }), row("3", { remove: true })],
    [KUULLOTA],
    INGREDIENTS,
  );

  assert.deepEqual(conflicts.map((one) => one.name), ["öljy", "valkokaali"]);
});

test("a mention of a word inside a longer word is not a mention", () => {
  // The same word-boundary rule the reveal itself uses: "suola" does not occur
  // in "suolakurkut", so removing salt is not held up by a gherkin.
  const gherkins = step("Lisää suolakurkut.", [
    { lineIndex: 0, matchedText: "suola", ingredientId: 1 },
  ]);

  assert.deepEqual(
    removalConflicts([row("1", { remove: true })], [gherkins], INGREDIENTS),
    [],
  );
});

test("an imported row with no ingredient yet is matched by its row index", () => {
  // Intake's links carry no id, because none exists during an import. They are
  // resolved through the row they point at instead.
  const imported = step("Kuullota kaali.", [
    { lineIndex: 1, matchedText: "kaali", ingredientId: null },
  ]);

  const conflicts = removalConflicts(
    [row(""), row("", { remove: true, newName: "valkokaali" })],
    [imported],
    INGREDIENTS,
  );

  assert.deepEqual(conflicts.map((one) => one.name), ["valkokaali"]);
});
