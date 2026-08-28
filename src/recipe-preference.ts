import type { Member } from "./members.ts";
import { readableRecipeCondition } from "./recipe-publish.ts";
import { isMultiplier, parseMultiplier } from "./scaling.ts";

/**
 * How much of a recipe *this* household usually cooks.
 *
 * This is not a fact about the recipe, and that distinction is the whole reason
 * the table exists (#143). `recipe.yield_portions` is what the source page said
 * — it belongs to the recipe and travels with it when the recipe is published.
 * "We always cook this at one and a half" belongs to a kitchen. Put the second
 * on the recipe row and the publisher's habit silently becomes everybody's
 * default the moment they share it.
 *
 * So a preference is a `(household_id, recipe_id)` row, and it is set and read
 * by whoever is looking — the owning household has no more say over another
 * household's number than the other way round.
 *
 * There is exactly one preference in v1: the multiplier the picker starts from
 * (#165 turned it from a portion count into one). The table is named for the
 * general idea rather than the one column because the next one (a household's
 * own note on somebody else's recipe, say) is the same row.
 */

export class PreferenceRefused extends Error {}

/** The default multiplier this household has saved, keyed by recipe id. */
export async function preferredMultipliers(
  db: D1Database,
  householdId: number,
  recipeIds: readonly number[],
): Promise<Map<number, number>> {
  const wanted = [...new Set(recipeIds)];
  if (wanted.length === 0) return new Map();

  const placeholders = wanted.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT recipe_id, default_multiplier
         FROM recipe_preference
        WHERE household_id = ?
          AND recipe_id IN (${placeholders})`,
    )
    .bind(householdId, ...wanted)
    .all<{ recipe_id: number; default_multiplier: number }>();

  return new Map(
    results
      .filter((row) => isMultiplier(row.default_multiplier))
      .map((row) => [row.recipe_id, row.default_multiplier]),
  );
}

export async function preferredMultiplierFor(
  db: D1Database,
  householdId: number,
  recipeId: number,
): Promise<number | null> {
  const found = await preferredMultipliers(db, householdId, [recipeId]);
  return found.get(recipeId) ?? null;
}

/**
 * Save this household's default for a recipe.
 *
 * The recipe has to be one this household can actually see — its own or a
 * published one — because a preference for a recipe nobody here can open is a
 * row that only tells another household somebody was guessing at ids.
 *
 * Clearing it is a blank box, not a second control: "we have no particular
 * default" is the absence of a row, the same shape the cupboard uses for "we do
 * not keep this in".
 */
export async function setPreferredMultiplier(
  db: D1Database,
  member: Member,
  recipeId: number,
  multiplier: number | null,
): Promise<void> {
  const visible = await db
    .prepare(
      `SELECT id FROM recipe
        WHERE id = ?
          AND parent_id IS NULL
          AND ${readableRecipeCondition("recipe")}`,
    )
    .bind(recipeId, member.householdId, member.householdId)
    .first<{ id: number }>();
  if (visible === null) throw new PreferenceRefused("Tuntematon resepti.");

  if (multiplier === null) {
    await db
      .prepare(
        "DELETE FROM recipe_preference WHERE household_id = ? AND recipe_id = ?",
      )
      .bind(member.householdId, recipeId)
      .run();
    return;
  }

  const value = parseMultiplier(String(multiplier));
  if (value === null) {
    throw new PreferenceRefused(
      "Kertoimen pitää olla positiivinen luku, esimerkiksi 0,5 tai 1,5.",
    );
  }

  await db
    .prepare(
      `INSERT INTO recipe_preference
         (household_id, recipe_id, default_multiplier, updated_at, updated_by)
       VALUES (?, ?, ?, datetime('now'), ?)
       ON CONFLICT (household_id, recipe_id) DO UPDATE
          SET default_multiplier = excluded.default_multiplier,
              updated_at = excluded.updated_at,
              updated_by = excluded.updated_by`,
    )
    .bind(member.householdId, recipeId, value, member.id)
    .run();
}
