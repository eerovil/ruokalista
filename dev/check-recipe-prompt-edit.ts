import assert from "node:assert/strict";
import test from "node:test";

import type { Draft } from "../src/intake.ts";
import {
  editRequestFor,
  proposalChanges,
  proposalForm,
  proposalForRecipe,
  PromptRefused,
  readInstruction,
  recipeWire,
} from "../src/recipe-prompt-edit.ts";
import type { Recipe } from "../src/recipes.ts";

/**
 * What a prompt edit (#208) asks the model, and what it does with the answer.
 *
 * None of this needs a paid call. The two things worth getting right are that
 * the model is handed the *current* recipe rather than nothing, and that the
 * proposal reaches the ordinary editor as ordinary form fields — so the review
 * a member corrects and the recipe a save writes are the same thing.
 */

const NO_INGREDIENTS: [] = [];

function line(over: Partial<Recipe["lines"][number]> = {}) {
  return {
    position: 1,
    quantity: 2,
    quantityMax: null,
    unit: "dl",
    altQuantity: null,
    altUnit: null,
    ingredientId: 7,
    ingredient: "kerma",
    productImageUrl: null,
    sourceLine: "2 dl kermaa",
    phase: null,
    alternativeGroup: null,
    ...over,
  };
}

function recipe(over: Partial<Recipe> = {}): Recipe {
  return {
    id: 5,
    title: "Uunikaali",
    createdAt: "2026-01-01",
    createdBy: "Eero",
    yieldPortions: 4,
    imageKey: null,
    householdId: 1,
    householdName: "Koti",
    publishedAt: null,
    shareCount: 0,
    categories: ["uuniruoka"],
    sourceText: "Uunikaali\n2 dl kermaa",
    sourceRoute: "pasted",
    sourceUrl: null,
    revision: 3,
    steps: [{ text: "Kaada kerma kaalin päälle.", phase: null, refs: [] }],
    lines: [line()],
    parentId: null,
    parts: [],
    ...over,
  } as Recipe;
}

function draft(over: Partial<Draft> = {}): Draft {
  return {
    title: "Uunikaali",
    yieldPortions: 4,
    sourceText: "Uunikaali\n2 dl kermaa",
    structuredBy: "claude-sonnet-5",
    steps: [{ text: "Kaada kerma kaalin päälle.", section: null, phase: null, refs: [] }],
    lines: [
      {
        quantity: 2,
        quantityMax: null,
        unit: "dl",
        altQuantity: null,
        altUnit: null,
        ingredientId: 7,
        ingredientName: "kerma",
        sourceLine: "2 dl kermaa",
        section: null,
        phase: null,
        alternativeGroup: null,
        note: null,
      },
    ],
    ...over,
  };
}

// ------------------------------------------------------------ the request

test("the model is handed the current recipe, not an empty page", () => {
  const content = editRequestFor(
    recipe(),
    "Lisää salaatti lisukkeeksi.",
    NO_INGREDIENTS,
  ).messages[0].content;

  assert.match(content, /Nykyinen resepti:/);
  assert.match(content, /"title": "Uunikaali"/);
  assert.match(content, /"ingredient_name": "kerma"/);
  assert.match(content, /"ingredient_id": 7/);
  // The change request is last, where it reads as the instruction.
  assert.match(content, /Käyttäjän muutospyyntö:\n\nLisää salaatti lisukkeeksi\.$/);
});

test("the recipe's own source text rides along as background", () => {
  const content = editRequestFor(recipe(), "Täydennä ohje.", NO_INGREDIENTS)
    .messages[0].content;

  assert.match(content, /alkuperäinen lähdeteksti/);
  assert.match(content, /2 dl kermaa/);
});

test("the named parts are named as somebody else's screen", () => {
  const withParts = recipe({
    parts: [recipe({ id: 6, title: "Juustokastike", parts: [] })],
  });
  const content = editRequestFor(withParts, "Lisää lisuke.", NO_INGREDIENTS)
    .messages[0].content;

  assert.match(content, /nimetyt osat, joita tämä pyyntö ei muokkaa/);
  assert.match(content, /- Juustokastike/);
});

test("the standing rules say what may not move", () => {
  const system = editRequestFor(recipe(), "Lisää lisuke.", NO_INGREDIENTS).system;

  assert.match(system, /Muuta vain se, mitä muutospyyntö pyytää/);
  assert.match(system, /Älä nimeä reseptiä uudelleen/);
  assert.match(system, /Älä kirjoita valmistusohjetta uusiksi/);
  assert.match(system, /section on aina null/);
  // The draft's own shape rules are the intake ones, not a second copy.
  assert.match(system, /Säännöt, joista ei poiketa:/);
  assert.match(system, /Talouden hyväksytyt ainekset/);
});

test("a dish with no parts is told there is no cooking order", () => {
  assert.match(
    editRequestFor(recipe(), "Lisää lisuke.", NO_INGREDIENTS).system,
    /phase on aina null/,
  );
  assert.doesNotMatch(
    editRequestFor(
      recipe({ parts: [recipe({ id: 6, title: "Osa", parts: [] })] }),
      "Lisää lisuke.",
      NO_INGREDIENTS,
    ).system,
    /phase on aina null/,
  );
});

test("a saved step's mention is offered back as a line index", () => {
  const wire = recipeWire(
    recipe({
      steps: [
        {
          text: "Kaada kerma kaalin päälle.",
          phase: null,
          refs: [{ ingredientId: 7, matchedText: "kerma", approxPosition: 6 }],
        },
      ],
    }),
  ) as { steps: Array<{ ingredient_refs: unknown[] }> };

  assert.deepEqual(wire.steps[0]!.ingredient_refs, [
    { line: 0, matched_text: "kerma", approx_position: 6 },
  ]);
});

test("source_text is not asked back, because it would be discarded", () => {
  const wire = recipeWire(recipe()) as { source_text: string };
  assert.equal(wire.source_text, "");
});

// ------------------------------------------------------------ the request text

test("a blank change request is refused before anything is paid for", () => {
  assert.throws(() => readInstruction("   "), PromptRefused);
  assert.throws(() => readInstruction("x".repeat(1001)), PromptRefused);
  assert.equal(readInstruction("  Lisää lisuke.  "), "Lisää lisuke.");
});

// ------------------------------------------------------------ the proposal

test("a section the model invented is dropped, since no box would show it", () => {
  const proposed = proposalForRecipe(
    draft({
      lines: [{ ...draft().lines[0]!, section: "Salaatti" }],
      steps: [{ text: "Sekoita salaatti.", section: "Salaatti", phase: null, refs: [] }],
    }),
    recipe(),
  );

  assert.equal(proposed.lines[0]!.section, null);
  assert.equal(proposed.steps[0]!.section, null);
});

test("a phase survives on a multipart dish and is dropped on a plain one", () => {
  const proposed = draft({
    lines: [{ ...draft().lines[0]!, phase: "after_parts" }],
    steps: [{ text: "Kokoa.", section: null, phase: "after_parts", refs: [] }],
  });

  assert.equal(proposalForRecipe(proposed, recipe()).lines[0]!.phase, null);
  assert.equal(
    proposalForRecipe(
      proposed,
      recipe({ parts: [recipe({ id: 6, title: "Osa", parts: [] })] }),
    ).lines[0]!.phase,
    "after_parts",
  );
});

test("the proposal reaches the editor as the editor's own fields", () => {
  const form = proposalForm(
    draft({
      lines: [
        draft().lines[0]!,
        {
          ...draft().lines[0]!,
          quantity: 1,
          unit: "kpl",
          ingredientId: null,
          ingredientName: "jäävuorisalaatti",
          sourceLine: "1 kpl jäävuorisalaattia",
          note: "Lisätty lisukkeeksi.",
        },
      ],
      steps: [
        draft().steps[0]!,
        { text: "Revi salaatti.", section: null, phase: null, refs: [] },
      ],
    }),
    recipe(),
  );

  assert.equal(form.get("title"), "Uunikaali");
  assert.equal(form.get("lineCount"), "2");
  // The version the proposal was made against, so a save still loses to an
  // edit made in another tab.
  assert.equal(form.get("revision"), "3");
  // Nothing asks the model for a category, so the recipe keeps its own.
  assert.deepEqual(form.getAll("category"), ["uuniruoka"]);

  // An existing ingredient is preselected by id; a proposed one is "create it".
  assert.equal(form.get("line.0.ingredient"), "7");
  assert.equal(form.get("line.1.ingredient"), "new");
  assert.equal(form.get("line.1.newName"), "jäävuorisalaatti");
  assert.equal(form.get("line.1.quantity"), "1");
  assert.equal(form.get("line.1.unit"), "kpl");
  assert.equal(form.get("line.1.note"), "Lisätty lisukkeeksi.");

  assert.equal(form.get("step.0"), "Kaada kerma kaalin päälle.");
  assert.equal(form.get("step.1"), "Revi salaatti.");
  // Two spare blanks, so a step can be added by hand without asking again.
  assert.equal(form.get("step.2"), "");
  assert.equal(form.get("step.3"), "");
});

test("what changed is worked out here rather than taken from the model", () => {
  const changes = proposalChanges(
    draft({
      title: "Uunikaali salaatilla",
      lines: [
        draft().lines[0]!,
        {
          ...draft().lines[0]!,
          ingredientId: null,
          ingredientName: "jäävuorisalaatti",
        },
      ],
      steps: [
        draft().steps[0]!,
        { text: "Revi salaatti.", section: null, phase: null, refs: [] },
      ],
    }),
    recipe(),
  );

  assert.deepEqual(changes, [
    { kind: "changed", what: "Nimi: Uunikaali → Uunikaali salaatilla" },
    { kind: "added", what: "Aines: jäävuorisalaatti" },
    { kind: "added", what: "1 valmistusvaihe" },
  ]);
});

test("an untouched recipe reports no change at all", () => {
  assert.deepEqual(proposalChanges(draft(), recipe()), []);
});

test("an ingredient the proposal lost is reported as removed", () => {
  const changes = proposalChanges(draft({ lines: [] }), recipe());

  assert.deepEqual(changes, [{ kind: "removed", what: "Aines: kerma" }]);
});
