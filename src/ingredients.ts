import type { RouteContext } from "./router.ts";
import type { Member } from "./members.ts";

/**
 * An ingredient is a shared record for one foodstuff, referred to by every line
 * that uses it. The list exists partly so the household can see drift early —
 * "purjo" and "purjosipuli" both appearing is the thing to catch.
 *
 * The dictionary is global since #143: one canonical `suola` for every
 * household, not one per household. That is what lets a published recipe reach
 * another household's shopping list and cupboard without a translation layer in
 * between — the ingredient id means the same foodstuff everywhere.
 *
 * The *count* beside each name is not global, though. It answers "how much do
 * we use this", so it counts the recipes this household can actually open: its
 * own, and the ones other households have published. What somebody else cooks
 * behind a private recipe stays their business.
 */

export interface IngredientSummary {
  id: number;
  name: string;
  recipeCount: number;
}

interface IngredientRow {
  id: number;
  name: string;
  recipe_count: number;
}

/** `GET /api/ingredients` — the shared list with usage counts. */
export async function listIngredients(
  { env }: RouteContext,
  member: Member,
): Promise<Response> {
  return Response.json({
    ingredients: await ingredientsFor(env.DB, member.householdId),
  });
}

export async function ingredientsFor(
  db: D1Database,
  householdId: number,
): Promise<IngredientSummary[]> {
  // Counting recipes, not lines: a recipe naming an ingredient twice still uses
  // it once. The join to `recipe` is what keeps the count to what this
  // household can see; the dictionary itself is not filtered at all.
  const { results } = await db
    .prepare(
      `SELECT ingredient.id,
              ingredient.name,
              count(DISTINCT recipe.id) AS recipe_count
         FROM ingredient
         LEFT JOIN ingredient_line
                ON ingredient_line.ingredient_id = ingredient.id
         LEFT JOIN recipe
                ON recipe.id = ingredient_line.recipe_id
               AND (recipe.household_id = ? OR recipe.published_at IS NOT NULL
                    OR EXISTS (SELECT 1 FROM recipe AS dish
                                WHERE dish.id = recipe.parent_id
                                  AND dish.published_at IS NOT NULL))
        GROUP BY ingredient.id, ingredient.name`,
    )
    .bind(householdId)
    .all<IngredientRow>();

  // Sorted here rather than in SQL: SQLite's NOCASE is ASCII-only, so it files
  // ä and ö after z. A Finnish list has to collate in Finnish.
  const collator = new Intl.Collator("fi");

  return results
    .map((row) => ({
      id: row.id,
      name: row.name,
      recipeCount: row.recipe_count,
    }))
    .sort((a, b) => collator.compare(a.name, b.name));
}
