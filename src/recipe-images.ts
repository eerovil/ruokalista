import { problem } from "./auth.ts";
import { extensionFor, readImage } from "./image-bytes.ts";
import {
  imageStatus,
  type ImageOrigin,
  type ImageStatus,
  type StoredImage,
} from "./image-freshness.ts";
import type { Member } from "./members.ts";
import { readableRecipeCondition } from "./recipe-publish.ts";
import { recipeFingerprint } from "./recipe-fingerprint.ts";
import { findRecipe } from "./recipes.ts";
import type { RouteContext } from "./router.ts";

/**
 * A recipe's picture. The bytes live in R2 and the recipe row holds the key.
 *
 * This module is the storage and the JSON API. The editor's own upload and
 * remove buttons live in `recipe-editor.ts` with the rest of the editor, and
 * call into `storeRecipeImage`/`removeRecipeImage` here — so a refusal can be
 * rendered as a screen there and as JSON here, from one set of rules.
 *
 * It is also where a picture's provenance is written: whether somebody uploaded
 * it or something generated it, and for a generated one, which recipe
 * fingerprint it was made from. `image-freshness.ts` turns that into missing /
 * fresh / stale.
 */

/**
 * What we will take in. The byte cap is the ingest guard; the edge cap is the
 * one that matters, because it is pixels that make a picture too big to store
 * and too wide to read on a phone. The editor shrinks before it posts, so only
 * a bulk caller ever meets these.
 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_EDGE = 2000;

/** A refusal, in both languages this app has to refuse in. */
export interface ImageRefusal {
  status: number;
  english: string;
  finnish: string;
}

interface ImageRow {
  image_key: string | null;
}

/**
 * Where a picture being stored came from. A generated one states the
 * fingerprint it was made from rather than having it read back out of the
 * database, because what matters is the recipe the picture actually depicts —
 * not the recipe as it stands the moment the bytes arrive.
 */
export type ImageProvenance =
  | { origin: "manual" }
  | { origin: "generated"; fingerprint: string; model: string | null };

const MANUAL: ImageProvenance = { origin: "manual" };

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
  // removing and the freshness read stay on `imageRow` below, so widening this
  // cannot widen a write.
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

  // A key is unique per upload, but the URL that reaches it is not: replacing
  // an image leaves `/api/recipes/:id/image` pointing at different bytes. So
  // the browser revalidates every time and pays for the body only when the
  // etag has actually moved, rather than showing yesterday's picture.
  const object = await env.RECIPE_IMAGES.get(row.image_key, {
    onlyIf: request.headers,
  });
  if (object === null) return problem(404, "Recipe image is missing.");

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, no-cache");
  // These bytes came from outside and are served from this app's own origin.
  // The signature check at upload says they are an image; this says no browser
  // may decide otherwise.
  headers.set("x-content-type-options", "nosniff");

  if (!("body" in object)) return new Response(null, { status: 304, headers });
  return new Response(object.body, { headers });
}

/**
 * PUT /api/recipes/:id/image — raw image bytes, suitable for bulk tooling.
 *
 * `?origin=generated` records the picture as generated rather than uploaded,
 * with `&model=` for the diagnostics and `&fingerprint=` for the recipe content
 * it was actually made from. A generator that read the recipe, spent money on a
 * picture, and comes back to store it should state that fingerprint: leaving it
 * out means "made from the recipe as it stands right now", which is a claim
 * about a recipe nobody looked at. A caller with a long gap between reading and
 * writing also sends `x-expected-image-key`; an empty value means it saw no
 * image. That captured state, not the key current when the PUT arrives, is the
 * compare-and-swap precondition.
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
 * the admin screen can actually select. The ordinary image API above keeps its
 * household predicate unchanged.
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
    return problem(413, tooLarge().english);
  }

  const origin = url.searchParams.get("origin");
  if (origin !== null && origin !== "manual" && origin !== "generated") {
    return problem(400, "origin must be manual or generated.");
  }

  let provenance: ImageProvenance = MANUAL;
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

/**
 * GET /api/recipes/:id/image/status — missing, fresh or stale, and what that
 * verdict was reached from.
 *
 * The calculation itself lives in `image-freshness.ts` and needs no request;
 * this is the way in for anything outside the Worker, which for now means the
 * batch generator and the admin list that are still to be built.
 */
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
  /** What the recipe's ingredients hash to right now. */
  recipeFingerprint: string;
  /** What the stored generated picture was made from, if it was generated. */
  imageFingerprint: string | null;
  generatedAt: string | null;
  generatedBy: string | null;
}

/**
 * Read one recipe's picture state. Two reads, because the fingerprint is of the
 * whole dish — its parts included — and that is what `findRecipe` already
 * loads; nothing here re-implements it.
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

/** The recipe's own content hash, or null if the recipe is not there. */
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

/**
 * Check, store, and point the recipe at the new object. Returns the refusal
 * when the bytes are not something we will keep, or null once they are stored.
 *
 * `oldKey` is not just the object to tidy up afterwards — it is the key this
 * caller believes the row still holds, and the update only happens if it does.
 * That matters because the gap between reading the row and writing it is not
 * always short: the admin can leave the confirmation screen to draw a sheet in
 * another tool. Without the check, somebody who uploaded a picture during that
 * gap would have it silently replaced by a generated crop made from older state.
 * With it, the loser is told so and the picture chosen last survives.
 */
export async function storeRecipeImage(
  env: RouteContext["env"],
  householdId: number,
  recipeId: number,
  oldKey: string | null,
  bytes: ArrayBuffer,
  provenance: ImageProvenance = MANUAL,
): Promise<ImageRefusal | null> {
  if (bytes.byteLength === 0) {
    return {
      status: 400,
      english: "Recipe image is empty.",
      finnish: "Valitse kuva.",
    };
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) return tooLarge();

  const facts = readImage(bytes);
  if (facts === null) {
    return {
      status: 415,
      english: "Use a JPEG, PNG, or WebP image.",
      finnish: "Kuvan pitää olla JPEG, PNG tai WebP.",
    };
  }
  if (Math.max(facts.width, facts.height) > MAX_IMAGE_EDGE) {
    return {
      status: 413,
      english:
        `Recipe image is ${facts.width}x${facts.height}; resize it so its ` +
        `longest edge is at most ${MAX_IMAGE_EDGE} pixels.`,
      finnish:
        `Kuva on ${facts.width}×${facts.height} kuvapistettä. Pienennä se ` +
        `niin, että pidempi sivu on enintään ${MAX_IMAGE_EDGE}.`,
    };
  }

  const key =
    `recipes/${householdId}/${recipeId}/${crypto.randomUUID()}.${extensionFor(facts.contentType)}`;

  // The bytes go first, so a failure here leaves the recipe pointing at the
  // picture it already had. The compensating delete below covers the other
  // order: an object stored for a row that turned out not to be there.
  await env.RECIPE_IMAGES.put(key, bytes, {
    httpMetadata: { contentType: facts.contentType },
  });

  let changed: number;
  try {
    // The provenance columns are written in the same statement as the key, so
    // there is no instant where a picture exists with somebody else's
    // fingerprint against it. A manual upload clears them all: it is not
    // compared against anything, and a leftover fingerprint would say it was.
    //
    // `image_key IS ?` rather than `=` on purpose: a recipe with no picture yet
    // has NULL there, and `= NULL` is never true in SQL, so `=` would refuse
    // every first upload. `IS` compares NULL to NULL as equal, which is exactly
    // the claim being made — "there was nothing here when I looked".
    const result = await env.DB
      .prepare(
        `UPDATE recipe
            SET image_key = ?,
                image_origin = ?,
                image_fingerprint = ?,
                image_generated_at = ${
          provenance.origin === "generated"
            ? "strftime('%Y-%m-%d %H:%M:%f', 'now')"
            : "NULL"
        },
                image_generated_by = ?
          WHERE id = ? AND household_id = ? AND image_key IS ?`,
      )
      .bind(
        key,
        provenance.origin,
        provenance.origin === "generated" ? provenance.fingerprint : null,
        provenance.origin === "generated" ? provenance.model : null,
        recipeId,
        householdId,
        oldKey,
      )
      .run();

    changed = result.meta.changes;
  } catch (error) {
    // The row was not written, so the object nothing points at goes now.
    await env.RECIPE_IMAGES.delete(key);
    throw error;
  }

  if (changed !== 1) {
    // Either the recipe is gone or its picture is no longer the one we read.
    // Either way this upload has lost, so it takes its own object with it and
    // leaves what is there alone — an orphan is the one thing that must not be
    // the outcome of losing a race.
    await env.RECIPE_IMAGES.delete(key);
    return staleImage();
  }

  if (oldKey !== null && oldKey !== key) await env.RECIPE_IMAGES.delete(oldKey);
  return null;
}

/**
 * Forget the recipe's image, then drop the bytes.
 *
 * Conditional on the same key, for the same reason as `storeRecipeImage`: a
 * remove that raced a replacement would otherwise clear the row of a picture it
 * never saw and delete the object it did see, leaving the new bytes in R2 with
 * nothing pointing at them. Removing a picture that is already gone is not an
 * error, so the answer to losing is silence rather than a refusal — the recipe
 * ends up how the person asked either way.
 */
export async function removeRecipeImage(
  env: RouteContext["env"],
  householdId: number,
  recipeId: number,
  oldKey: string | null,
): Promise<void> {
  const result = await env.DB
    .prepare(
      `UPDATE recipe
          SET image_key = NULL,
              image_origin = NULL,
              image_fingerprint = NULL,
              image_generated_at = NULL,
              image_generated_by = NULL
        WHERE id = ? AND household_id = ? AND image_key IS ?`,
    )
    .bind(recipeId, householdId, oldKey)
    .run();

  // Only drop the bytes if this is the row we cleared. If somebody replaced the
  // picture first, the object we were holding is already theirs to tidy up.
  if (result.meta.changes === 1 && oldKey !== null) {
    await env.RECIPE_IMAGES.delete(oldKey);
  }
}

/** Remove image objects for a recipe tree before the DB rows disappear. */
export async function deleteImagesForRecipeTree(
  env: RouteContext["env"],
  householdId: number,
  recipeId: number,
): Promise<void> {
  const { results } = await env.DB
    .prepare(
      `SELECT image_key
         FROM recipe
        WHERE household_id = ?
          AND (id = ? OR parent_id = ?)
          AND image_key IS NOT NULL`,
    )
    .bind(householdId, recipeId, recipeId)
    .all<{ image_key: string }>();

  await Promise.all(results.map((row) => env.RECIPE_IMAGES.delete(row.image_key)));
}

/** The one row this module reads, so a caller can pass the old key along. */
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
 * The same row, in the scope that may *read* it: this household's recipe, any
 * published dish, or a part of one.
 *
 * A part is never published on its own and never addressable on its own
 * either, but it is the owner's row inside a dish everybody may read, so its
 * picture is reachable through its published parent and no other way. This
 * mirrors `recipes.ts::findReadableRecipe`; it is a separate query only
 * because a picture needs one column rather than a whole recipe.
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

/**
 * Somebody else changed this recipe's picture while we were making ours. A 409
 * rather than a 404: the recipe is there, the request was well formed, and the
 * answer is simply that it is out of date.
 */
function staleImage(): ImageRefusal {
  return {
    status: 409,
    english:
      "This recipe's image changed while this one was being prepared, so it " +
      "was not replaced. Look at the current image and try again if it still " +
      "needs replacing.",
    finnish:
      "Reseptin kuva vaihtui samaan aikaan, joten sitä ei korvattu. Katso " +
      "nykyinen kuva ja yritä uudelleen, jos se pitää silti vaihtaa.",
  };
}

function tooLarge(): ImageRefusal {
  return {
    status: 413,
    english: "Recipe image is too large (maximum 5 MiB).",
    finnish: "Kuva on liian suuri (enintään 5 Mt).",
  };
}

function parseRecipeId(raw: string | undefined): number | null {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
