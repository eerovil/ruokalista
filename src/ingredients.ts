export interface IngredientListRow {
  id: number;
  name: string;
  recipe_count: number;
}

export async function listIngredients(
  db: D1Database,
  householdId: number
): Promise<IngredientListRow[]> {
  const result = await db.prepare(`
    SELECT ingredient.id, ingredient.name,
           COUNT(DISTINCT ingredient_line.recipe_id) AS recipe_count
    FROM ingredient
    LEFT JOIN ingredient_line ON ingredient_line.ingredient_id = ingredient.id
    WHERE ingredient.household_id = ?
    GROUP BY ingredient.id, ingredient.name
    ORDER BY ingredient.name COLLATE NOCASE, ingredient.id
  `).bind(householdId).all<IngredientListRow>();
  return result.results;
}

export async function renameIngredient(
  db: D1Database,
  householdId: number,
  ingredientId: number,
  name: string
): Promise<"updated" | "missing" | "duplicate"> {
  const trimmed = name.trim();
  if (!trimmed) return "missing";

  const existing = await db.prepare(`
    SELECT id FROM ingredient
    WHERE household_id = ? AND name = ? AND id <> ?
  `).bind(householdId, trimmed, ingredientId).first<{ id: number }>();
  if (existing) return "duplicate";

  const result = await db.prepare(`
    UPDATE ingredient
    SET name = ?
    WHERE id = ? AND household_id = ?
  `).bind(trimmed, ingredientId, householdId).run();
  return result.meta.changes > 0 ? "updated" : "missing";
}
