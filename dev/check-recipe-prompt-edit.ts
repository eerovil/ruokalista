import assert from "node:assert/strict";
import test from "node:test";

import type { Draft } from "../src/intake.ts";
import {
  editRequestFor,
  MODE_LABEL,
  proposalChanges,
  proposalForm,
  proposalForRecipe,
  PromptRefused,
  readInstruction,
  readMode,
  recipeWire,
  untouchedParts,
} from "../src/recipe-prompt-edit.ts";
import { readExpectedParts } from "../src/line-form.ts";
import type { Recipe } from "../src/recipes.ts";

/**
 * What a prompt edit (#208) asks the model, and what it does with the answer.
 *
 * None of this needs a paid call. The three things worth getting right are that
 * the model is handed the *whole* dish — its named parts included — rather than
 * nothing, that the mode the member chose is passed rather than guessed at, and
 * that the proposal reaches the ordinary editor as ordinary form fields, so the
 * review a member corrects and the recipe a save writes are the same thing.
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

/** A dish written in named parts, the shape "lisää kastikkeeseen" needs. */
function lasagne(): Recipe {
  return recipe({
    id: 3,
    title: "Lasagne",
    lines: [line({ ingredientId: 10, ingredient: "lasagnelevy", quantity: 12, unit: "kpl", sourceLine: "12 lasagnelevyä", phase: "after_parts" })],
    steps: [{ text: "Kokoa vuokaan.", phase: "after_parts", refs: [] }],
    parts: [
      recipe({
        id: 4,
        title: "Jauhelihakastike",
        parentId: 3,
        parts: [],
        lines: [line({ ingredientId: 7, ingredient: "jauheliha", quantity: 400, unit: "g", sourceLine: "400 g jauhelihaa" })],
        steps: [
          {
            text: "Ruskista jauheliha.",
            phase: null,
            refs: [{ ingredientId: 7, matchedText: "jauheliha", approxPosition: 9 }],
          },
        ],
      }),
      recipe({
        id: 5,
        title: "Juustokastike",
        parentId: 3,
        parts: [],
        lines: [
          line({ ingredientId: 9, ingredient: "maito", quantity: 5, unit: "dl", sourceLine: "5 dl maitoa" }),
          line({ ingredientId: 8, ingredient: "juusto", quantity: 2, unit: "dl", sourceLine: "2 dl juustoa" }),
        ],
        steps: [{ text: "Kuumenna maito.", phase: null, refs: [] }],
      }),
    ],
  });
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

// ------------------------------------------------------------ the mode

test("the mode is read from the form, never guessed from the wording", () => {
  assert.equal(readMode("extend"), "extend");
  assert.equal(readMode("replace"), "replace");
  // No default: a request with no mode is not one this app rendered, and
  // picking one for it is exactly the guess #208 says not to make.
  assert.throws(() => readMode(null), PromptRefused);
  assert.throws(() => readMode(""), PromptRefused);
  assert.throws(() => readMode("rewrite"), PromptRefused);
});

test("each mode sends its own instruction to the model", () => {
  const extend = editRequestFor(recipe(), "Lisää lisuke.", NO_INGREDIENTS, "extend").system;
  const replace = editRequestFor(recipe(), "Lisää lisuke.", NO_INGREDIENTS, "replace").system;

  assert.match(extend, /Toimintatapa: TÄYDENNÄ NYKYISTÄ/);
  assert.match(extend, /Nykyinen resepti on pohja, joka säilytetään/);
  assert.match(extend, /Älä kirjoita valmistusohjetta uusiksi/);
  assert.doesNotMatch(extend, /Toimintatapa: KORVAA RESEPTI/);

  assert.match(replace, /Toimintatapa: KORVAA RESEPTI/);
  assert.match(replace, /Saat kirjoittaa\s+reseptin uudeksi kokonaisuudeksi/);
  // The one rule replace mode must not lose: still a whole saveable recipe.
  assert.match(replace, /Palauta täydellinen, tallennuskelpoinen resepti/);
  assert.doesNotMatch(replace, /Älä kirjoita valmistusohjetta uusiksi/);
});

test("the same change request is sent under either mode, unrewritten", () => {
  const asked = "Tee tästä parempi kokonainen resepti.";
  for (const mode of ["extend", "replace"] as const) {
    assert.match(
      editRequestFor(recipe(), asked, NO_INGREDIENTS, mode).messages[0].content,
      /Käyttäjän uusi syöte:\n\nTee tästä parempi kokonainen resepti\.$/,
    );
  }
});

test("photographs follow the same edit request after the recipe snapshot", () => {
  const content = editRequestFor(
    recipe(),
    {
      route: "photographed",
      images: [{ base64: "page-one", mediaType: "image/jpeg" }],
    },
    NO_INGREDIENTS,
    "extend",
  ).messages[0].content;

  assert.ok(Array.isArray(content));
  assert.match(String(content[0]?.type === "text" ? content[0].text : ""), /Nykyinen resepti kokonaisuudessaan/);
  assert.equal(content[1]?.type, "image");
});

test("both modes have a Finnish name the screens can agree on", () => {
  assert.equal(MODE_LABEL.extend, "Täydennä nykyistä");
  assert.equal(MODE_LABEL.replace, "Korvaa resepti");
});

// ------------------------------------------------------------ the request

test("the model is handed the current recipe, not an empty page", () => {
  const content = editRequestFor(
    recipe(),
    "Lisää salaatti lisukkeeksi.",
    NO_INGREDIENTS,
    "extend",
  ).messages[0].content;

  assert.match(content, /Nykyinen resepti kokonaisuudessaan:/);
  assert.match(content, /"title": "Uunikaali"/);
  assert.match(content, /"ingredient_name": "kerma"/);
  assert.match(content, /"ingredient_id": 7/);
});

test("the recipe's own source text rides along as background", () => {
  const content = editRequestFor(recipe(), "Täydennä ohje.", NO_INGREDIENTS, "extend")
    .messages[0].content;

  assert.match(content, /alkuperäinen lähdeteksti/);
  assert.match(content, /2 dl kermaa/);
});

test("a part's own ingredients and steps are in the context, not just its name", () => {
  const content = editRequestFor(
    lasagne(),
    "Lisää kastikkeeseen puuttuvat ainekset.",
    NO_INGREDIENTS,
    "extend",
  ).messages[0].content;

  // The whole point of #208's second requirement: the sauce's contents are
  // visible, so "add the missing sauce ingredients" is answerable at all.
  assert.match(content, /"ingredient_name": "juusto"/);
  assert.match(content, /"ingredient_name": "maito"/);
  assert.match(content, /"section": "Juustokastike"/);
  assert.match(content, /"text": "Kuumenna maito\."/);
  assert.match(content, /"text": "Ruskista jauheliha\."/);
});

test("the wire carries the dish first, then each part in order", () => {
  const wire = recipeWire(lasagne()) as {
    lines: Array<{ ingredient_name: string; section: string | null; phase: unknown }>;
    steps: Array<{ text: string; section: string | null; phase: unknown }>;
  };

  assert.deepEqual(
    wire.lines.map((l) => [l.section, l.ingredient_name]),
    [
      [null, "lasagnelevy"],
      ["Jauhelihakastike", "jauheliha"],
      ["Juustokastike", "maito"],
      ["Juustokastike", "juusto"],
    ],
  );
  // A named part's content carries no cooking-order phase of its own (ADR-0003).
  assert.equal(wire.lines[0]!.phase, "after_parts");
  assert.equal(wire.lines[1]!.phase, null);
  assert.equal(wire.steps[1]!.section, "Jauhelihakastike");
});

test("a part's step points at that part's own line, by its place in the whole list", () => {
  const wire = recipeWire(lasagne()) as {
    steps: Array<{ section: string | null; ingredient_refs: unknown[] }>;
  };

  // "Ruskista jauheliha" names line 1 — the sauce's own jauheliha, which is the
  // second entry of the flattened list, not the second entry of its own part.
  assert.deepEqual(wire.steps[1]!.ingredient_refs, [
    { line: 1, matched_text: "jauheliha", approx_position: 9 },
  ]);
});

test("the standing rules say what a section means and what may not move", () => {
  const system = editRequestFor(lasagne(), "Lisää lisuke.", NO_INGREDIENTS, "extend").system;

  assert.match(system, /section-kenttä kertoo, minkä nimiseen osaan se kuuluu/);
  assert.match(system, /lisää kastikkeeseen puuttuvat ainekset/);
  // The draft's own shape rules are the intake ones, not a second copy.
  assert.match(system, /Säännöt, joista ei poiketa:/);
  assert.match(system, /Talouden hyväksytyt ainekset/);
});

test("only a plain dish being extended is told there is no cooking order", () => {
  const plain = (mode: "extend" | "replace") =>
    editRequestFor(recipe(), "Lisää lisuke.", NO_INGREDIENTS, mode).system;

  assert.match(plain("extend"), /phase on aina null/);
  // Replace mode may give a plain dish its first named parts, so the shortcut
  // would be a rule the answer has to break.
  assert.doesNotMatch(plain("replace"), /phase on aina null/);
  assert.doesNotMatch(
    editRequestFor(lasagne(), "Lisää lisuke.", NO_INGREDIENTS, "extend").system,
    /phase on aina null/,
  );
});

test("source_text is not asked back, because it would be discarded", () => {
  const wire = recipeWire(recipe()) as { source_text: string };
  assert.equal(wire.source_text, "");
});

test("extra photos guide an edit without becoming a new source of record", () => {
  const system = editRequestFor(
    recipe(),
    { route: "photographed", images: [{ base64: "page", mediaType: "image/jpeg" }] },
    NO_INGREDIENTS,
    "extend",
  ).system;

  assert.match(system, /lisäaineistosta/);
  assert.match(system, /älä myöskään poista nykyisen reseptin tietoja/);
  assert.doesNotMatch(system, /source_text on oma tarkka transkriptio/);
  assert.doesNotMatch(system, /jätä vastaava kenttä null/);
});

const PHOTO = {
  route: "photographed" as const,
  images: [{ base64: "page", mediaType: "image/jpeg" as const }],
};
const PAGE = { route: "linked" as const, text: "Uunikaali\n1 dl vettä" };

/**
 * The failure this pair exists to stop: a photographed or linked *replace* has
 * no written change request, so rules that protect whatever the new material
 * left out turn `Korvaa nykyinen resepti` into an extend. Both routes are
 * checked because each has its own wording, and both are checked against extend
 * because the protection is right there and must survive.
 */
for (const [route, source] of [
  ["photographed", PHOTO],
  ["linked", PAGE],
] as const) {
  test(`a ${route} replace lets the new material leave old content out`, () => {
    const system = editRequestFor(recipe(), source, NO_INGREDIENTS, "replace").system;

    assert.match(system, /ensisijainen lähde/);
    assert.match(system, /jätä se pois/);
    assert.match(system, /ei enää määrää sisältöä/);
    // The two rules that would otherwise merge the old recipe back in.
    assert.doesNotMatch(system, /älä myöskään poista nykyisen reseptin tietoja/);
    assert.doesNotMatch(system, /äläkä poista nykyisen reseptin tietoja/);
    // What replace still keeps: the same dish, saveable, in one document.
    assert.match(system, /Älä keksi kokonaan toista ruokaa/);
    assert.match(system, /Palauta täydellinen, tallennuskelpoinen resepti/);
    assert.match(system, /Kirjoita olemassa olevan osan nimi täsmälleen/);
  });

  test(`a ${route} extend still protects what the new material omits`, () => {
    const system = editRequestFor(recipe(), source, NO_INGREDIENTS, "extend").system;

    assert.match(system, /lisäaineisto/);
    assert.match(system, /poista nykyisen reseptin tietoja vain siksi/);
    assert.match(system, /Älä poista ainesta tai vaihetta/);
    assert.doesNotMatch(system, /ensisijainen lähde/);
  });
}

test("only a replace with no new material is told to keep every ingredient", () => {
  const asked = "Tee tästä parempi kokonainen resepti.";
  const written = editRequestFor(recipe(), asked, NO_INGREDIENTS, "replace").system;
  const photographed = editRequestFor(recipe(), PHOTO, NO_INGREDIENTS, "replace").system;

  // Written and photographed replace share one conditional rule rather than two
  // wordings: it is the model that can see whether the new input carries a
  // recipe, and only the routes above can say so for certain.
  for (const system of [written, photographed]) {
    assert.match(system, /pelkkä muutospyyntö eikä sisällä itse\s+reseptiaineistoa/);
    assert.match(system, /se määrittää lopputuloksen/);
  }
  assert.doesNotMatch(written, /ensisijainen lähde/);
});

// ------------------------------------------------------------ the request text

test("a blank change request is refused before anything is paid for", () => {
  assert.throws(() => readInstruction("   "), PromptRefused);
  assert.throws(() => readInstruction("x".repeat(1001)), PromptRefused);
  assert.equal(readInstruction("  Lisää lisuke.  "), "Lisää lisuke.");
});

// ------------------------------------------------------------ the proposal

test("a proposed section survives, trimmed, so it can reach a part", () => {
  const proposed = proposalForRecipe(
    draft({
      lines: [{ ...draft().lines[0]!, section: " Juustokastike " }],
      steps: [{ text: "Sekoita.", section: "Juustokastike", phase: "after_parts", refs: [] }],
    }),
    lasagne(),
  );

  assert.equal(proposed.lines[0]!.section, "Juustokastike");
  // A part's content carries no phase, whatever the model wrote.
  assert.equal(proposed.steps[0]!.phase, null);
});

test("a phase survives on the dish's own row and is dropped on a plain recipe", () => {
  const proposed = draft({
    lines: [{ ...draft().lines[0]!, phase: "after_parts" }],
    steps: [{ text: "Kokoa.", section: null, phase: "after_parts", refs: [] }],
  });

  assert.equal(proposalForRecipe(proposed, recipe()).lines[0]!.phase, null);
  assert.equal(proposalForRecipe(proposed, lasagne()).lines[0]!.phase, "after_parts");
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
          section: "Salaatti",
          note: "Lisätty lisukkeeksi.",
        },
      ],
      steps: [
        draft().steps[0]!,
        { text: "Revi salaatti.", section: "Salaatti", phase: null, refs: [] },
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
  assert.equal(form.get("line.1.note"), "Lisätty lisukkeeksi.");
  // The part each row and step landed in, which is what carries it to the
  // right recipe row on save.
  assert.equal(form.get("line.0.section"), "");
  assert.equal(form.get("line.1.section"), "Salaatti");
  assert.equal(form.get("step.1.section"), "Salaatti");

  assert.equal(form.get("step.0"), "Kaada kerma kaalin päälle.");
  // Two spare blanks, so a step can be added by hand without asking again.
  assert.equal(form.get("step.2"), "");
  assert.equal(form.get("step.3"), "");
});

test("the proposal carries each part's own version, not only the dish's", () => {
  // A part is a recipe row with its own editor screen (ADR-0002), so the dish's
  // revision does not move when somebody fixes the juustokastike. Without these
  // fields a proposal read beforehand would delete that fix on the way in.
  const dish = lasagne();
  dish.parts[0]!.revision = 11;
  dish.parts[1]!.revision = 4;

  const form = proposalForm(draft(), dish);

  assert.equal(form.get("revision"), "3");
  assert.equal(form.get("partCount"), "2");
  assert.equal(form.get("part.0.id"), "4");
  assert.equal(form.get("part.0.title"), "Jauhelihakastike");
  assert.equal(form.get("part.0.revision"), "11");
  assert.equal(form.get("part.1.id"), "5");
  assert.equal(form.get("part.1.title"), "Juustokastike");
  assert.equal(form.get("part.1.revision"), "4");

  // And they read back as what the save checks against.
  assert.deepEqual(readExpectedParts(form), [
    { id: 4, title: "Jauhelihakastike", revision: 11 },
    { id: 5, title: "Juustokastike", revision: 4 },
  ]);
});

test("a dish with no parts has nothing extra to hold still", () => {
  const form = proposalForm(draft(), recipe());

  assert.equal(form.get("partCount"), "0");
  assert.deepEqual(readExpectedParts(form), []);
});

test("a part expectation that arrives mangled is dropped, not trusted", () => {
  // Dropping one cannot weaken the lock: a section naming a part nobody
  // expected is refused by the save rather than written over.
  const form = new FormData();
  form.set("partCount", "3");
  form.set("part.0.id", "4");
  form.set("part.0.title", "Jauhelihakastike");
  form.set("part.0.revision", "11");
  form.set("part.1.id", "not a row");
  form.set("part.1.title", "Juustokastike");
  form.set("part.1.revision", "4");
  form.set("part.2.id", "6");
  form.set("part.2.title", "  ");
  form.set("part.2.revision", "-1");

  assert.deepEqual(readExpectedParts(form), [
    { id: 4, title: "Jauhelihakastike", revision: 11 },
  ]);
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

test("a change inside a part is reported as that part's", () => {
  const dish = lasagne();
  const changes = proposalChanges(
    draft({
      title: "Lasagne",
      lines: [
        { ...draft().lines[0]!, ingredientId: 10, ingredientName: "lasagnelevy", section: null },
        { ...draft().lines[0]!, ingredientId: 7, ingredientName: "jauheliha", section: "Jauhelihakastike" },
        { ...draft().lines[0]!, ingredientId: 9, ingredientName: "maito", section: "Juustokastike" },
        { ...draft().lines[0]!, ingredientId: 8, ingredientName: "juusto", section: "Juustokastike" },
        { ...draft().lines[0]!, ingredientId: null, ingredientName: "voi", section: "Juustokastike" },
      ],
      steps: [
        { text: "Kokoa vuokaan.", section: null, phase: "after_parts", refs: [] },
        { text: "Ruskista jauheliha.", section: "Jauhelihakastike", phase: null, refs: [] },
        { text: "Kuumenna maito.", section: "Juustokastike", phase: null, refs: [] },
      ],
    }),
    dish,
  );

  assert.deepEqual(changes, [
    { kind: "added", what: "Juustokastike: Aines: voi" },
  ]);
});

test("an untouched recipe reports no change at all", () => {
  assert.deepEqual(proposalChanges(draft(), recipe()), []);
});

test("an ingredient the proposal lost is reported as removed", () => {
  assert.deepEqual(proposalChanges(draft({ lines: [] }), recipe()), [
    { kind: "removed", what: "Aines: kerma" },
  ]);
});

test("a part the proposal stops naming is kept, and the review says so", () => {
  const dish = lasagne();
  const flattened = draft({
    title: "Lasagne",
    lines: [{ ...draft().lines[0]!, ingredientId: 10, ingredientName: "lasagnelevy" }],
    steps: [{ text: "Kokoa vuokaan.", section: null, phase: null, refs: [] }],
  });

  assert.deepEqual(untouchedParts(flattened, dish), [
    "Jauhelihakastike",
    "Juustokastike",
  ]);
  const kept = proposalChanges(flattened, dish).filter((c) => c.kind === "kept");
  assert.deepEqual(kept, [
    { kind: "kept", what: 'Osa "Jauhelihakastike" jää ennalleen omaksi reseptikseen' },
    { kind: "kept", what: 'Osa "Juustokastike" jää ennalleen omaksi reseptikseen' },
  ]);
});

test("a part the proposal does name is not reported as kept", () => {
  const dish = lasagne();
  const touched = draft({
    lines: [{ ...draft().lines[0]!, ingredientName: "jauheliha", section: "Jauhelihakastike" }],
    steps: [],
  });

  assert.deepEqual(untouchedParts(touched, dish), ["Juustokastike"]);
});
