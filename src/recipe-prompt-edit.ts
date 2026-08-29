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
import { lineValuesFromDraft, MAX_LINES, MAX_STEPS } from "./line-form.ts";
import type { Recipe } from "./recipes.ts";

/**
 * Editing a saved recipe with a sentence (#208): *lisää puuttuva lisuke*,
 * *täydennä ohje niin että kaikki ainekset tulevat käytetyiksi*.
 *
 * The whole idea is that this is **not** a second way to write a recipe. The
 * model is handed the recipe it already has, in exactly the shape it must
 * answer in, and asked to change one thing about it. What comes back is an
 * ordinary intake draft, checked by the same `assertDraftWire`, and it is
 * rendered into the ordinary recipe editor — so the member corrects it with the
 * controls they already know and the save is `POST /recipes/:id`, unchanged.
 * Nothing here writes to the database.
 */

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
 * The source a proposal is parsed against.
 *
 * It is the recipe's *own* stored text, and the route is `pasted` purely so
 * `keptSourceText` hands that text straight back: source text is the record of
 * what arrived and a prompt edit does not get to touch it. That is also why the
 * rules below ask the model for an empty `source_text` — anything it wrote
 * there would be discarded, so paying for it would be waste.
 */
export function sourceFor(recipe: Recipe): IntakeSource {
  return { route: "pasted", text: recipe.sourceText };
}

/**
 * What the model may and may not do to a recipe it has been handed.
 *
 * Every bullet here exists because the failure it forbids is the failure that
 * makes the feature worthless: a model asked to "add the missing side dish"
 * will happily rename the dish, restate every amount in round numbers and
 * rewrite the method in its own voice, and the member cannot tell at a glance
 * which of those they asked for.
 */
const EDIT_RULES = `Muokkaustehtävän säännöt:

- Saat nykyisen reseptin samassa muodossa kuin vastaat, ja käyttäjän
  muutospyynnön. Palauta koko resepti uudelleen, myös se mitä et muuta.
- Muuta vain se, mitä muutospyyntö pyytää. Kaikki muu säilyy sanatarkasti
  ennallaan: title, yield_portions, ainesrivien järjestys, määrät, yksiköt,
  ingredient_id-arvot, source_line-kentät ja vaiheiden teksti.
- Älä nimeä reseptiä uudelleen äläkä muuta yield_portions-arvoa, ellei
  muutospyyntö sitä nimenomaisesti pyydä.
- Älä kirjoita valmistusohjetta uusiksi. Lisää uudet vaiheet niihin kohtiin
  joihin ne kuuluvat ja jätä vanhat vaiheet sanatarkasti ennalleen.
- Älä poista ainesta tai vaihetta, ellei muutospyyntö pyydä poistamaan.
- Säilytä olemassa olevan rivin ingredient_id sellaisenaan. Uudella rivillä
  yhdistä olemassa olevaan ainekseen id:llä kun jokin selvästi sopii, muuten
  ingredient_id on null ja ingredient_name on ehdottamasi nimi.
- Uuden rivin source_line on rivin oma sanamuoto, esimerkiksi "2 dl kermaa".
  Alkuperäisessä tekstissä ei ole sille riviä, joten sitä ei voi kopioida.
- source_text on aina tyhjä merkkijono. Reseptin alkuperäinen teksti on tallenne
  siitä mitä aikanaan saapui, se säilytetään palvelimella eikä sitä muokata.
- section on aina null. Reseptin nimetyt osat ovat omia reseptejään, joita
  muokataan omalla sivullaan, joten älä luo, nimeä äläkä siirrä osia. Lisuke
  lisätään tämän reseptin omiksi ainesriveiksi ja vaiheiksi.
- Aseta note vain niille riveille, joita muutit tai lisäsit, ja kerro yhdellä
  lyhyellä suomenkielisellä lauseella mitä teit tai jouduit arvaamaan.
  Ennallaan jääneen rivin note on null.
- Jos muutospyyntö on epäselvä tai vaatisi rakennetta jota kentät eivät kanna,
  tee pienin järkevä muutos ja kerro note-kentässä mikä jäi auki. Älä arvaa
  laajemmin kuin on pakko — käyttäjä tarkistaa ehdotuksen ennen tallennusta.
- Enintään ${MAX_LINES} ainesriviä ja ${MAX_STEPS} vaihetta.`;

/** The extra rule a dish with no named parts needs: there is no cooking order. */
const NO_PHASE_RULE = `
- phase on aina null: tällä reseptillä ei ole nimettyjä osia.`;

export function editSystemPrompt(
  recipe: Recipe,
  ingredients: IngredientSummary[],
): string {
  return `Muokkaat olemassa olevaa suomenkielistä reseptiä käyttäjän ohjeen mukaan.

${EDIT_RULES}${recipe.parts.length === 0 ? NO_PHASE_RULE : ""}

${DRAFT_RULES}

${ingredientDictionary(ingredients)}`;
}

/**
 * The recipe as the model is shown it: the draft wire shape, field for field,
 * so that "answer in this shape" and "here is what you are changing" are the
 * same document. `source_text` is left out of it — it is given separately as
 * background, and asking for it back would only be paid for and discarded.
 */
export function recipeWire(recipe: Recipe): unknown {
  // A saved mention names an ingredient; a draft's names a line by index. Any
  // row carrying the ingredient will do, the same rule the editor uses.
  const rowOfIngredient = new Map<number, number>();
  recipe.lines.forEach((line, index) => {
    if (!rowOfIngredient.has(line.ingredientId)) {
      rowOfIngredient.set(line.ingredientId, index);
    }
  });

  return {
    title: recipe.title,
    yield_portions: recipe.yieldPortions,
    source_text: "",
    steps: recipe.steps.map((step) => ({
      text: step.text,
      section: null,
      phase: step.phase,
      ingredient_refs: step.refs.flatMap((ref) => {
        const line = rowOfIngredient.get(ref.ingredientId);
        return line === undefined
          ? []
          : [{
              line,
              matched_text: ref.matchedText,
              approx_position: ref.approxPosition,
            }];
      }),
    })),
    lines: recipe.lines.map((line) => ({
      quantity: line.quantity,
      quantity_max: line.quantityMax,
      unit: line.unit,
      alt_quantity: line.altQuantity,
      alt_unit: line.altUnit,
      ingredient_id: line.ingredientId,
      ingredient_name: line.ingredient,
      source_line: line.sourceLine,
      // A saved part is a recipe of its own, so a recipe's own lines carry none.
      section: null,
      phase: line.phase,
      alternative_group: line.alternativeGroup,
      note: null,
    })),
  };
}

/**
 * What the model is handed. The recipe first, then the text it was made from as
 * background — "täydennä ohje niin että kaikki ainekset tulevat käytetyiksi"
 * cannot be answered without it — then the parts that are somebody else's
 * screen, then the change request last, where it reads as the instruction.
 */
export function editUserContent(recipe: Recipe, instruction: string): string {
  const parts =
    recipe.parts.length === 0
      ? ""
      : `Reseptin nimetyt osat, joita tämä pyyntö ei muokkaa:

${recipe.parts.map((part) => `- ${part.title}`).join("\n")}

`;

  const source =
    recipe.sourceText.trim() === ""
      ? ""
      : `Reseptin alkuperäinen lähdeteksti, vain taustatiedoksi:

${recipe.sourceText}

`;

  return `Nykyinen resepti:

${JSON.stringify(recipeWire(recipe), null, 2)}

${source}${parts}Käyttäjän muutospyyntö:

${instruction}`;
}

/** The whole model request for one prompt edit. Exported so a check can read it. */
export function editRequestFor(
  recipe: Recipe,
  instruction: string,
  ingredients: IngredientSummary[],
) {
  return {
    model: STRUCTURED_BY,
    max_tokens: MAX_TOKENS,
    output_config: {
      effort: EFFORT,
      format: { type: "json_schema" as const, schema: DRAFT_SCHEMA },
    },
    system: editSystemPrompt(recipe, ingredients),
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
): ReadableStream<Uint8Array> {
  const client = anthropicClient(env);
  return draftStream(
    () => client.messages.stream({ ...editRequestFor(recipe, instruction, ingredients) }),
    sourceFor(recipe),
  );
}

/**
 * The proposal, narrowed to what the editor can actually carry.
 *
 * The rules ask for all of this, and a model that follows them changes nothing
 * here. It is enforced anyway because the alternative is a field that submits
 * from a form nobody rendered: the editor shows no `section` box — a saved part
 * is its own screen — and shows no phase select on a dish with no parts, so a
 * section or phase the model invented would be dropped on save without ever
 * having been on screen. Dropping it here means the review shows exactly what
 * the save will write.
 */
export function proposalForRecipe(draft: Draft, recipe: Recipe): Draft {
  const phased = recipe.parts.length > 0;

  return {
    ...draft,
    lines: draft.lines.map((line) => ({
      ...line,
      section: null,
      phase: phased ? line.phase : null,
    })),
    steps: draft.steps.map((step) => ({
      ...step,
      section: null,
      phase: phased ? step.phase : null,
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
    form.set(`step.${index}.phase`, step.phase ?? "");
    form.set(`step.${index}.refs`, encodeDraftRefs(step.refs));
  });
  for (let spare = 0; spare < 2; spare += 1) {
    const index = draft.steps.length + spare;
    form.set(`step.${index}`, "");
    form.set(`step.${index}.position`, String(index + 1));
    form.set(`step.${index}.phase`, "");
    form.set(`step.${index}.refs`, "");
  }

  return form;
}

/** One line of "what this proposal did", for the member to check against. */
export interface ProposalChange {
  kind: "added" | "removed" | "changed";
  what: string;
}

/**
 * What changed, worked out here rather than asked of the model.
 *
 * The acceptance this feature lives or dies by is "content the member did not
 * ask about survives", and a member cannot check that by rereading a long
 * recipe. Comparing the proposal against the stored recipe is cheap, honest and
 * cannot be talked out of saying an ingredient went missing.
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

  const before = recipe.lines.map((line) => line.ingredient.toLowerCase());
  const after = draft.lines.map((line) => line.ingredientName.toLowerCase());

  for (const line of draft.lines) {
    if (!before.includes(line.ingredientName.toLowerCase())) {
      changes.push({ kind: "added", what: `Aines: ${line.ingredientName}` });
    }
  }
  for (const line of recipe.lines) {
    if (!after.includes(line.ingredient.toLowerCase())) {
      changes.push({ kind: "removed", what: `Aines: ${line.ingredient}` });
    }
  }

  const steps = recipe.steps.map((step) => step.text.trim());
  const proposedSteps = draft.steps.map((step) => step.text.trim());
  const addedSteps = proposedSteps.filter((text) => !steps.includes(text)).length;
  const removedSteps = steps.filter((text) => !proposedSteps.includes(text)).length;

  if (addedSteps > 0) {
    changes.push({
      kind: "added",
      what: addedSteps === 1 ? "1 valmistusvaihe" : `${addedSteps} valmistusvaihetta`,
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

  return changes;
}
