import type { Env } from "./env.ts";
import {
  cleanupRetiredRecipeImages,
  retireRecipeTreeImages,
} from "./recipe-image-lifecycle.ts";

/**
 * Delete a private, unplanned recipe tree and durably remember its image keys.
 *
 * This module owns the recipe-deletion eligibility and guarded D1 mutation. The
 * image lifecycle owns which parent/part image keys are retired, renewal of old
 * receipts, retention duration and eventual R2 cleanup.
 *
 * The screen's earlier checks only explain refusals. This batch repeats them
 * at mutation time; the existing edit-token convention makes every statement
 * conditional on the same successful check. A failed child/parent DELETE rolls
 * back the token and retirement records too. R2 is never touched before commit.
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
    retireRecipeTreeImages(env.DB, householdId, recipeId, token),
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
  await cleanupRetiredRecipeImages(env, householdId);
  return true;
}
