import { problem } from "./auth.ts";
import { MAX_IMAGE_BYTES } from "./image-bytes.ts";
import {
  imageStatus,
  type ImageOrigin,
  type ImageStatus,
  type StoredImage,
} from "./image-freshness.ts";
import {
  removeRecipeImage,
  storeRecipeImage,
  type ImageProvenance,
} from "./recipe-image-lifecycle.ts";
import type { Member } from "./members.ts";
import { recipeFingerprint } from "./recipe-fingerprint.ts";
import { readableRecipeCondition } from "./recipe-publish.ts";
import { findRecipe } from "./recipes.ts";
import type { RouteContext } from "./router.ts";

/**
 * A recipe picture's HTTP and read adapter. The bytes live in R2 and the recipe
 * row holds the key.
 *
 * Upload/replace/remove CAS, retirement receipts, uncertain-write retention and
 * delayed cleanup live together in `recipe-image-lifecycle.ts`. The routes here
 * resolve ownership/provenance, translate lifecycle refusals to HTTP, serve the
 * current bytes and expose freshness state.
 */

export { removeRecipeImage, storeRecipeImage } from "./recipe-image-lifecycle.ts";
export type { ImageProvenance } from "./recipe-image-lifecycle.ts";

interface ImageRow {
  image_key: string | null;
}

interface FreshnessRow extends ImageRow {
  image_origin: ImageOrigin | null;
  image_fingerprint: string | null;
  image_generated_at: string | null;
  image_generated_by: string | null;
}

/** GET /api/recipes/:id/image */
export async function apiRecipeImage(
  { env, request, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipeId = parseRecipeId(params["id"]);
  if (recipeId === null) return problem(404, "No such recipe.");

  // The one lookup on this module that is not owner-scoped: a published dish
  // is readable by everybody, and a picture nobody else may fetch would show
  // as a broken image on every screen that offers them the dish. Storing,
  // removing and the freshness read stay owner-scoped.
  const row = await readableImageRow(env.DB, member.householdId, recipeId);
  if (row === null || row.image_key === null) {
    return problem(404, "No image for that recipe.");
  }

  return serveRecipeImage(env, request, row);
}

/** GET /api/admin/recipe-images/:id — admin-only private thumbnail access. */
export async function apiAdminRecipeImage(
  { env, request, params }: RouteContext,
  _member: Member,
): Promise<Response> {
  const recipeId = parseRecipeId(params["id"]);
  if (recipeId === null) return problem(404, "No such recipe.");

  const row = await env.DB
    .prepare(
      `SELECT image_key
         FROM recipe
        WHERE id = ? AND parent_id IS NULL`,
    )
    .bind(recipeId)
    .first<ImageRow>();
  if (row === null || row.image_key === null) {
    return problem(404, "No image for that recipe.");
  }

  return serveRecipeImage(env, request, row);
}

async function serveRecipeImage(
  env: RouteContext["env"],
  request: Request,
  row: ImageRow,
): Promise<Response> {
  if (row.image_key === null) return problem(404, "No image for that recipe.");

  const object = await env.RECIPE_IMAGES.get(row.image_key, {
    onlyIf: request.headers,
  });
  if (object === null) return problem(404, "Recipe image is missing.");

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, no-cache");
  headers.set("x-content-type-options", "nosniff");

  if (!("body" in object)) return new Response(null, { status: 304, headers });
  return new Response(object.body, { headers });
}

/**
 * PUT /api/recipes/:id/image — raw image bytes, suitable for bulk tooling.
 *
 * `?origin=generated` records the picture as generated rather than uploaded,
 * with `&model=` for diagnostics and `&fingerprint=` for the recipe content it
 * was made from. `x-expected-image-key` carries the image state the caller saw
 * before any long generation gap; an empty value means it saw no image.
 */
export async function apiPutRecipeImage(
  { env, request, url, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipeId = parseRecipeId(params["id"]);
  if (recipeId === null) return problem(404, "No such recipe.");

  const row = await imageRow(env.DB, member.householdId, recipeId);
  if (row === null) return problem(404, "No such recipe.");

  return putRecipeImage(
    env,
    request,
    url,
    member.householdId,
    recipeId,
    row,
  );
}

/**
 * PUT /api/admin/recipe-images/:id — the admin image manager's only write.
 *
 * This route deliberately resolves the recipe's owner instead of using the
 * admin's household. It is separately protected by `requireAdmin` in the route
 * table, accepts generated pictures only, and limits the exception to dishes
 * the admin screen can actually select.
 */
export async function apiAdminPutRecipeImage(
  { env, request, url, params }: RouteContext,
  _member: Member,
): Promise<Response> {
  const recipeId = parseRecipeId(params["id"]);
  if (recipeId === null) return problem(404, "No such recipe.");

  const owner = await env.DB
    .prepare(
      `SELECT household_id, image_key
         FROM recipe
        WHERE id = ? AND parent_id IS NULL`,
    )
    .bind(recipeId)
    .first<{ household_id: number; image_key: string | null }>();
  if (owner === null) return problem(404, "No such recipe.");

  if (url.searchParams.get("origin") !== "generated") {
    return problem(400, "Admin image generation requires origin=generated.");
  }

  return putRecipeImage(
    env,
    request,
    url,
    owner.household_id,
    recipeId,
    owner,
  );
}

async function putRecipeImage(
  env: RouteContext["env"],
  request: Request,
  url: URL,
  householdId: number,
  recipeId: number,
  row: ImageRow,
): Promise<Response> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    return problem(413, "Recipe image is too large (maximum 5 MiB).");
  }

  const origin = url.searchParams.get("origin");
  if (origin !== null && origin !== "manual" && origin !== "generated") {
    return problem(400, "origin must be manual or generated.");
  }

  let provenance: ImageProvenance = { origin: "manual" };
  if (origin === "generated") {
    const stated = url.searchParams.get("fingerprint");
    const fingerprint = stated ?? (await currentFingerprint(env.DB, householdId, recipeId));
    if (fingerprint === null) return problem(404, "No such recipe.");
    provenance = {
      origin: "generated",
      fingerprint,
      model: url.searchParams.get("model"),
    };
  }

  const statedExpected = request.headers.get("x-expected-image-key");
  const expectedKey = statedExpected === null
    ? row.image_key
    : (statedExpected.length === 0 ? null : statedExpected);

  const refusal = await storeRecipeImage(
    env,
    householdId,
    recipeId,
    expectedKey,
    await request.arrayBuffer(),
    provenance,
  );
  if (refusal !== null) return problem(refusal.status, refusal.english);
  return new Response(null, { status: 204 });
}

/** GET /api/recipes/:id/image/status — missing, fresh or stale. */
export async function apiRecipeImageStatus(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipeId = parseRecipeId(params["id"]);
  if (recipeId === null) return problem(404, "No such recipe.");

  const state = await recipeImageState(env.DB, member.householdId, recipeId);
  if (state === null) return problem(404, "No such recipe.");

  return Response.json(state);
}

/** What is known about one recipe's picture, freshness included. */
export interface RecipeImageState {
  recipeId: number;
  status: ImageStatus;
  origin: ImageOrigin | null;
  recipeFingerprint: string;
  imageFingerprint: string | null;
  generatedAt: string | null;
  generatedBy: string | null;
}

/**
 * Read one recipe's picture state. The fingerprint is of the whole dish — its
 * parts included — and `findRecipe` already knows how to load that shape.
 */
export async function recipeImageState(
  db: D1Database,
  householdId: number,
  recipeId: number,
): Promise<RecipeImageState | null> {
  const row = await db
    .prepare(
      `SELECT image_key, image_origin, image_fingerprint,
              image_generated_at, image_generated_by
         FROM recipe WHERE id = ? AND household_id = ?`,
    )
    .bind(recipeId, householdId)
    .first<FreshnessRow>();
  if (row === null) return null;

  const fingerprint = await currentFingerprint(db, householdId, recipeId);
  if (fingerprint === null) return null;

  const stored: StoredImage = {
    imageKey: row.image_key,
    imageOrigin: row.image_origin,
    imageFingerprint: row.image_fingerprint,
  };

  return {
    recipeId,
    status: imageStatus(stored, fingerprint),
    origin: row.image_key === null ? null : (row.image_origin ?? "manual"),
    recipeFingerprint: fingerprint,
    imageFingerprint: row.image_fingerprint,
    generatedAt: row.image_generated_at,
    generatedBy: row.image_generated_by,
  };
}

async function currentFingerprint(
  db: D1Database,
  householdId: number,
  recipeId: number,
): Promise<string | null> {
  const recipe = await findRecipe(db, householdId, recipeId);
  return recipe === null ? null : recipeFingerprint(recipe);
}

/** DELETE /api/recipes/:id/image */
export async function apiDeleteRecipeImage(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipeId = parseRecipeId(params["id"]);
  if (recipeId === null) return problem(404, "No such recipe.");

  const row = await imageRow(env.DB, member.householdId, recipeId);
  if (row === null) return problem(404, "No such recipe.");
  await removeRecipeImage(env, member.householdId, recipeId, row.image_key);
  return new Response(null, { status: 204 });
}

/** The owner-scoped row needed to carry a mutation's expected key. */
export async function imageRow(
  db: D1Database,
  householdId: number,
  recipeId: number,
): Promise<ImageRow | null> {
  return db
    .prepare("SELECT image_key FROM recipe WHERE id = ? AND household_id = ?")
    .bind(recipeId, householdId)
    .first<ImageRow>();
}

/**
 * The same row, in the scope that may read it: this household's recipe, any
 * published dish, or a part of one.
 */
async function readableImageRow(
  db: D1Database,
  householdId: number,
  recipeId: number,
): Promise<ImageRow | null> {
  return db
    .prepare(
      `SELECT recipe.image_key
         FROM recipe
         LEFT JOIN recipe AS parent ON parent.id = recipe.parent_id
        WHERE recipe.id = ?
          AND (${readableRecipeCondition("recipe")}
               OR ${readableRecipeCondition("parent")})`,
    )
    .bind(
      recipeId,
      householdId,
      householdId,
      householdId,
      householdId,
    )
    .first<ImageRow>();
}

function parseRecipeId(raw: string | undefined): number | null {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
