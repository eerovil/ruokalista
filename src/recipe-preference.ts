import type { Member } from "./members.ts";

/**
 * How many portions *this* household cooks a recipe in.
 *
 * This is not a fact about the recipe, and that distinction is the whole reason
 * the table exists (#143). `recipe.yield_portions` is what the source page said
 * — it belongs to the recipe and travels with it when the recipe is published.
 * "We always make this for nine" belongs to a kitchen. Put the second on the
 * recipe row and the publisher's habit silently becomes everybody's default the
 * moment they share it.
 *
 * So a preference is a `(household_id, recipe_id)` row, and it is set and read
 * by whoever is looking — the owning household has no more say over another
 * household's number than the other way round.
 *
 * There is exactly one preference in v1: the default portions the picker starts
 * from. The table is named for the general idea rather than the one column
 * because the next one (a household's own note on somebody else's recipe, say)
 * is the same row.
 */

export class PreferenceRefused extends Error {}

/** The default portions this household has saved, keyed by recipe id. */
export async function preferredPortions(
  db: D1Database,
  householdId: number,
  recipeIds: readonly number[],
): Promise<Map<number, number>> {
  const wanted = [...new Set(recipeIds)];
  if (wanted.length === 0) return new Map();

  const placeholders = wanted.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT recipe_id, default_portions
         FROM recipe_preference
        WHERE household_id = ?
          AND recipe_id IN (${placeholders})`,
    )
    .bind(householdId, ...wanted)
    .all<{ recipe_id: number; default_portions: number }>();

  return new Map(results.map((row) => [row.recipe_id, row.default_portions]));
}

export async function preferredPortionsFor(
  db: D1Database,
  householdId: number,
  recipeId: number,
): Promise<number | null> {
  const found = await preferredPortions(db, householdId, [recipeId]);
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
export async function setPreferredPortions(
  db: D1Database,
  member: Member,
  recipeId: number,
  portions: number | null,
): Promise<void> {
  const visible = await db
    .prepare(
      `SELECT id FROM recipe
        WHERE id = ?
          AND parent_id IS NULL
          AND (household_id = ? OR published_at IS NOT NULL)`,
    )
    .bind(recipeId, member.householdId)
    .first<{ id: number }>();
  if (visible === null) throw new PreferenceRefused("Tuntematon resepti.");

  if (portions === null) {
    await db
      .prepare(
        "DELETE FROM recipe_preference WHERE household_id = ? AND recipe_id = ?",
      )
      .bind(member.householdId, recipeId)
      .run();
    return;
  }

  if (!Number.isSafeInteger(portions) || portions <= 0) {
    throw new PreferenceRefused("Annosmäärän pitää olla positiivinen kokonaisluku.");
  }

  await db
    .prepare(
      `INSERT INTO recipe_preference
         (household_id, recipe_id, default_portions, updated_at, updated_by)
       VALUES (?, ?, ?, datetime('now'), ?)
       ON CONFLICT (household_id, recipe_id) DO UPDATE
          SET default_portions = excluded.default_portions,
              updated_at = excluded.updated_at,
              updated_by = excluded.updated_by`,
    )
    .bind(member.householdId, recipeId, portions, member.id)
    .run();
}
