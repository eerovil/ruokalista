import type { Env } from "./env.ts";

/** At most twenty cleanup writes and ten R2 deletes per invocation. */
export const IMAGE_CLEANUP_LIMIT = 10;

/** Supported snapshot age; one extra day allows a restore to finish safely. */
export const IMAGE_RECOVERY_DAYS = 30;
export const IMAGE_RESTORE_MARGIN_DAYS = 1;
const RETENTION_AGE = `-${IMAGE_RECOVERY_DAYS + IMAGE_RESTORE_MARGIN_DAYS} days`;

// A restored key can be detached again. Its old receipt must not shorten the
// new recovery window. Both single-image edits and whole-tree deletes use this.
const RENEW_RETIREMENT = `ON CONFLICT(image_key) DO UPDATE SET
  household_id = excluded.household_id,
  queued_at = excluded.queued_at,
  last_attempt_at = NULL`;

/** Run immediately BEFORE the matching CAS update, inside the SAME D1 batch. */
export function retireExpectedRecipeImage(
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
 * A failed response does not prove the image update rolled back. Keep those
 * bytes too: they may already appear in a snapshot or in the live recipe.
 * Best-effort bookkeeping must never mask the original database error. If D1
 * is unavailable, leave a logged stray object rather than destroy a winner.
 */
export async function retainUncertainRecipeImage(
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
 * Delete a private, unplanned recipe tree and durably remember its image keys.
 *
 * The screen's earlier checks only explain refusals. This batch repeats them
 * at mutation time; the existing edit-token convention makes every statement
 * conditional on the same successful check. A failed child/parent DELETE rolls
 * back the token and cleanup records too. R2 is never touched before commit.
 */
export async function deleteRecipeWithImages(
  env: Env,
  householdId: number,
  recipeId: number,
): Promise<boolean> {
  const token = crypto.randomUUID();
  const guard = `EXISTS (
    SELECT 1 FROM recipe AS target
     WHERE target.id = ? AND target.household_id = ? AND target.edit_token = ?
  )`;
  const bindings = [recipeId, householdId, token];

  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE recipe SET edit_token = ?
        WHERE id = ? AND household_id = ?
          AND published_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM recipe_share WHERE recipe_id = recipe.id)
          AND NOT EXISTS (
            SELECT 1 FROM planned_batch
             WHERE recipe_id IN (
               SELECT id FROM recipe AS tree
                WHERE tree.id = recipe.id OR tree.parent_id = recipe.id
             )
          )`,
    ).bind(token, recipeId, householdId),
    env.DB.prepare(
      `INSERT INTO recipe_image_cleanup (image_key, household_id)
       SELECT image_key, household_id FROM recipe
        WHERE household_id = ? AND (id = ? OR parent_id = ?)
          AND image_key IS NOT NULL AND ${guard}
       ${RENEW_RETIREMENT}`,
    ).bind(householdId, recipeId, recipeId, ...bindings),
    env.DB.prepare(
      `DELETE FROM recipe
        WHERE household_id = ? AND parent_id = ? AND ${guard}`,
    ).bind(householdId, recipeId, ...bindings),
    env.DB.prepare(
      "DELETE FROM recipe WHERE id = ? AND household_id = ? AND edit_token = ?",
    ).bind(...bindings),
  ]);

  // D1's count includes rows removed by this DELETE's cascades. Zero means the
  // guarded parent was not deleted; any positive count means it was.
  if ((results[3]?.meta.changes ?? 0) < 1) return false;

  // Failure here is pending cleanup, not a failed recipe deletion. The queue
  // survives a lost response or an isolate ending before this call starts.
  await cleanupDeletedRecipeImages(env, householdId);
  return true;
}

/**
 * Retry a small slice of EXPIRED retirements, here and from the existing cron.
 *
 * Failed attempts move behind older work, so one missing/unavailable object
 * cannot starve the rest. An R2 success followed by a D1 acknowledgement failure
 * is safe to retry: deleting an already absent immutable key is idempotent.
 *
 * Keys are minted afresh on every upload, never reassigned to another upload.
 * Still recheck live references, including other households and restored rows,
 * before each storage operation. Restore tooling must not run concurrently
 * with application writes/maintenance while restoring a snapshot.
 */
export async function cleanupDeletedRecipeImages(
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
    ).bind(householdId ?? null, householdId ?? null, RETENTION_AGE, IMAGE_CLEANUP_LIMIT)
      .all<{ image_key: string; household_id: number; queued_at: string }>();

    for (const row of results) {
      try {
        const attempted = await env.DB.prepare(
          `UPDATE recipe_image_cleanup
              SET last_attempt_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
            WHERE image_key = ? AND household_id = ? AND queued_at = ?
              AND julianday(queued_at) <= julianday('now', ?)
              AND NOT EXISTS (SELECT 1 FROM recipe WHERE image_key = ?)`,
        ).bind(row.image_key, row.household_id, row.queued_at, RETENTION_AGE, row.image_key).run();
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
