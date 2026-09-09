import type { Env } from "./env.ts";
import {
  extensionFor,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE,
  readImage,
} from "./image-bytes.ts";

/** At most twenty cleanup writes and ten R2 deletes per invocation. */
export const IMAGE_CLEANUP_LIMIT = 10;

/** Supported snapshot age; one extra day allows a restore to finish safely. */
export const IMAGE_RECOVERY_DAYS = 30;
export const IMAGE_RESTORE_MARGIN_DAYS = 1;
const RETENTION_AGE = `-${IMAGE_RECOVERY_DAYS + IMAGE_RESTORE_MARGIN_DAYS} days`;

/** A refusal, in both languages this app has to refuse in. */
export interface ImageRefusal {
  status: number;
  english: string;
  finnish: string;
}

/**
 * Where a picture being stored came from. A generated one states the
 * fingerprint it was made from rather than having it read back out of the
 * database, because what matters is the recipe the picture actually depicts.
 */
export type ImageProvenance =
  | { origin: "manual" }
  | { origin: "generated"; fingerprint: string; model: string | null };

const MANUAL: ImageProvenance = { origin: "manual" };

// A restored key can be detached again. Its old receipt must not shorten the
// new recovery window. Upload/replace, remove and whole-tree delete all use it.
const RENEW_RETIREMENT = `ON CONFLICT(image_key) DO UPDATE SET
  household_id = excluded.household_id,
  queued_at = excluded.queued_at,
  last_attempt_at = NULL`;

/** Run immediately BEFORE the matching CAS update, inside the SAME D1 batch. */
function retireExpectedRecipeImage(
  db: D1Database,
  householdId: number,
  recipeId: number,
  expectedKey: string | null,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO recipe_image_cleanup (image_key, household_id)
     SELECT image_key, household_id FROM recipe
      WHERE id = ? AND household_id = ? AND image_key IS ?
        AND image_key IS NOT NULL
     ${RENEW_RETIREMENT}`,
  ).bind(recipeId, householdId, expectedKey);
}

/**
 * Retirement half of a guarded whole-tree deletion.
 *
 * The deletion module owns whether the tree may be deleted and the edit token
 * that proves its guard succeeded. This lifecycle statement owns only which
 * image keys are retired and how an existing retirement is renewed. It belongs
 * in the same D1 batch as the guarded child/parent DELETE statements.
 */
export function retireRecipeTreeImages(
  db: D1Database,
  householdId: number,
  recipeId: number,
  editToken: string,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO recipe_image_cleanup (image_key, household_id)
     SELECT image_key, household_id FROM recipe
      WHERE household_id = ? AND (id = ? OR parent_id = ?)
        AND image_key IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM recipe AS target
           WHERE target.id = ? AND target.household_id = ? AND target.edit_token = ?
        )
     ${RENEW_RETIREMENT}`,
  ).bind(
    householdId,
    recipeId,
    recipeId,
    recipeId,
    householdId,
    editToken,
  );
}

/**
 * A failed response does not prove the image update rolled back. Keep those
 * bytes too: they may already appear in a snapshot or in the live recipe.
 * Best-effort bookkeeping must never mask the original database error. If D1
 * is unavailable, leave a logged stray object rather than destroy a winner.
 */
async function retainUncertainRecipeImage(
  env: Env,
  householdId: number,
  key: string,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO recipe_image_cleanup (image_key, household_id) VALUES (?, ?)
       ON CONFLICT(image_key) DO NOTHING`,
    ).bind(key, householdId).run();
  } catch {
    console.error(JSON.stringify({ event: "recipe.image_retention_unrecorded" }));
  }
}

/**
 * Check, store, and point the recipe at the new object. Returns the refusal
 * when the bytes are not something we will keep, or null once they are stored.
 *
 * `oldKey` is the compare-and-swap precondition. The old image is retired in
 * the same D1 batch as the conditional reference/provenance update. A confirmed
 * loser deletes only its never-published upload; an uncertain database response
 * retains the attempted bytes because the commit may already have succeeded.
 */
export async function storeRecipeImage(
  env: Env,
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

  await env.RECIPE_IMAGES.put(key, bytes, {
    httpMetadata: { contentType: facts.contentType },
  });

  let changed: number;
  try {
    const update = env.DB
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
      );
    const results = await env.DB.batch([
      retireExpectedRecipeImage(env.DB, householdId, recipeId, oldKey),
      update,
    ]);
    changed = results[1]!.meta.changes;
  } catch (error) {
    await retainUncertainRecipeImage(env, householdId, key);
    throw error;
  }

  if (changed !== 1) {
    await env.RECIPE_IMAGES.delete(key);
    return staleImage();
  }

  return null;
}

/**
 * Forget the recipe's image and atomically retire its bytes for delayed cleanup.
 * Losing a race with a replacement is a silent no-op: neither the winning image
 * nor an older retirement receipt is touched.
 */
export async function removeRecipeImage(
  env: Env,
  householdId: number,
  recipeId: number,
  oldKey: string | null,
): Promise<void> {
  const update = env.DB
    .prepare(
      `UPDATE recipe
          SET image_key = NULL,
              image_origin = NULL,
              image_fingerprint = NULL,
              image_generated_at = NULL,
              image_generated_by = NULL
        WHERE id = ? AND household_id = ? AND image_key IS ?`,
    )
    .bind(recipeId, householdId, oldKey);
  await env.DB.batch([
    retireExpectedRecipeImage(env.DB, householdId, recipeId, oldKey),
    update,
  ]);
}

/**
 * Retry a small slice of EXPIRED retirements, here and from the existing cron.
 *
 * Failed attempts move behind older work, so one missing/unavailable object
 * cannot starve the rest. An R2 success followed by a D1 acknowledgement failure
 * is safe to retry: deleting an already absent immutable key is idempotent.
 * Live references are rechecked across all households before each storage
 * operation; restore tooling must remain quiesced while restoring a snapshot.
 */
export async function cleanupRetiredRecipeImages(
  env: Env,
  householdId?: number,
): Promise<void> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT pending.image_key, pending.household_id, pending.queued_at
         FROM recipe_image_cleanup AS pending
        WHERE (? IS NULL OR pending.household_id = ?)
          AND julianday(pending.queued_at) <= julianday('now', ?)
          AND NOT EXISTS (
            SELECT 1 FROM recipe WHERE image_key = pending.image_key
          )
        ORDER BY coalesce(last_attempt_at, queued_at), pending.image_key
        LIMIT ?`,
    ).bind(
      householdId ?? null,
      householdId ?? null,
      RETENTION_AGE,
      IMAGE_CLEANUP_LIMIT,
    ).all<{ image_key: string; household_id: number; queued_at: string }>();

    for (const row of results) {
      try {
        const attempted = await env.DB.prepare(
          `UPDATE recipe_image_cleanup
              SET last_attempt_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
            WHERE image_key = ? AND household_id = ? AND queued_at = ?
              AND julianday(queued_at) <= julianday('now', ?)
              AND NOT EXISTS (SELECT 1 FROM recipe WHERE image_key = ?)`,
        ).bind(
          row.image_key,
          row.household_id,
          row.queued_at,
          RETENTION_AGE,
          row.image_key,
        ).run();
        if (attempted.meta.changes !== 1) continue;

        await env.RECIPE_IMAGES.delete(row.image_key);
        await env.DB.prepare(
          "DELETE FROM recipe_image_cleanup WHERE image_key = ? AND household_id = ? AND queued_at = ?",
        ).bind(row.image_key, row.household_id, row.queued_at).run();
      } catch (error) {
        console.error(JSON.stringify({
          event: "recipe.image_cleanup_pending",
          image_key: row.image_key,
          household_id: row.household_id,
          detail: String((error as Error)?.message ?? error),
        }));
      }
    }
  } catch (error) {
    console.error(JSON.stringify({
      event: "recipe.image_cleanup_failed",
      detail: String((error as Error)?.message ?? error),
    }));
  }
}

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
