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
const EFFORT = "medium";

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

/** The standing rules, from docs/spec.md's intake flow. */
function systemPrompt(ingredients: IngredientSummary[]): string {
  const list = ingredients
    .map((ingredient) => `${ingredient.id}\t${ingredient.name}`)
    .join("\n");

  return `Rakennat suomenkielisestä reseptitekstistä jäsennellyn reseptin.

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

Talouden hyväksytyt ainekset (id, nimi):

${list || "(ei vielä yhtään)"}`;
}

/**
 * Run the model over source text and return a draft. Nothing is written to D1
 * here — a failed import leaves no trace, which is why there is no draft table.
 */
export async function structureDraft(
  env: Env,
  sourceText: string,
  ingredients: IngredientSummary[],
): Promise<Draft> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured.");
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: {
        effort: EFFORT,
        format: { type: "json_schema", schema: DRAFT_SCHEMA },
      },
      system: systemPrompt(ingredients),
      messages: [{ role: "user", content: sourceText }],
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
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new RetryableStructuringError("The model returned unparseable JSON.");
  }

  return toDraft(raw, sourceText, response.model);
}

/** Runs the model, retrying a retryable failure once before anyone sees it. */
export async function structureDraftWithRetry(
  env: Env,
  sourceText: string,
  ingredients: IngredientSummary[],
): Promise<Draft> {
  try {
    return await structureDraft(env, sourceText, ingredients);
  } catch (error) {
    if (!(error instanceof RetryableStructuringError)) throw error;
    return structureDraft(env, sourceText, ingredients);
  }
}

function toDraft(raw: unknown, sourceText: string, model: string): Draft {
  if (typeof raw !== "object" || raw === null) {
    throw new RetryableStructuringError("The draft was not an object.");
  }

  const draft = raw as Record<string, unknown>;
  const lines = Array.isArray(draft["lines"]) ? draft["lines"] : [];
  const steps = Array.isArray(draft["steps"]) ? draft["steps"] : [];

  return {
    title: typeof draft["title"] === "string" ? draft["title"] : "",
    yieldPortions: wholeOrNull(draft["yield_portions"]),
    // Kept exactly as it arrived, never as the model echoed it back.
    sourceText,
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
