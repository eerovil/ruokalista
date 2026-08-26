import { problem } from "./auth.ts";
import type { Member } from "./members.ts";
import type { RouteContext } from "./router.ts";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

interface ImageRow {
  image_key: string | null;
}

/** GET /api/recipes/:id/image */
export async function apiRecipeImage(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipeId = parseRecipeId(params["id"]);
  if (recipeId === null) return problem(404, "No such recipe.");

  const row = await imageRow(env.DB, member.householdId, recipeId);
  if (row === null || row.image_key === null) {
    return problem(404, "No image for that recipe.");
  }

  const object = await env.RECIPE_IMAGES.get(row.image_key);
  if (object === null) return problem(404, "Recipe image is missing.");

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=3600");
  return new Response(object.body, { headers });
}

/** PUT /api/recipes/:id/image — raw image bytes, suitable for bulk tooling. */
export async function apiPutRecipeImage(
  { env, request, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipeId = parseRecipeId(params["id"]);
  if (recipeId === null) return problem(404, "No such recipe.");

  const row = await imageRow(env.DB, member.householdId, recipeId);
  if (row === null) return problem(404, "No such recipe.");

  const contentType = normalizedContentType(request.headers.get("content-type"));
  if (contentType === null) {
    return problem(415, "Use image/jpeg, image/png, or image/webp.");
  }

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    return problem(413, "Recipe image is too large (maximum 5 MiB).");
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return problem(400, "Recipe image is empty.");
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return problem(413, "Recipe image is too large (maximum 5 MiB).");
  }

  await replaceImage(env, member.householdId, recipeId, row.image_key, bytes, contentType);
  return new Response(null, { status: 204 });
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
  await removeImage(env, member.householdId, recipeId, row.image_key);
  return new Response(null, { status: 204 });
}

/** POST /recipes/:id/image — editor multipart upload. */
export async function uploadRecipeImageForm(
  { env, request, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipeId = parseRecipeId(params["id"]);
  if (recipeId === null) return formNotFound();

  const row = await imageRow(env.DB, member.householdId, recipeId);
  if (row === null) return formNotFound();

  const form = await request.formData();
  const entry = form.get("image");
  if (!(entry instanceof File) || entry.size === 0) {
    return problem(400, "Choose an image to upload.");
  }

  const contentType = normalizedContentType(entry.type);
  if (contentType === null) {
    return problem(415, "Use a JPEG, PNG, or WebP image.");
  }
  if (entry.size > MAX_IMAGE_BYTES) {
    return problem(413, "Recipe image is too large (maximum 5 MiB).");
  }

  await replaceImage(
    env,
    member.householdId,
    recipeId,
    row.image_key,
    await entry.arrayBuffer(),
    contentType,
  );

  return redirectToEditor(recipeId);
}

/** POST /recipes/:id/image/delete — editor remove button. */
export async function deleteRecipeImageForm(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipeId = parseRecipeId(params["id"]);
  if (recipeId === null) return formNotFound();

  const row = await imageRow(env.DB, member.householdId, recipeId);
  if (row === null) return formNotFound();
  await removeImage(env, member.householdId, recipeId, row.image_key);
  return redirectToEditor(recipeId);
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

async function replaceImage(
  env: RouteContext["env"],
  householdId: number,
  recipeId: number,
  oldKey: string | null,
  bytes: ArrayBuffer,
  contentType: string,
): Promise<void> {
  const key = `recipes/${householdId}/${recipeId}/${crypto.randomUUID()}.${extensionFor(contentType)}`;

  await env.RECIPE_IMAGES.put(key, bytes, {
    httpMetadata: { contentType },
    customMetadata: {
      householdId: String(householdId),
      recipeId: String(recipeId),
    },
  });

  try {
    const result = await env.DB
      .prepare(
        "UPDATE recipe SET image_key = ? WHERE id = ? AND household_id = ?",
      )
      .bind(key, recipeId, householdId)
      .run();

    if (result.meta.changes !== 1) throw new Error("Recipe disappeared during image upload.");
  } catch (error) {
    await env.RECIPE_IMAGES.delete(key);
    throw error;
  }

  if (oldKey !== null && oldKey !== key) await env.RECIPE_IMAGES.delete(oldKey);
}

async function removeImage(
  env: RouteContext["env"],
  householdId: number,
  recipeId: number,
  oldKey: string | null,
): Promise<void> {
  await env.DB
    .prepare("UPDATE recipe SET image_key = NULL WHERE id = ? AND household_id = ?")
    .bind(recipeId, householdId)
    .run();
  if (oldKey !== null) await env.RECIPE_IMAGES.delete(oldKey);
}

async function imageRow(
  db: D1Database,
  householdId: number,
  recipeId: number,
): Promise<ImageRow | null> {
  return db
    .prepare("SELECT image_key FROM recipe WHERE id = ? AND household_id = ?")
    .bind(recipeId, householdId)
    .first<ImageRow>();
}

function parseRecipeId(raw: string | undefined): number | null {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizedContentType(raw: string | null): string | null {
  const type = (raw ?? "").split(";", 1)[0]!.trim().toLowerCase();
  return ALLOWED_TYPES.has(type) ? type : null;
}

function extensionFor(contentType: string): string {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/webp") return "webp";
  return "png";
}

function redirectToEditor(recipeId: number): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: `/recipes/${recipeId}/edit` },
  });
}

function formNotFound(): Response {
  return new Response("Recipe not found", { status: 404 });
}
