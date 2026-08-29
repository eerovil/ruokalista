import type { Env } from "./env.ts";
import { encodeDraftRefs } from "./ingredient-refs.ts";
import type { IngredientSummary } from "./ingredients.ts";
import {
  anthropicClient,
  DRAFT_RULES,
  DRAFT_SCHEMA,
  draftStream,
  EFFORT,
  ingredientDictionary,
  MAX_TOKENS,
  STRUCTURED_BY,
  type Draft,
  type DraftLine,
  type IntakeSource,
} from "./intake.ts";
import {
  lineValuesFromDraft,
  MAX_LINES,
  MAX_STEPS,
  setExpectedParts,
} from "./line-form.ts";
import type { Recipe } from "./recipes.ts";

/**
 * Editing a saved recipe with a sentence (#208): *lisää puuttuva lisuke*,
 * *lisää kastikkeeseen puuttuvat ainekset*, *tee tästä parempi kokonainen
 * resepti*.
 *
 * The whole idea is that this is **not** a second way to write a recipe. The
 * model is handed the recipe it already has — the whole dish, its named parts
 * included — in exactly the shape it must answer in, and asked to change it.
 * What comes back is an ordinary intake draft, checked by the same
 * `assertDraftWire`, and it is rendered into the ordinary recipe editor, so the
 * member corrects it with the controls they already know and the save is
 * `POST /recipes/:id`. Nothing in this file writes to the database.
 */

/**
 * How the model's answer is meant to relate to the recipe it started from.
 *
 * The member chooses this **before** the request is written and it is passed to
 * the model as its own instruction. It is deliberately not inferred from the
 * wording of the change request: "tee tästä parempi kokonainen resepti" and
 * "lisää puuttuva lisuke" would have to be told apart by guessing, and guessing
 * wrong either refuses a rewrite somebody asked for or quietly rewrites a
 * recipe somebody wanted kept.
 */
export type PromptMode = "extend" | "replace";

export const PROMPT_MODES: readonly PromptMode[] = ["extend", "replace"];

/** The Finnish name of each mode, as the control and the review both say it. */
export const MODE_LABEL: Record<PromptMode, string> = {
  extend: "Täydennä nykyistä",
  replace: "Korvaa resepti",
};

/**
 * How long a change request may be. A prompt edit is a sentence, not a recipe:
 * somebody pasting a whole page into this box wants intake, and the cap says so
 * before a model call is paid for.
 */
export const MAX_INSTRUCTION = 1000;

/** Thrown when the request cannot be sent, in the Finnish the screen shows. */
export class PromptRefused extends Error {}

/**
 * The change request as it will be sent, or a refusal.
 *
 * Blank is refused rather than sent as an empty instruction, which the model
 * would answer by inventing something.
 */
export function readInstruction(value: unknown): string {
  const text = String(value ?? "").trim();
  if (text === "") {
    throw new PromptRefused("Kirjoita, mitä reseptiin pitäisi muuttaa.");
  }
  if (text.length > MAX_INSTRUCTION) {
    throw new PromptRefused(
      `Muutospyyntö saa olla enintään ${MAX_INSTRUCTION} merkkiä.`,
    );
  }
  return text;
}

/**
 * The mode the form chose, refusing anything else.
 *
 * There is no default here on purpose. A missing mode means a form that was not
 * the one this app rendered, and picking one for it would be exactly the guess
 * the issue says not to make.
 */
export function readMode(value: unknown): PromptMode {
  const text = String(value ?? "").trim();
  if (text === "extend" || text === "replace") return text;
  throw new PromptRefused("Valitse, täydennetäänkö nykyistä vai korvataanko se.");
}

/**
 * The source a proposal is parsed against.
 *
 * It is the recipe's *own* stored text, and the route is `pasted` purely so
 * `keptSourceText` hands that text straight back: source text is the record of
 * what arrived and a prompt edit does not get to touch it, in either mode. That
 * is also why the rules below ask the model for an empty `source_text` —
 * anything it wrote there would be discarded, so paying for it would be waste.
 */
export function sourceFor(recipe: Recipe): IntakeSource {
  return { route: "pasted", text: recipe.sourceText };
}

/**
 * The rules both modes answer to: what the job is, and what a part means.
 *
 * The `section` field is how the draft format has always said "this belongs to
 * the juustokastike" (ADR-0002), so a dish and its parts go out and come back
 * as one document. That is what makes *lisää kastikkeeseen puuttuvat ainekset*
 * answerable at all — before this the model was shown the parts' names and
 * nothing else, so it could not see what the sauce was made of.
 */
const SHARED_EDIT_RULES = `Muokkaustehtävän säännöt:

- Saat nykyisen reseptin samassa muodossa kuin vastaat, ja käyttäjän
  muutospyynnön. Palauta aina koko resepti kokonaisena, älä pelkkää muutosta,
  listaa muutoksista tai osittaista vastausta.
- Reseptin nimetyt osat ovat mukana samassa vastauksessa: rivin ja vaiheen
  section-kenttä kertoo, minkä nimiseen osaan se kuuluu, ja null tarkoittaa
  ruokalajia itseään. Kun muutospyyntö koskee jotakin osaa — esimerkiksi
  "lisää kastikkeeseen puuttuvat ainekset" — muuta sen osan rivejä ja vaiheita
  ja jätä muiden osien section-arvot ennalleen.
- Kirjoita olemassa olevan osan nimi täsmälleen samalla tavalla kuin se on
  annettu. Eri kirjoitusasu tarkoittaa uutta osaa, ei samaa osaa.
- Säilytä olemassa olevan rivin ingredient_id sellaisenaan. Uudella rivillä
  yhdistä olemassa olevaan ainekseen id:llä kun jokin selvästi sopii, muuten
  ingredient_id on null ja ingredient_name on ehdottamasi nimi.
- Uuden rivin source_line on rivin oma sanamuoto, esimerkiksi "2 dl kermaa".
  Alkuperäisessä tekstissä ei ole sille riviä, joten sitä ei voi kopioida.
- source_text on aina tyhjä merkkijono. Reseptin alkuperäinen teksti on tallenne
  siitä mitä aikanaan saapui, se säilytetään palvelimella eikä sitä muokata.
- Aseta note vain niille riveille, joita muutit tai lisäsit, ja kerro yhdellä
  lyhyellä suomenkielisellä lauseella mitä teit tai jouduit arvaamaan.
  Ennallaan jääneen rivin note on null.
- Käyttäjä tarkistaa ehdotuksen ennen tallennusta, joten älä arvaa laajemmin
  kuin on tarpeen. Jos jokin jäi epäselväksi, kerro se note-kentässä.
- Enintään ${MAX_LINES} ainesriviä ja ${MAX_STEPS} vaihetta yhteensä.`;

/**
 * *Täydennä nykyistä*: the recipe is the base and it stays. This is the mode
 * that has to be strict, because a model asked to add a missing side dish will
 * happily rename the dish, restate every amount in round numbers and rewrite
 * the method in its own voice — and the member cannot tell at a glance which of
 * those they asked for.
 */
const EXTEND_RULES = `Toimintatapa: TÄYDENNÄ NYKYISTÄ.

- Nykyinen resepti on pohja, joka säilytetään. Lisää sen päälle vain se, mitä
  muutospyyntö pyytää.
- Kaikki muu säilyy sanatarkasti ennallaan: title, yield_portions, ainesrivien
  järjestys, määrät, yksiköt, ingredient_id-arvot, source_line-kentät,
  section-arvot ja vaiheiden teksti.
- Älä nimeä reseptiä uudelleen äläkä muuta yield_portions-arvoa, ellei
  muutospyyntö sitä nimenomaisesti pyydä.
- Älä kirjoita valmistusohjetta uusiksi. Lisää uudet vaiheet niihin kohtiin
  joihin ne kuuluvat ja jätä vanhat vaiheet sanatarkasti ennalleen.
- Älä poista ainesta tai vaihetta, ellei muutospyyntö pyydä poistamaan.
- Älä luo uutta osaa, jos pyydetty sisältö sopii luontevasti ruokalajiin
  itseensä tai johonkin sen nykyiseen osaan.`;

/**
 * *Korvaa resepti*: the member has said the recipe is not good enough and asked
 * for a better one. The model may restructure everything — but the answer is
 * still about *this* dish, and it is still one complete draft, because what it
 * saves into is the same recipe row.
 */
const REPLACE_RULES = `Toimintatapa: KORVAA RESEPTI.

- Käyttäjä on pyytänyt kokonaan uuden version tästä reseptistä. Saat kirjoittaa
  reseptin uudeksi kokonaisuudeksi: järjestää ainekset ja vaiheet uudelleen,
  korjata puutteet, tarkentaa määriä ja kirjoittaa valmistusohjeen selkeämmin.
- Lopputuloksen pitää silti olla sama ruokalaji, joka perustuu nykyiseen
  reseptiin ja käyttäjän muutospyyntöön. Älä keksi kokonaan toista ruokaa.
- Saat nimetä reseptin uudelleen vain, jos ruokalajin nimi on nykyisellään
  selvästi väärä tai puutteellinen.
- Palauta täydellinen, tallennuskelpoinen resepti: jokainen aines omalla
  rivillään määrineen ja koko valmistusohje vaiheittain. Vaikka kirjoitat
  kaiken uusiksi, älä pudota ainesta jonka nykyinen resepti mainitsee, ellei
  muutospyyntö sitä pyydä.
- Voit järjestää ruokalajin nimettyihin osiin tai purkaa nykyiset osat takaisin
  ruokalajiin itseensä. Huomaa, että osa jota et enää mainitse jää talteen
  omaksi reseptikseen; se ei katoa, vaan käyttäjä poistaa sen halutessaan.`;

/** The extra rule a dish with no named parts needs: there is no cooking order. */
const NO_PHASE_RULE = `
- phase on aina null: tällä reseptillä ei ole nimettyjä osia.`;

export function editSystemPrompt(
  recipe: Recipe,
  ingredients: IngredientSummary[],
  mode: PromptMode,
): string {
  const modeRules = mode === "replace" ? REPLACE_RULES : EXTEND_RULES;
  // A dish with no parts today can still be given one in replace mode, so the
  // no-phase shortcut is only safe where parts are also off the table.
  const noPhase = recipe.parts.length === 0 && mode === "extend" ? NO_PHASE_RULE : "";

  return `Muokkaat olemassa olevaa suomenkielistä reseptiä käyttäjän ohjeen mukaan.

${modeRules}

${SHARED_EDIT_RULES}${noPhase}

${DRAFT_RULES}

${ingredientDictionary(ingredients)}`;
}

/**
 * Every recipe row this edit covers: the dish, then each of its parts in order.
 *
 * A part is a recipe row of its own (ADR-0002), so "the whole recipe" is a
 * list of rows rather than one object — and the draft format flattens that list
 * by naming each row in `section`, which is exactly what it was built to do on
 * the way in.
 */
function rowsOf(recipe: Recipe): Array<{ section: string | null; row: Recipe }> {
  return [
    { section: null, row: recipe },
    ...recipe.parts.map((part) => ({ section: part.title, row: part })),
  ];
}

/**
 * The whole dish as the model is shown it: the draft wire shape, field for
 * field, so that "here is what you are changing" and "answer like this" are the
 * same document.
 *
 * `source_text` is left out of it — it is given separately as background, and
 * asking for it back would only be paid for and discarded.
 */
export function recipeWire(recipe: Recipe): unknown {
  const lines: unknown[] = [];
  const steps: unknown[] = [];

  for (const { section, row } of rowsOf(recipe)) {
    // A saved mention names an ingredient; a draft's names a line by index into
    // the flat array being built here. Any row carrying the ingredient will do,
    // and it has to be one of *this* recipe row's own lines — the same rule
    // `childrenOf` enforces when it writes them back.
    const lineOfIngredient = new Map<number, number>();
    for (const line of row.lines) {
      if (!lineOfIngredient.has(line.ingredientId)) {
        lineOfIngredient.set(line.ingredientId, lines.length);
      }
      lines.push({
        quantity: line.quantity,
        quantity_max: line.quantityMax,
        unit: line.unit,
        alt_quantity: line.altQuantity,
        alt_unit: line.altUnit,
        ingredient_id: line.ingredientId,
        ingredient_name: line.ingredient,
        source_line: line.sourceLine,
        section,
        // A named part's content carries no phase of its own (ADR-0003).
        phase: section === null ? line.phase : null,
        alternative_group: line.alternativeGroup,
        note: null,
      });
    }

    for (const step of row.steps) {
      steps.push({
        text: step.text,
        section,
        phase: section === null ? step.phase : null,
        ingredient_refs: step.refs.flatMap((ref) => {
          const line = lineOfIngredient.get(ref.ingredientId);
          return line === undefined
            ? []
            : [{
                line,
                matched_text: ref.matchedText,
                approx_position: ref.approxPosition,
              }];
        }),
      });
    }
  }

  return {
    title: recipe.title,
    yield_portions: recipe.yieldPortions,
    source_text: "",
    steps,
    lines,
  };
}

/**
 * What the model is handed. The whole dish first, then the text it was made
 * from as background — "täydennä ohje niin että kaikki ainekset tulevat
 * käytetyiksi" cannot be answered without it — then the change request last,
 * where it reads as the instruction.
 */
export function editUserContent(recipe: Recipe, instruction: string): string {
  const parts =
    recipe.parts.length === 0
      ? ""
      : `Reseptin nimetyt osat, joiden sisältö on yllä section-kentän mukaan:

${recipe.parts.map((part) => `- ${part.title}`).join("\n")}

`;

  const source =
    recipe.sourceText.trim() === ""
      ? ""
      : `Reseptin alkuperäinen lähdeteksti, vain taustatiedoksi:

${recipe.sourceText}

`;

  return `Nykyinen resepti kokonaisuudessaan:

${JSON.stringify(recipeWire(recipe), null, 2)}

${parts}${source}Käyttäjän muutospyyntö:

${instruction}`;
}

/** The whole model request for one prompt edit. Exported so a check can read it. */
export function editRequestFor(
  recipe: Recipe,
  instruction: string,
  ingredients: IngredientSummary[],
  mode: PromptMode,
) {
  return {
    model: STRUCTURED_BY,
    max_tokens: MAX_TOKENS,
    output_config: {
      effort: EFFORT,
      format: { type: "json_schema" as const, schema: DRAFT_SCHEMA },
    },
    system: editSystemPrompt(recipe, ingredients, mode),
    messages: [
      { role: "user" as const, content: editUserContent(recipe, instruction) },
    ],
  };
}

/**
 * The proposal as a stream of NDJSON records, through the same attempt loop
 * intake uses: a cut-off or unparseable answer is retried once and the result
 * is parsed on the server before it is ever called complete.
 */
export function streamRecipeEdit(
  env: Env,
  recipe: Recipe,
  instruction: string,
  ingredients: IngredientSummary[],
  mode: PromptMode,
): ReadableStream<Uint8Array> {
  const client = anthropicClient(env);
  return draftStream(
    () =>
      client.messages.stream({
        ...editRequestFor(recipe, instruction, ingredients, mode),
      }),
    sourceFor(recipe),
  );
}

/**
 * The proposal, narrowed to what the editor and the save can actually carry.
 *
 * The rules ask for all of this, and a model that follows them changes nothing
 * here. It is enforced anyway, because each one would otherwise be a field that
 * submits from a form nobody rendered:
 *
 * - a named part's content carries no phase of its own (ADR-0003), and
 *   `childrenOf` drops one on the way to the database, so the review must not
 *   show one either;
 * - a dish with no parts and no proposed sections offers no phase select at
 *   all, so a phase there would be discarded without ever being on screen.
 */
export function proposalForRecipe(draft: Draft, recipe: Recipe): Draft {
  const named =
    recipe.parts.length > 0 ||
    [...draft.lines, ...draft.steps].some(
      (item) => (item.section ?? "").trim() !== "",
    );

  const inPart = (section: string | null) => (section ?? "").trim() !== "";

  return {
    ...draft,
    lines: draft.lines.map((line) => ({
      ...line,
      section: (line.section ?? "").trim() === "" ? null : line.section!.trim(),
      phase: named && !inPart(line.section) ? line.phase : null,
    })),
    steps: draft.steps.map((step) => ({
      ...step,
      section: (step.section ?? "").trim() === "" ? null : step.section!.trim(),
      phase: named && !inPart(step.section) ? step.phase : null,
    })),
  };
}

/**
 * The proposal as the recipe editor's own form fields.
 *
 * The editor already knows how to re-render itself from a submitted form — that
 * is how a refused save keeps what somebody typed — so a proposal is turned
 * into that same `FormData` rather than into a second rendering path. What the
 * member reviews is therefore the editor, with every control it always has.
 *
 * Two spare blank steps ride along, as they do when the editor is opened
 * normally, so a step can be added by hand without asking the model again.
 */
export function proposalForm(draft: Draft, recipe: Recipe): FormData {
  const form = new FormData();

  form.set("title", draft.title);
  form.set("yield", draft.yieldPortions === null ? "" : String(draft.yieldPortions));
  form.set("lineCount", String(draft.lines.length));
  // The version this proposal was made against. A save still has to win the
  // ordinary optimistic check, so an edit made in another tab meanwhile is a
  // 409 here exactly as it would be from the editor.
  form.set("revision", String(recipe.revision));
  // And the same for each part, because the dish's revision does not move when
  // one of its parts is edited — a part is a recipe row with its own screen
  // (ADR-0002). Without these, a proposal read before somebody fixed the
  // juustokastike would delete that fix on the way in, and nothing would say
  // so. `replaceRecipe` refuses the whole save if one of them no longer holds.
  setExpectedParts(
    form,
    recipe.parts.map((part) => ({
      id: part.id,
      title: part.title,
      revision: part.revision,
    })),
  );
  // Nothing asks the model for a category (#196), so the recipe keeps its own.
  for (const category of recipe.categories) form.append("category", category);

  draft.lines.forEach((line: DraftLine, index) => {
    const values = lineValuesFromDraft(line, index);
    form.set(`line.${index}.position`, values.position);
    form.set(`line.${index}.quantity`, values.quantity);
    form.set(`line.${index}.quantityMax`, values.quantityMax);
    form.set(`line.${index}.unit`, values.unit);
    form.set(`line.${index}.altQuantity`, values.altQuantity);
    form.set(`line.${index}.altUnit`, values.altUnit);
    form.set(`line.${index}.section`, values.section);
    form.set(`line.${index}.phase`, values.phase);
    form.set(`line.${index}.alternativeGroup`, values.alternativeGroup);
    form.set(`line.${index}.ingredient`, values.ingredientChoice);
    form.set(`line.${index}.newName`, values.newName);
    form.set(`line.${index}.source`, values.sourceLine);
    form.set(`line.${index}.note`, values.note);
  });

  draft.steps.forEach((step, index) => {
    form.set(`step.${index}`, step.text);
    form.set(`step.${index}.position`, String(index + 1));
    form.set(`step.${index}.section`, step.section ?? "");
    form.set(`step.${index}.phase`, step.phase ?? "");
    form.set(`step.${index}.refs`, encodeDraftRefs(step.refs));
  });
  for (let spare = 0; spare < 2; spare += 1) {
    const index = draft.steps.length + spare;
    form.set(`step.${index}`, "");
    form.set(`step.${index}.position`, String(index + 1));
    form.set(`step.${index}.section`, "");
    form.set(`step.${index}.phase`, "");
    form.set(`step.${index}.refs`, "");
  }

  return form;
}

/** One line of "what this proposal did", for the member to check against. */
export interface ProposalChange {
  kind: "added" | "removed" | "changed" | "kept";
  what: string;
}

/** "Kastike: kerma", or just "kerma" for something the dish itself owns. */
function inSection(section: string | null, what: string): string {
  return section === null ? what : `${section}: ${what}`;
}

/**
 * What changed, worked out here rather than asked of the model.
 *
 * The thing this feature lives or dies by is "content I did not ask about
 * survives", and a member cannot check that by rereading a long recipe.
 * Comparing the proposal against the stored dish *and its parts* is cheap,
 * honest, and cannot be talked out of saying an ingredient went missing. It
 * matters more in replace mode, not less: that is the mode where the model was
 * allowed to move everything.
 */
export function proposalChanges(
  draft: Draft,
  recipe: Recipe,
): ProposalChange[] {
  const changes: ProposalChange[] = [];

  if (draft.title.trim() !== recipe.title.trim()) {
    changes.push({
      kind: "changed",
      what: `Nimi: ${recipe.title} → ${draft.title}`,
    });
  }

  const key = (section: string | null, name: string) =>
    `${(section ?? "").toLocaleLowerCase("fi")} ${name.toLocaleLowerCase("fi")}`;

  const before = new Map<string, { section: string | null; name: string }>();
  const beforeSteps: Array<{ section: string | null; text: string }> = [];
  for (const { section, row } of rowsOf(recipe)) {
    for (const line of row.lines) {
      before.set(key(section, line.ingredient), { section, name: line.ingredient });
    }
    for (const step of row.steps) {
      beforeSteps.push({ section, text: step.text.trim() });
    }
  }

  const after = new Map<string, { section: string | null; name: string }>();
  for (const line of draft.lines) {
    after.set(key(line.section, line.ingredientName), {
      section: line.section,
      name: line.ingredientName,
    });
  }

  for (const [k, entry] of after) {
    if (!before.has(k)) {
      changes.push({
        kind: "added",
        what: inSection(entry.section, `Aines: ${entry.name}`),
      });
    }
  }
  for (const [k, entry] of before) {
    if (!after.has(k)) {
      changes.push({
        kind: "removed",
        what: inSection(entry.section, `Aines: ${entry.name}`),
      });
    }
  }

  const stepKey = (section: string | null, text: string) =>
    `${(section ?? "").toLocaleLowerCase("fi")} ${text}`;
  const beforeKeys = new Set(beforeSteps.map((s) => stepKey(s.section, s.text)));
  const afterKeys = new Set(
    draft.steps.map((s) => stepKey(s.section, s.text.trim())),
  );
  const addedSteps = [...afterKeys].filter((k) => !beforeKeys.has(k)).length;
  const removedSteps = [...beforeKeys].filter((k) => !afterKeys.has(k)).length;

  if (addedSteps > 0) {
    changes.push({
      kind: "added",
      what:
        addedSteps === 1 ? "1 valmistusvaihe" : `${addedSteps} valmistusvaihetta`,
    });
  }
  if (removedSteps > 0) {
    changes.push({
      kind: "removed",
      what:
        removedSteps === 1
          ? "1 valmistusvaihe muuttui tai poistui"
          : `${removedSteps} valmistusvaihetta muuttui tai poistui`,
    });
  }

  // A part the proposal stopped naming is kept rather than deleted, and that is
  // worth stating rather than leaving somebody to notice: it is a recipe row of
  // its own, possibly on a menu, and the member is the one who gets to remove
  // it. Replace mode is where this actually happens.
  for (const name of untouchedParts(draft, recipe)) {
    changes.push({
      kind: "kept",
      what: `Osa "${name}" jää ennalleen omaksi reseptikseen`,
    });
  }

  return changes;
}

/**
 * The dish's parts this proposal says nothing about, and which are therefore
 * left exactly as they are by the save.
 */
export function untouchedParts(draft: Draft, recipe: Recipe): string[] {
  const named = new Set(
    [...draft.lines, ...draft.steps]
      .map((item) => (item.section ?? "").trim().toLocaleLowerCase("fi"))
      .filter((name) => name !== ""),
  );

  return recipe.parts
    .map((part) => part.title)
    .filter((title) => !named.has(title.trim().toLocaleLowerCase("fi")));
}
