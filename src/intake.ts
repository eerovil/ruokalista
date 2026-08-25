import Anthropic from "@anthropic-ai/sdk";

import type { Env } from "./env.ts";
import type { IngredientSummary } from "./ingredients.ts";

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
}

export interface Draft {
  title: string;
  yieldPortions: number | null;
  sourceText: string;
  steps: string[];
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

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    yield_portions: nullable("integer"),
    source_text: { type: "string" },
    steps: { type: "array", items: { type: "string" } },
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

  return toDraft(raw, source, model);
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
    steps: steps.filter((step): step is string => typeof step === "string"),
    lines: lines.map(toDraftLine),
    structuredBy: model,
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
    ingredientName:
      typeof line["ingredient_name"] === "string" ? line["ingredient_name"] : "",
    sourceLine:
      typeof line["source_line"] === "string" ? line["source_line"] : "",
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
