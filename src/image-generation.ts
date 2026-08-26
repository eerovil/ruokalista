import { GRID, MAX_CELLS } from "./contact-sheet.ts";
import type { FingerprintRecipe } from "./recipe-fingerprint.ts";

/**
 * The prompt that asks for sixteen recipe pictures at once, and nothing that
 * sends it.
 *
 * The picture wanted here is not a picture of a dish — it is a *contact sheet*:
 * one square image holding a 4x4 grid of sixteen dishes on transparent
 * background, which `contact-sheet.ts` cuts apart into sixteen recipe pictures.
 * Sixteen dishes for one drawing is the whole point, whoever does the drawing.
 *
 * **There is no image API call in this app.** #96 built one, against OpenAI,
 * and #111 removed it: the Workers Free plan gives a request 10 ms of CPU, and
 * cutting one sheet needs well over a second of it, so the paid route could
 * never finish. The one live attempt ran 178 seconds, was killed with
 * `exceededResources`, and threw away the sheet it had just bought. See
 * `docs/adr/0005-the-worker-does-no-pixel-work.md`.
 *
 * So what is left is the prompt, which an admin copies and takes to whichever
 * image tool they like. That makes this module the shared contract rather than
 * an implementation detail: the sheet the admin brings back is cut against the
 * grid this prompt asked for, and the two agreeing is what makes the mapping
 * from cell to recipe true.
 *
 * Three things about the prompt are load-bearing rather than decorative:
 *
 *   - It always asks for sixteen cells, even for a batch of three. A grid whose
 *     shape depends on the batch size would put a three-dish batch's cells
 *     somewhere else on the sheet, and the splitter's nominal grid is what maps
 *     a cell back to a recipe. Unused cells are asked for empty and ignored.
 *   - It asks for generous transparent gutters and for each dish to sit well
 *     inside its cell. That slack is what the splitter recovers with when the
 *     drawing strays a little outside the lines, which a real sheet did. The
 *     transparency is not cosmetic either: it is the only thing the dishes are
 *     told apart by, and a sheet without it is refused by name.
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
 * Bumped whenever the style text below changes. Stored with every generated
 * picture, so a household can be told which rules drew what.
 */
export const STYLE_VERSION = "s1";

/**
 * What gets written into `image_generated_by`.
 *
 * It used to name the provider and model that were paid for the sheet. Nothing
 * is paid now, and nothing here knows which tool the admin used — they copied a
 * prompt and came back with a file — so what it records is the true and useful
 * part: a person supplied the sheet, drawn to our prompt under this style
 * version. Bumping `STYLE_VERSION` therefore dates every picture in the
 * household, which is the point of storing it at all.
 *
 * Pictures made before #111 carry `openai:gpt-image-2/s1`. Those are still
 * generated pictures drawn from the same style text, so they read as fresh and
 * are compared the same way; only the string differs.
 */
export const GENERATED_BY = `supplied:manual/${STYLE_VERSION}`;

/** How many ingredients of a dish reach the brief. */
const INGREDIENTS_PER_DISH = 8;

/** One requested dish, in manifest order. */
export interface DishBrief {
  recipeId: number;
  title: string;
  /** The ingredient names that decide what the dish looks like. */
  ingredients: string[];
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
