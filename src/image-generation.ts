import type { Env } from "./env.ts";
import { GRID, MAX_CELLS } from "./contact-sheet.ts";
import type { FingerprintRecipe } from "./recipe-fingerprint.ts";

/**
 * Asking for sixteen recipe pictures with one paid request.
 *
 * The trick is that the picture we buy is not a picture of a dish — it is a
 * *contact sheet*: one square image holding a 4×4 grid of sixteen dishes on
 * transparent background, which `contact-sheet.ts` then cuts apart locally for
 * nothing. So a household of a hundred recipes costs seven requests rather than
 * a hundred, and the per-dish price falls by the same factor.
 *
 * Three things about the prompt are load-bearing rather than decorative:
 *
 *   - It always asks for sixteen cells, even for a batch of three. A grid whose
 *     shape depends on the batch size would put a three-dish batch's cells
 *     somewhere else on the sheet, and the splitter's nominal grid is what maps
 *     a cell back to a recipe. Unused cells are asked for empty and ignored.
 *   - It asks for generous transparent gutters and for each dish to sit well
 *     inside its cell. That slack is what the splitter recovers with when the
 *     model draws a little outside the lines, which a real test sheet did.
 *   - It renders no text. No recipe names, no labels, no numbers. The mapping
 *     from cell to recipe is positional, so a rendered name would be something
 *     to misread rather than something to read.
 *
 * The style is a constant with a version. Every stored picture records the
 * version it was made under, so a household's pictures can be told apart by
 * which rules drew them — and changing the style is a deliberate act that dates
 * everything made before it, rather than a silent drift.
 */

/**
 * The provider and model, explicit in code for the same reason the intake
 * model is: an environment override is how the closed attempt's model choice
 * drifted, and this one spends money per call.
 */
const PROVIDER = "openai";

/**
 * `gpt-image-2` rather than `gpt-image-1`, and the reason is a date: at the time
 * of writing the account's `gpt-image-1`, `gpt-image-1-mini`, `gpt-image-1.5`
 * and `chatgpt-image-latest` all carry a retirement date within a few months,
 * and `gpt-image-2` carries none. A model id in code is a thing somebody has to
 * come back and change, so it may as well be the one that is not already dated.
 */
const MODEL = "gpt-image-2";

/**
 * The one square size this model offers. Sixteen cells of a 1,024 px sheet are
 * 256 px each, which is the ceiling on how detailed one dish can be — the price
 * of batching, paid in pixels rather than in money.
 */
const SIZE = "1024x1024";

/**
 * Quality, and the cost dial.
 *
 * One real sheet was bought while building this, and it is the fixture in
 * `tests/fixtures/contact-sheet.png`. What it cost, measured from the API's own
 * `usage`, is **7,024 image output tokens plus 487 text input tokens** for eight
 * dishes at `high` on a 1,024-square.
 *
 * That token count is the durable fact and is what to do arithmetic with. The
 * money is not quoted here on purpose: image-output pricing is per model and has
 * moved more than once, and a stale dollar figure in a comment is worse than no
 * figure, because it reads like something that was checked. Multiply the tokens
 * by GPT Image 2's current image-output rate on OpenAI's pricing page — and note
 * that the sixteen-dish batch this is built for divides that one sheet's cost by
 * sixteen, which is the whole economic point.
 *
 * `medium` and `low` cost materially fewer tokens per sheet. High is chosen
 * because sixteen dishes share one image: whatever detail is lost here is lost
 * again when one cell of a 1,024 px sheet becomes a recipe's picture.
 */
const QUALITY = "high";

/**
 * Bumped whenever the style text below changes. Stored with every generated
 * picture, so a household can be told which rules drew what.
 */
export const STYLE_VERSION = "s1";

/** What gets written into `image_generated_by`. Provider, model and style. */
export const GENERATED_BY = `${PROVIDER}:${MODEL}/${STYLE_VERSION}`;

/**
 * A batch's worth of paid work is one request, so it gets a long leash — image
 * generation of this size routinely takes a minute or more. It is still bounded:
 * a request that never answers must fail rather than hold a Worker open.
 */
const TIMEOUT_MS = 180_000;

/**
 * A cap on the response we will read, before reading it. A transparent 1,024 px
 * PNG is a megabyte or two, and base64 inflates it by a third; twenty is room
 * for a surprising sheet and a refusal for a runaway one.
 */
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

/** How many ingredients of a dish reach the brief. */
const INGREDIENTS_PER_DISH = 8;

/** What went wrong, in words a caller can report. Never carries the key. */
export class GenerationError extends Error {}

/** One requested dish, in manifest order. */
export interface DishBrief {
  recipeId: number;
  title: string;
  /** The ingredient names that decide what the dish looks like. */
  ingredients: string[];
}

/** What came back, and what it cost to describe. */
export interface GeneratedSheet {
  /** PNG bytes of the whole 4×4 sheet. */
  png: Uint8Array;
  model: string;
  styleVersion: string;
  generatedBy: string;
  /** The provider's own token accounting, when it reports any. */
  usage: unknown;
}

/**
 * The visual brief for one dish, from the recipe's own structured content.
 *
 * Title first, because it names the dish; then the ingredients, because they
 * are what is on the plate. A part of a multipart dish contributes its own
 * ingredients — a lasagne looks like its sauce and its cheese sauce, and a
 * brief that mentioned neither would describe an empty dish.
 *
 * Nothing here needs the original page or photograph to still exist, which is
 * the point: a recipe imported two years ago from a link that has since died
 * can still be drawn.
 */
export function dishBrief(recipeId: number, recipe: FingerprintRecipe): DishBrief {
  const seen = new Set<string>();
  const ingredients: string[] = [];

  for (const part of [recipe, ...recipe.parts]) {
    for (const line of part.lines) {
      const name = line.ingredient.trim();
      const key = name.toLowerCase();
      if (name.length === 0 || seen.has(key)) continue;
      seen.add(key);
      ingredients.push(name);
      if (ingredients.length >= INGREDIENTS_PER_DISH) return finish();
    }
  }

  return finish();

  function finish(): DishBrief {
    return { recipeId, title: recipe.title.trim(), ingredients };
  }
}

/**
 * The prompt. Exported because it is the thing worth reading in a review, and
 * because a check asserts on the parts that must always be in it — sixteen
 * cells whatever the batch size, and no text anywhere.
 */
export function sheetPrompt(dishes: readonly DishBrief[]): string {
  if (dishes.length < 1 || dishes.length > MAX_CELLS) {
    throw new RangeError(`A sheet holds 1 to ${MAX_CELLS} dishes.`);
  }

  const cells = dishes.map((dish, at) => {
    const ingredients = dish.ingredients.length > 0
      ? dish.ingredients.join(", ")
      : "no ingredient list available; draw a plausible plated dish for the name";
    return `Cell ${at + 1}: ${dish.title} — ${ingredients}.`;
  });

  const blank = MAX_CELLS - dishes.length;
  const unused = blank === 0
    ? "All sixteen cells are used."
    : `Cells ${dishes.length + 1} to ${MAX_CELLS} are unused: leave them ` +
      "completely empty and fully transparent. Do not draw anything in them, " +
      "and do not rearrange the used cells to fill the space.";

  return [
    `A single square image containing exactly ${MAX_CELLS} food illustrations ` +
    `arranged in an even ${GRID}-column by ${GRID}-row grid, numbered left to ` +
    "right along each row and then down to the next row.",
    "",
    "Style, identical in every cell:",
    "- clean semi-realistic clip-art cookbook illustration",
    "- straight overhead view, seen from directly above",
    "- exactly one serving vessel per dish: a plate, bowl, dish or board",
    "- fully transparent background, no shadow cast onto the background",
    "- no props, no cutlery, no hands, no people, no surface, no decoration",
    "- no text, no numbers, no labels, no captions, no logos, no watermarks",
    "- the same drawing scale, the same lighting and the same level of detail " +
    "in every cell, so the sixteen read as one set",
    "",
    "Layout, which matters as much as the drawing:",
    "- the sixteen cells are equal in size and evenly spaced",
    "- each dish sits well inside its own cell, filling roughly two thirds of " +
    "it, centred, and never touching or crossing the cell boundary",
    "- leave generous fully transparent gutters between the cells and around " +
    "the outside of the grid",
    "- no cell's dish may overlap or touch another cell's dish",
    "",
    unused,
    "",
    "The dishes, in grid order:",
    ...cells,
  ].join("\n");
}

/**
 * Buy one contact sheet. One request for the whole batch — that is the entire
 * economic point, so there is no per-dish path here to fall back to.
 *
 * A refusal is a `GenerationError` with something a caller can show. The key
 * never appears in one, and neither does the recipe payload: what is worth
 * logging about a generation is which model, how many dishes and what the
 * provider said, not the household's private recipes.
 */
export async function generateContactSheet(
  env: Env,
  dishes: readonly DishBrief[],
): Promise<GeneratedSheet> {
  const key = env.OPENAI_API_KEY;
  if (!key) {
    throw new GenerationError("Image generation is not configured on this deployment.");
  }

  const body = JSON.stringify({
    model: MODEL,
    prompt: sheetPrompt(dishes),
    n: 1,
    size: SIZE,
    quality: QUALITY,
    // Transparency is not cosmetic: it is what makes the sheet separable at
    // all, because the splitter finds a dish by following its own alpha.
    background: "transparent",
    output_format: "png",
  });

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const why = error instanceof Error && error.name === "TimeoutError"
      ? `no answer within ${Math.round(TIMEOUT_MS / 1000)} seconds`
      : "the request could not be made";
    throw new GenerationError(`Image generation failed: ${why}.`);
  }

  const text = await readBounded(response);

  if (!response.ok) {
    throw new GenerationError(
      `Image generation failed: ${MODEL} answered ${response.status}. ${providerMessage(text)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GenerationError("Image generation returned something that is not JSON.");
  }

  const base64 = firstImage(parsed);
  if (base64 === null) {
    throw new GenerationError("Image generation returned no image.");
  }

  return {
    png: decodeBase64(base64),
    model: MODEL,
    styleVersion: STYLE_VERSION,
    generatedBy: GENERATED_BY,
    usage: (parsed as { usage?: unknown }).usage ?? null,
  };
}

/**
 * Read the body, stopping if it grows past the cap. The declared length is
 * checked first where there is one, but it is the caller's claim rather than a
 * fact, so the read is bounded as it goes too.
 */
async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new GenerationError("Image generation returned more data than we will read.");
  }

  if (response.body === null) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let out = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new GenerationError("Image generation returned more data than we will read.");
    }
    out += decoder.decode(value, { stream: true });
  }

  return out + decoder.decode();
}

/** gpt-image-1 always answers with base64; there is no URL form to fall back to. */
function firstImage(parsed: unknown): string | null {
  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0] as { b64_json?: unknown };
  return typeof first?.b64_json === "string" && first.b64_json.length > 0
    ? first.b64_json
    : null;
}

/** The provider's own explanation, if it gave one, and nothing else. */
function providerMessage(text: string): string {
  try {
    const error = (JSON.parse(text) as { error?: { message?: unknown } }).error;
    if (typeof error?.message === "string") return error.message;
  } catch {
    // Not JSON. Saying so is more use than echoing an HTML error page.
  }
  return "No explanation was given.";
}

function decodeBase64(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new GenerationError("Image generation returned an image we cannot decode.");
  }
  const out = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) out[at] = binary.charCodeAt(at);
  return out;
}
