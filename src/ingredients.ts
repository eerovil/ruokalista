import type { RouteContext } from "./router.ts";
import type { Member } from "./members.ts";

/**
 * An ingredient is a shared record for one foodstuff, referred to by every line
 * that uses it. The list exists partly so the household can see drift early —
 * "purjo" and "purjosipuli" both appearing is the thing to catch.
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
  // it once.
  const { results } = await db
    .prepare(
      `SELECT ingredient.id,
              ingredient.name,
              count(DISTINCT ingredient_line.recipe_id) AS recipe_count
         FROM ingredient
         LEFT JOIN ingredient_line
                ON ingredient_line.ingredient_id = ingredient.id
        WHERE ingredient.household_id = ?
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
