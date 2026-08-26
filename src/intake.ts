import Anthropic from "@anthropic-ai/sdk";

import type { Env } from "./env.ts";
import type { IngredientSummary } from "./ingredients.ts";
import { recipePhase, type RecipePhase } from "./recipe-phase.ts";

/**
 * Structuring: turning source text into a recipe's title, ingredients and
 * steps. Done by a language model, because no parser for Finnish ingredient
 * lines exists.
 *
 * The model that produced a draft is recorded on the recipe, so a future
 * re-import can tell what structured it. Decision #11 locked Sonnet 5, so the
 * model id is a constant here rather than an env override — an override was one
 * of the things that drifted in the closed attempt.
 */

const MODEL = "claude-sonnet-5";

/**
 * Thinking costs output tokens, and docs/spec.md's ~$0.03 an import assumed
 * none. The spec also says the flow is optimised entirely for draft quality, so
 * this sits in the middle rather than at either end. It is the one dial worth
 * turning if imports feel dear or drafts feel sloppy.
 */
const EFFORT = "medium" as const;

export interface DraftLine {
  quantity: number | null;
  quantityMax: number | null;
  unit: string | null;
  altQuantity: number | null;
  altUnit: string | null;
  /** Null when the model matched nothing — the line then needs a human answer. */
  ingredientId: number | null;
  ingredientName: string;
  sourceLine: string;
  /** The named part this belongs to, or null for the dish itself. */
  section: string | null;
  /** When parent-level content belongs in a multipart dish's cooking order. */
  phase: RecipePhase;
  /**
   * The model's own doubt about this line, in one short Finnish sentence, or
   * null when it is sure. Null on nearly every line.
   *
   * This is what lets the import screen be a read view rather than a form: a
   * line worth a second look says so, instead of waiting to be found. It
   * describes the import, not the dish, so it is never saved.
   */
  note: string | null;
}

export interface DraftStep {
  text: string;
  section: string | null;
  phase: RecipePhase;
}

export interface Draft {
  title: string;
  yieldPortions: number | null;
  sourceText: string;
  steps: DraftStep[];
  lines: DraftLine[];
  structuredBy: string;
}

/**
 * The two routes in, and only two. Nothing is ever fetched from a web address.
 *
 * A photograph is held in memory for the length of one model call and then
 * dropped — never written to D1, and there is no bucket.
 */
export type IntakeSource =
  | { route: "pasted"; text: string }
  | { route: "photographed"; imageBase64: string; mediaType: string };

/** The model asked for. Exposed so a streamed draft can be stamped with it. */
export const STRUCTURED_BY = MODEL;

/** Thrown when the model failed in a way that re-running might fix. */
export class RetryableStructuringError extends Error {}

const nullable = (type: string) => ({
  anyOf: [{ type }, { type: "null" }],
});

export const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    yield_portions: nullable("integer"),
    source_text: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          section: nullable("string"),
          phase: {
            anyOf: [
              { type: "string", enum: ["before_parts", "after_parts"] },
              { type: "null" },
            ],
          },
        },
        required: ["text", "section", "phase"],
        additionalProperties: false,
      },
    },
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          quantity: nullable("number"),
          quantity_max: nullable("number"),
          unit: nullable("string"),
          alt_quantity: nullable("number"),
          alt_unit: nullable("string"),
          ingredient_id: nullable("integer"),
          ingredient_name: { type: "string" },
          source_line: { type: "string" },
          section: nullable("string"),
          phase: {
            anyOf: [
              { type: "string", enum: ["before_parts", "after_parts"] },
              { type: "null" },
            ],
          },
          note: nullable("string"),
        },
        required: [
          "quantity",
          "quantity_max",
          "unit",
          "alt_quantity",
          "alt_unit",
          "ingredient_id",
          "ingredient_name",
          "source_line",
          "section",
          "phase",
          "note",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "yield_portions", "source_text", "steps", "lines"],
  additionalProperties: false,
} as const;

/**
 * Extra standing rules for a photographed page. There is no given text, so
 * source_text becomes the model's own transcription — and that transcription is
 * what gets kept forever as the record of what arrived.
 */
const PHOTOGRAPHED_RULES = `
Kuvatun sivun lisäsäännöt:

- source_text on oma tarkka transkriptio kuvasta sellaisenaan; älä siivoa,
  järjestä uudelleen, käännä tai tiivistä.
- Litteroi vain se, mikä on oikeasti luettavissa; älä arvaa sumeita tai
  rajautuneita sanoja.
- Ainesosarivit ja vaiheet johdetaan samasta transkriptiosta, ei kuvasta
  erikseen tulkiten.
- Jos sivulla on useampi resepti, poimi vain pääresepti.
- Ohita sivun oheismateriaali: sivunumerot, otsikkotunnisteet, mainokset ja
  aiheeseen liittymättömät kuvatekstit.
- Jos kuva on epäselvä tai osa tekstistä puuttuu, jätä vastaava kenttä null sen
  sijaan että täydentäisit sen arvauksella.
`;

/** The standing rules, from docs/spec.md's intake flow. */
function systemPrompt(
  ingredients: IngredientSummary[],
  route: IntakeSource["route"],
): string {
  const list = ingredients
    .map((ingredient) => `${ingredient.id}\t${ingredient.name}`)
    .join("\n");

  const extra = route === "photographed" ? PHOTOGRAPHED_RULES : "";

  return `Rakennat suomenkielisestä reseptistä jäsennellyn reseptin.

Säännöt, joista ei poiketa:

- Älä koskaan keksi määrää tai yksikköä. Jos teksti ei sano, jätä null.
- Säilytä yksikkö täsmälleen sellaisena kuin resepti sen kirjoitti (dl, rkl, tl, kpl, g).
- Kopioi jokainen source_line sanatarkasti sellaisena kuin se rivillä lukee.
- Aseta quantity_max vain kun rivi todella ilmaisee välin, myös sanoin
  kirjoitettuna ("1–1 ja ½ l"). Muuten null.
- Käytä alt_quantity ja alt_unit kun rivi mittaa saman asian kahdesti eri
  yksiköissä ("½ (500 g) valkokaali"). Säilytä lähteen kirjoitusjärjestys.
  Molemmat tai ei kumpaakaan.
- Aseta yield_portions vain jos teksti kertoo annosmäärän.
- source_text on annettu teksti sellaisenaan.
- Yhdistä jokainen rivi olemassa olevaan ainekseen sen id:llä kun jokin selvästi
  sopii. Muuten jätä ingredient_id null ja ehdota nimi ingredient_name-kentässä.
- Jos ruokalaji on kirjoitettu nimettyihin osiin — kuten lasagnen
  jauhelihakastike ja juustokastike — merkitse jokaisen rivin ja vaiheen
  section-kenttään sen osan nimi täsmälleen kuten se sivulla lukee. Jos rivi tai
  vaihe ei kuulu mihinkään osaan, jätä section null. Älä keksi osia: jos
  sivulla ei ole väliotsikoita, kaikki section-kentät ovat null.
- Kun reseptissä on nimettyjä osia, luokittele jokainen section null -rivi ja
  -vaihe ruoanlaittojärjestyksen mukaan. phase on before_parts, kun työ tehdään
  ennen nimettyjä osia, ja after_parts, kun se on kokoamista, yhdistämistä,
  paistamista, viimeistelyä tai tarjoilua osien jälkeen. Nimetyn osan sisällön
  phase on null. Ilman nimettyjä osia kaikkien phase on null.
- Aseta note vain kun rivistä oikeasti katosi tai arvattiin jotain: jouduit
  päättelemään yksikön, määrä oli sanallinen, rivillä oli vaihtoehto tai
  valmistustapa jota kentät eivät kanna, tai teksti oli epäselvä. Kirjoita
  yhdellä lyhyellä suomenkielisellä lauseella mikä jäi auki.
  Note on huomiolista, ei selostus: yhdessä reseptissä niitä on tyypillisesti
  nolla tai yksi. Jos merkitsisit yli puolet riveistä, merkitse vain ne joissa
  tietoa todella katosi, ja jätä muut nulliksi. Rivi jonka luit suoraan oikein
  ei koskaan saa notea.
${extra}
Talouden hyväksytyt ainekset (id, nimi):

${list || "(ei vielä yhtään)"}`;
}

/** What the model is handed: a block of text, or a photograph of a page. */
function userContent(source: IntakeSource) {
  if (source.route === "pasted") {
    return source.text;
  }

  return [
    {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: source.mediaType as "image/jpeg",
        data: source.imageBase64,
      },
    },
    { type: "text" as const, text: "Jäsennä tämän sivun resepti." },
  ];
}

/**
 * The text a draft's source_text should hold: for a paste, exactly what
 * arrived; for a photograph, the model's transcription, since nothing else
 * records what was on the page.
 */
function keptSourceText(source: IntakeSource, transcribed: unknown): string {
  if (source.route === "pasted") return source.text;
  return typeof transcribed === "string" ? transcribed : "";
}

/**
 * Run the model over source text and return a draft. Nothing is written to D1
 * here — a failed import leaves no trace, which is why there is no draft table.
 */
export async function structureDraft(
  env: Env,
  source: IntakeSource,
  ingredients: IngredientSummary[],
): Promise<Draft> {
  const client = anthropic(env);

  let response;
  try {
    response = await client.messages.create({
      ...requestFor(source, ingredients),
    });
  } catch (cause) {
    throw new RetryableStructuringError(`Model call failed: ${String(cause)}`);
  }

  if (response.stop_reason === "refusal") {
    throw new Error("The model declined to structure this text.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new RetryableStructuringError("The draft was cut off.");
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("");

  // Structured outputs constrain the shape, so this should not fail — but the
  // draft is a human's afternoon either way, so a bad one is retried rather
  // than shown.
  return draftFromJson(text, source, response.model);
}

/** Runs the model, retrying a retryable failure once before anyone sees it. */
export async function structureDraftWithRetry(
  env: Env,
  source: IntakeSource,
  ingredients: IngredientSummary[],
): Promise<Draft> {
  try {
    return await structureDraft(env, source, ingredients);
  } catch (error) {
    if (!(error instanceof RetryableStructuringError)) throw error;
    return structureDraft(env, source, ingredients);
  }
}

/**
 * The draft as a stream of bytes.
 *
 * Bytes never stop flowing, so Cloudflare's ~125 s proxy cutoff never fires —
 * this is the whole reason the stack is Workers (#7). It also makes a slow
 * import feel like progress rather than a hang.
 */
export function streamDraft(
  env: Env,
  source: IntakeSource,
  ingredients: IngredientSummary[],
): ReadableStream<Uint8Array> {
  const client = anthropic(env);
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      try {
        const stream = client.messages.stream({
          ...requestFor(source, ingredients),
        });

        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            controller.enqueue(encoder.encode(event.delta.text));
          }
        }

        controller.close();
      } catch (cause) {
        // A JSON body has no room for an in-band error, so the stream is torn
        // down instead. The browser still has what the member typed.
        controller.error(cause);
      }
    },
  });
}

/** Parse a draft the browser streamed and handed back. */
export function draftFromJson(
  text: string,
  source: IntakeSource,
  model: string,
): Draft {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new RetryableStructuringError("The model returned unparseable JSON.");
  }

  assertDraftWire(raw);
  return toDraft(raw, source, model);
}

/**
 * Enforce the same wire contract for every producer of a draft. Structured
 * model output is constrained by DRAFT_SCHEMA, but browser handoff and
 * AgentDeck bundles are still untrusted JSON by the time they reach here.
 */
function assertDraftWire(raw: unknown): void {
  const draft = objectWithKeys(raw, "draft", [
    "title",
    "yield_portions",
    "source_text",
    "steps",
    "lines",
  ]);
  requireString(draft["title"], "title");
  requireWholeOrNull(draft["yield_portions"], "yield_portions");
  requireString(draft["source_text"], "source_text");

  if (!Array.isArray(draft["steps"])) invalid("steps must be an array");
  draft["steps"].forEach((rawStep, index) => {
    const step = objectWithKeys(rawStep, `steps[${index}]`, [
      "text",
      "section",
      "phase",
    ]);
    requireString(step["text"], `steps[${index}].text`);
    requireStringOrNull(step["section"], `steps[${index}].section`);
    requirePhase(step["phase"], `steps[${index}].phase`);
  });

  if (!Array.isArray(draft["lines"])) invalid("lines must be an array");
  draft["lines"].forEach((rawLine, index) => {
    const line = objectWithKeys(rawLine, `lines[${index}]`, [
      "quantity",
      "quantity_max",
      "unit",
      "alt_quantity",
      "alt_unit",
      "ingredient_id",
      "ingredient_name",
      "source_line",
      "section",
      "phase",
      "note",
    ]);
    requireNumberOrNull(line["quantity"], `lines[${index}].quantity`);
    requireNumberOrNull(line["quantity_max"], `lines[${index}].quantity_max`);
    requireStringOrNull(line["unit"], `lines[${index}].unit`);
    requireNumberOrNull(line["alt_quantity"], `lines[${index}].alt_quantity`);
    requireStringOrNull(line["alt_unit"], `lines[${index}].alt_unit`);
    const altQuantity = line["alt_quantity"];
    const altUnit = textOrNull(line["alt_unit"]);
    if ((altQuantity === null) !== (altUnit === null)) {
      invalid(
        `lines[${index}].alt_quantity and alt_unit must both be set or both be null`,
      );
    }
    if (altQuantity !== null && line["quantity"] === null) {
      invalid(`lines[${index}].alternative measurement requires quantity`);
    }
    requireWholeOrNull(line["ingredient_id"], `lines[${index}].ingredient_id`);
    requireString(line["ingredient_name"], `lines[${index}].ingredient_name`);
    requireString(line["source_line"], `lines[${index}].source_line`);
    requireStringOrNull(line["section"], `lines[${index}].section`);
    requirePhase(line["phase"], `lines[${index}].phase`);
    requireStringOrNull(line["note"], `lines[${index}].note`);
  });
}

function objectWithKeys(
  value: unknown,
  label: string,
  keys: string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  const object = value as Record<string, unknown>;
  const expected = new Set(keys);
  for (const key of keys) {
    if (!(key in object)) invalid(`${label}.${key} is required`);
  }
  for (const key of Object.keys(object)) {
    if (!expected.has(key)) invalid(`${label}.${key} is not allowed`);
  }
  return object;
}

function requireString(value: unknown, label: string): void {
  if (typeof value !== "string") invalid(`${label} must be a string`);
}

function requireStringOrNull(value: unknown, label: string): void {
  if (value !== null && typeof value !== "string") {
    invalid(`${label} must be a string or null`);
  }
}

function requireNumberOrNull(value: unknown, label: string): void {
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
    invalid(`${label} must be a number or null`);
  }
}

function requireWholeOrNull(value: unknown, label: string): void {
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value))) {
    invalid(`${label} must be an integer or null`);
  }
}

function requirePhase(value: unknown, label: string): void {
  if (value !== null && value !== "before_parts" && value !== "after_parts") {
    invalid(`${label} is not a supported phase`);
  }
}

function invalid(message: string): never {
  throw new RetryableStructuringError(`Invalid draft: ${message}.`);
}

function anthropic(env: Env): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured.");
  }
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

function requestFor(source: IntakeSource, ingredients: IngredientSummary[]) {
  return {
    model: MODEL,
    max_tokens: 16000,
    output_config: {
      effort: EFFORT,
      format: { type: "json_schema" as const, schema: DRAFT_SCHEMA },
    },
    system: systemPrompt(ingredients, source.route),
    messages: [{ role: "user" as const, content: userContent(source) }],
  };
}

function toDraft(raw: unknown, source: IntakeSource, model: string): Draft {
  if (typeof raw !== "object" || raw === null) {
    throw new RetryableStructuringError("The draft was not an object.");
  }

  const draft = raw as Record<string, unknown>;
  const lines = Array.isArray(draft["lines"]) ? draft["lines"] : [];
  const steps = Array.isArray(draft["steps"]) ? draft["steps"] : [];

  return {
    title: typeof draft["title"] === "string" ? draft["title"] : "",
    yieldPortions: wholeOrNull(draft["yield_portions"]),
    sourceText: keptSourceText(source, draft["source_text"]),
    steps: steps.map(toDraftStep).filter((step) => step.text !== ""),
    lines: lines.map(toDraftLine),
    structuredBy: model,
  };
}

function toDraftStep(raw: unknown): DraftStep {
  const step = (raw ?? {}) as Record<string, unknown>;
  return {
    text: typeof step["text"] === "string" ? step["text"].trim() : "",
    section: textOrNull(step["section"]),
    phase: recipePhase(step["phase"]),
  };
}

function toDraftLine(raw: unknown): DraftLine {
  const line = (raw ?? {}) as Record<string, unknown>;

  const quantity = numberOrNull(line["quantity"]);
  const altQuantity = numberOrNull(line["alt_quantity"]);
  const altUnit = textOrNull(line["alt_unit"]);

  // The schema's two rules, enforced again here: a second measurement is both
  // halves or neither, and never stands alone.
  const altPairIsWhole = altQuantity !== null && altUnit !== null;

  return {
    quantity,
    quantityMax: numberOrNull(line["quantity_max"]),
    unit: textOrNull(line["unit"]),
    altQuantity: altPairIsWhole && quantity !== null ? altQuantity : null,
    altUnit: altPairIsWhole && quantity !== null ? altUnit : null,
    ingredientId: wholeOrNull(line["ingredient_id"]),
    note: textOrNull(line["note"]),
    ingredientName:
      typeof line["ingredient_name"] === "string" ? line["ingredient_name"] : "",
    sourceLine:
      typeof line["source_line"] === "string" ? line["source_line"] : "",
    section: textOrNull(line["section"]),
    phase: recipePhase(line["phase"]),
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function wholeOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
