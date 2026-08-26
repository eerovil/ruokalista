import { problem } from "./auth.ts";
import {
  MAX_CELLS,
  OUTPUT_EDGE,
  PngError,
  splitContactSheet,
  type CellProblem,
} from "./contact-sheet.ts";
import {
  dishBrief,
  generateContactSheet,
  GenerationError,
  STYLE_VERSION,
  type DishBrief,
  type GeneratedSheet,
} from "./image-generation.ts";
import type { Member } from "./members.ts";
import { isLocalOrigin } from "./public-origin.ts";
import { recipeFingerprint } from "./recipe-fingerprint.ts";
import { imageRow, storeRecipeImage } from "./recipe-images.ts";
import { findRecipe } from "./recipes.ts";
import type { RouteContext } from "./router.ts";

/**
 * `POST /api/admin/recipe-images/generate` — buy one contact sheet, cut it up,
 * and give up to sixteen recipes a picture.
 *
 * This is the first thing behind the admin boundary from #94, and it is what
 * that boundary was built for: it spends money and it replaces pictures in
 * bulk. An ordinary member is told the route is not there.
 *
 * The order of work is the safety property. Everything that can refuse does so
 * before anything is written: the recipes are loaded and fingerprinted, the
 * sheet is bought, and the sheet is cut into sixteen validated crops — and only
 * then does the first byte reach R2. So a sheet the splitter would not trust
 * costs a request and changes nothing: no picture is replaced, no recipe is
 * marked fresh, and the caller can retry, which means buying one more sheet
 * while the cutting stays local and free.
 *
 * There is no automatic retry. A rejected sheet is a decision — try again, or
 * look at why sixteen dishes came back joined together — and a route that
 * quietly bought three sheets to answer one request would be spending the
 * household's money on that decision's behalf.
 */

/** How each requested recipe came out. */
interface CellReport {
  cell: number;
  recipeId: number;
  title: string;
  status: "stored" | "rejected" | "not-stored";
  /** Why, when it is not `stored`. */
  reason?: string;
}

/**
 * The manifest a caller posts: recipe ids in the order they take cells, cell 1
 * first. `sheetBase64` is the development escape hatch described below.
 */
interface GenerateRequest {
  recipeIds: number[];
  sheetBase64?: string;
}

export async function generateRecipeImages(
  ctx: RouteContext,
  member: Member,
): Promise<Response> {
  const { env, request, url } = ctx;

  const body = await readBody(request);
  if (body === null) return problem(400, "Send a JSON body.");

  const ids = readIds(body.recipeIds);
  if (typeof ids === "string") return problem(400, ids);

  // Load every recipe first. A batch naming a recipe this household does not
  // have is refused before any money is spent, and the fingerprint is taken
  // from the same read the brief is written from — so the picture records the
  // recipe it was actually drawn from, not the recipe as it stands whenever the
  // bytes happen to land.
  const dishes: DishBrief[] = [];
  const fingerprints: string[] = [];
  const oldKeys: (string | null)[] = [];

  for (const id of ids) {
    const recipe = await findRecipe(env.DB, member.householdId, id);
    if (recipe === null) return problem(404, `No such recipe: ${id}.`);
    dishes.push(dishBrief(id, recipe));
    fingerprints.push(await recipeFingerprint(recipe));
    const row = await imageRow(env.DB, member.householdId, id);
    oldKeys.push(row?.image_key ?? null);
  }

  let sheet: GeneratedSheet;
  try {
    sheet = await sheetFor(ctx, body, dishes);
  } catch (error) {
    if (error instanceof GenerationError) return problem(502, error.message);
    throw error;
  }

  let split;
  try {
    split = await splitContactSheet(sheet.png, dishes.length);
  } catch (error) {
    if (error instanceof PngError) {
      return problem(502, `The generated sheet is not an image we can cut: ${error.message}`);
    }
    throw error;
  }

  if (!split.ok) {
    // Nothing has been written, and nothing will be. The reasons name cells and
    // recipes together, because "cell 7" means nothing to whoever asked for a
    // list of recipes.
    return Response.json(
      {
        stored: 0,
        rejected: true,
        model: sheet.model,
        styleVersion: sheet.styleVersion,
        reason:
          "The generated sheet could not be cut apart safely, so nothing was " +
          "changed. Generate again to try another sheet.",
        cells: rejectionReport(dishes, split.problems),
      },
      { status: 422 },
    );
  }

  // Past here every crop exists and has been checked, so the writes begin.
  const cells: CellReport[] = [];
  let stored = 0;

  for (const crop of split.crops) {
    const dish = dishes[crop.cell]!;
    const refusal = await storeRecipeImage(
      env,
      member.householdId,
      dish.recipeId,
      oldKeys[crop.cell]!,
      // A fresh copy, because the stored bytes outlive the raster they were cut
      // from and a view onto a larger buffer would keep the whole sheet alive.
      crop.png.slice().buffer,
      {
        origin: "generated",
        fingerprint: fingerprints[crop.cell]!,
        model: sheet.generatedBy,
      },
    );

    if (refusal === null) {
      stored += 1;
      cells.push({ cell: crop.cell, recipeId: dish.recipeId, title: dish.title, status: "stored" });
    } else {
      cells.push({
        cell: crop.cell,
        recipeId: dish.recipeId,
        title: dish.title,
        status: "not-stored",
        reason: refusal.english,
      });
    }
  }

  // Worth knowing, and none of it private: which model, how big the sheet was,
  // how many dishes it held. Not the prompt, not the recipes, not the key.
  console.log(
    `recipe-image batch: ${stored}/${dishes.length} stored, ` +
      `${sheet.model} style ${sheet.styleVersion}, ` +
      `sheet ${split.sheet.width}x${split.sheet.height}, ` +
      `crops ${OUTPUT_EDGE}px, local sheet ${isLocalOrigin(url) && body.sheetBase64 ? "yes" : "no"}`,
  );

  return Response.json({
    stored,
    rejected: false,
    model: sheet.model,
    styleVersion: sheet.styleVersion,
    generatedBy: sheet.generatedBy,
    sheet: split.sheet,
    cropEdge: OUTPUT_EDGE,
    usage: sheet.usage,
    cells,
  });
}

/**
 * Where the sheet comes from.
 *
 * Normally: one paid request. But a development server may post the sheet's
 * bytes itself, which is the same bargain `Avaa esimerkkiluonnos` strikes for
 * intake — every part of the flow that can go wrong for free is exercised for
 * free, and only the model call is skipped. It is how the browser suite covers
 * the splitting, the commit and the freshness bookkeeping without ever calling
 * OpenAI.
 *
 * The gate is the address the browser reached, not a flag: a deployed Worker is
 * only ever addressed by a public hostname, so nothing anybody can set —
 * including `wrangler secret put` — turns this on live. Note also what it is
 * not: it is not a way past the admin wall, which has already refused anyone it
 * was going to refuse before this function runs.
 */
async function sheetFor(
  { env, url }: RouteContext,
  body: GenerateRequest,
  dishes: readonly DishBrief[],
): Promise<GeneratedSheet> {
  if (body.sheetBase64 === undefined) return generateContactSheet(env, dishes);

  if (!isLocalOrigin(url)) {
    throw new GenerationError("A sheet can only be supplied on a development server.");
  }

  let binary: string;
  try {
    binary = atob(body.sheetBase64);
  } catch {
    throw new GenerationError("The supplied sheet is not base64.");
  }
  const png = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) png[at] = binary.charCodeAt(at);

  return {
    png,
    model: "supplied",
    styleVersion: STYLE_VERSION,
    generatedBy: `local:supplied/${STYLE_VERSION}`,
    usage: null,
  };
}

/** Every cell's verdict for a sheet that was rejected whole. */
function rejectionReport(
  dishes: readonly DishBrief[],
  problems: readonly CellProblem[],
): CellReport[] {
  return dishes.map((dish, cell) => {
    const mine = problems.filter((entry) => entry.cell === cell);
    return mine.length === 0
      ? { cell, recipeId: dish.recipeId, title: dish.title, status: "not-stored" as const,
          reason: "another cell on this sheet was rejected" }
      : { cell, recipeId: dish.recipeId, title: dish.title, status: "rejected" as const,
          reason: mine.map((entry) => entry.reason).join("; ") };
  });
}

async function readBody(request: Request): Promise<GenerateRequest | null> {
  try {
    const parsed = await request.json();
    return parsed !== null && typeof parsed === "object"
      ? (parsed as GenerateRequest)
      : null;
  } catch {
    return null;
  }
}

/** The manifest, or the complaint about it. Order is the contract. */
function readIds(raw: unknown): number[] | string {
  if (!Array.isArray(raw)) return "recipeIds must be an array of recipe ids.";
  if (raw.length === 0) return "Ask for at least one recipe.";
  if (raw.length > MAX_CELLS) {
    return `A sheet holds ${MAX_CELLS} recipes; ${raw.length} were asked for.`;
  }

  const ids: number[] = [];
  for (const value of raw) {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
      return "Every recipe id must be a positive whole number.";
    }
    if (ids.includes(value as number)) {
      return `Recipe ${value} is listed twice; one recipe takes one cell.`;
    }
    ids.push(value as number);
  }

  return ids;
}
