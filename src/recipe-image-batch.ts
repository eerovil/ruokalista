import { problem } from "./auth.ts";
import {
  MAX_CELLS,
  OUTPUT_EDGE,
  PngError,
  splitContactSheet,
  type CellProblem,
  type Crop,
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
export interface CellReport {
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
  const body = await readBody(ctx.request);
  if (body === null) return problem(400, "Send a JSON body.");

  const outcome = await runImageBatch(ctx, member, body.recipeIds, body.sheetBase64);

  if (outcome.kind === "refused") return problem(outcome.status, outcome.english);

  if (outcome.kind === "rejected") {
    // Nothing has been written, and nothing will be. The reasons name cells and
    // recipes together, because "cell 7" means nothing to whoever asked for a
    // list of recipes.
    return Response.json(
      {
        stored: 0,
        rejected: true,
        model: outcome.model,
        styleVersion: outcome.styleVersion,
        reason: SHEET_REJECTED,
        cells: outcome.cells,
      },
      { status: 422 },
    );
  }

  return Response.json({
    stored: outcome.stored,
    rejected: false,
    model: outcome.model,
    styleVersion: outcome.styleVersion,
    generatedBy: outcome.generatedBy,
    sheet: outcome.sheet,
    cropEdge: OUTPUT_EDGE,
    usage: outcome.usage,
    cells: outcome.cells,
  });
}

/** What a sheet that could not be cut is reported as, whoever asked. */
export const SHEET_REJECTED =
  "The generated sheet could not be cut apart safely, so nothing was " +
  "changed. Generate again to try another sheet.";

/**
 * How one batch came out, before anybody decides how to say it.
 *
 * There are two callers — the JSON route above and the admin screen in
 * `recipe-image-admin.ts` — and one of them has to render Finnish while the
 * other renders a machine-readable body. Everything that could differ between
 * them is a way for the two to disagree about what a batch did, so the work
 * itself happens once here and only the words are written twice.
 */
export type BatchOutcome =
  | { kind: "refused"; status: number; english: string }
  | {
      kind: "rejected";
      model: string;
      styleVersion: string;
      cells: CellReport[];
    }
  | {
      kind: "stored";
      stored: number;
      model: string;
      styleVersion: string;
      generatedBy: string;
      sheet: { width: number; height: number };
      usage: unknown;
      cells: CellReport[];
    };

/**
 * Buy one sheet, cut it up, and store what came out. The order of the work is
 * the safety property described at the top of this module, and it lives here so
 * that no caller can reorder it.
 */
export async function runImageBatch(
  ctx: RouteContext,
  member: Member,
  rawIds: unknown,
  sheetBase64?: string,
): Promise<BatchOutcome> {
  const { env, url } = ctx;

  const ids = readIds(rawIds);
  if (typeof ids === "string") return { kind: "refused", status: 400, english: ids };

  // Load every recipe first. A batch naming a recipe this household does not
  // have is refused before any money is spent, and the fingerprint is taken
  // from the same read the brief is written from — so the picture records the
  // recipe it was actually drawn from, not the recipe as it stands whenever the
  // bytes happen to land.
  const dishes: DishBrief[] = [];
  const plan: CropPlan[] = [];

  for (const id of ids) {
    const recipe = await findRecipe(env.DB, member.householdId, id);
    if (recipe === null) {
      return { kind: "refused", status: 404, english: `No such recipe: ${id}.` };
    }
    const dish = dishBrief(id, recipe);
    dishes.push(dish);
    const row = await imageRow(env.DB, member.householdId, id);
    plan.push({
      cell: plan.length,
      recipeId: id,
      title: dish.title,
      fingerprint: await recipeFingerprint(recipe),
      // The picture this recipe has *now*. Sixteen crops later it may not be,
      // and `storeRecipeImage` will say so rather than overwrite a stranger.
      expectedKey: row?.image_key ?? null,
    });
  }

  let sheet: GeneratedSheet;
  try {
    sheet = await sheetFor(ctx, sheetBase64, dishes);
  } catch (error) {
    if (error instanceof GenerationError) {
      return { kind: "refused", status: 502, english: error.message };
    }
    throw error;
  }

  let split;
  try {
    split = await splitContactSheet(sheet.png, dishes.length);
  } catch (error) {
    if (error instanceof PngError) {
      return {
        kind: "refused",
        status: 502,
        english: `The generated sheet is not an image we can cut: ${error.message}`,
      };
    }
    throw error;
  }

  if (!split.ok) {
    return {
      kind: "rejected",
      model: sheet.model,
      styleVersion: sheet.styleVersion,
      cells: rejectionReport(dishes, split.problems),
    };
  }

  // Past here every crop exists and has been checked, so the writes begin.
  const { stored, cells } = await commitCrops(
    env,
    member.householdId,
    plan,
    split.crops,
    sheet.generatedBy,
  );

  // Worth knowing, and none of it private: which model, how big the sheet was,
  // how many dishes it held. Not the prompt, not the recipes, not the key.
  console.log(
    `recipe-image batch: ${stored}/${dishes.length} stored, ` +
      `${sheet.model} style ${sheet.styleVersion}, ` +
      `sheet ${split.sheet.width}x${split.sheet.height}, ` +
      `crops ${OUTPUT_EDGE}px, local sheet ${isLocalOrigin(url) && sheetBase64 ? "yes" : "no"}`,
  );

  return {
    kind: "stored",
    stored,
    model: sheet.model,
    styleVersion: sheet.styleVersion,
    generatedBy: sheet.generatedBy,
    sheet: split.sheet,
    usage: sheet.usage,
    cells,
  };
}

/** One cell's worth of what has to be known before the sheet is even bought. */
export interface CropPlan {
  cell: number;
  recipeId: number;
  title: string;
  /** The recipe content this picture will be a picture of. */
  fingerprint: string;
  /** The picture the row held when it was read, which the write is conditional on. */
  expectedKey: string | null;
}

/**
 * Store every validated crop, and say what happened to each.
 *
 * **A recipe already given its picture keeps it.** If the fourth crop cannot be
 * stored, the three before it are not undone — deleting three good pictures to
 * tidy up one failure would destroy work to make the bookkeeping neater, and
 * every one of those three is a correct picture of its recipe made from a
 * fingerprint that still matches. So this is not a transaction, and the report
 * is the record: the response names each recipe and whether it got its picture.
 * Nothing is silently half-done.
 *
 * Nor does one failure stop the rest. The sheet is already paid for; abandoning
 * twelve good crops because the fourth hit a storage error would waste them.
 *
 * The three ways one crop can fail to land:
 *
 *   - the recipe's picture changed while the sheet was being drawn, so the
 *     compare-and-swap in `storeRecipeImage` declines rather than overwriting
 *   - the recipe was deleted in the same window, which looks the same
 *   - the write itself failed — R2 or D1 was unavailable
 *
 * The first two are refusals and come back as text. The third is thrown, and is
 * caught here so it becomes this recipe's answer rather than the whole batch's.
 *
 * Exported because a storage failure cannot be provoked through a browser, and
 * `dev/check-recipe-image-commit.ts` drives it with a bucket and a database that
 * fail on demand.
 */
export async function commitCrops(
  env: RouteContext["env"],
  householdId: number,
  plan: readonly CropPlan[],
  crops: readonly Crop[],
  generatedBy: string,
): Promise<{ stored: number; cells: CellReport[] }> {
  const cells: CellReport[] = [];
  let stored = 0;

  for (const crop of crops) {
    const entry = plan[crop.cell];
    if (entry === undefined) continue;

    let refusal: Awaited<ReturnType<typeof storeRecipeImage>>;
    try {
      refusal = await storeRecipeImage(
        env,
        householdId,
        entry.recipeId,
        entry.expectedKey,
        // A fresh copy, because the stored bytes outlive the raster they were cut
        // from and a view onto a larger buffer would keep the whole sheet alive.
        crop.png.slice().buffer,
        { origin: "generated", fingerprint: entry.fingerprint, model: generatedBy },
      );
    } catch (error) {
      // `storeRecipeImage` has already removed its own object, so there is
      // nothing of ours left behind — only a recipe that did not get a picture.
      cells.push({
        ...report(entry),
        status: "not-stored",
        reason: `storing it failed: ${message(error)}`,
      });
      continue;
    }

    if (refusal === null) {
      stored += 1;
      cells.push({ ...report(entry), status: "stored" });
    } else {
      cells.push({ ...report(entry), status: "not-stored", reason: refusal.english });
    }
  }

  return { stored, cells };
}

function report(entry: CropPlan): Pick<CellReport, "cell" | "recipeId" | "title"> {
  return { cell: entry.cell, recipeId: entry.recipeId, title: entry.title };
}

/** An error's own words, and nothing about where it came from. */
function message(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "the storage layer gave no reason";
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
  sheetBase64: string | undefined,
  dishes: readonly DishBrief[],
): Promise<GeneratedSheet> {
  if (sheetBase64 === undefined) return generateContactSheet(env, dishes);

  if (!isLocalOrigin(url)) {
    throw new GenerationError("A sheet can only be supplied on a development server.");
  }

  let binary: string;
  try {
    binary = atob(sheetBase64);
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
