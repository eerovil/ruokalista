export interface RecipeListRow {
  id: number;
  title: string;
  yield_portions: number | null;
  created_at: string;
  created_by_name: string;
}

export interface RecipeRow {
  id: number;
  title: string;
  yield_portions: number | null;
  source_text: string;
  source_route: "pasted" | "photographed";
  created_at: string;
  created_by_name: string;
  updated_at: string;
  updated_by_name: string;
}

export interface IngredientLineRow {
  id: number;
  position: number;
  quantity: number | null;
  quantity_max: number | null;
  unit: string | null;
  alt_quantity: number | null;
  alt_unit: string | null;
  ingredient_id: number;
  ingredient_name: string;
  source_line: string;
}

export interface RecipeStepRow {
  position: number;
  text: string;
}

export interface RecipeDetail {
  recipe: RecipeRow;
  lines: IngredientLineRow[];
  steps: RecipeStepRow[];
}

export async function listRecipes(
  db: D1Database,
  householdId: number,
  search: string
): Promise<RecipeListRow[]> {
  const term = search.trim();
  const statement = term
    ? db.prepare(`
        SELECT recipe.id, recipe.title, recipe.yield_portions, recipe.created_at,
               member.display_name AS created_by_name
        FROM recipe
        JOIN member ON member.id = recipe.created_by
        WHERE recipe.household_id = ? AND recipe.title LIKE ? ESCAPE '\\'
        ORDER BY recipe.title COLLATE NOCASE, recipe.id
      `).bind(householdId, `%${escapeLike(term)}%`)
    : db.prepare(`
        SELECT recipe.id, recipe.title, recipe.yield_portions, recipe.created_at,
               member.display_name AS created_by_name
        FROM recipe
        JOIN member ON member.id = recipe.created_by
        WHERE recipe.household_id = ?
        ORDER BY recipe.created_at DESC, recipe.id DESC
      `).bind(householdId);

  const result = await statement.all<RecipeListRow>();
  return result.results;
}

export async function getRecipe(
  db: D1Database,
  householdId: number,
  recipeId: number
): Promise<RecipeDetail | null> {
  const recipe = await db.prepare(`
    SELECT recipe.id, recipe.title, recipe.yield_portions, recipe.source_text,
           recipe.source_route, recipe.created_at, recipe.updated_at,
           creator.display_name AS created_by_name,
           updater.display_name AS updated_by_name
    FROM recipe
    JOIN member creator ON creator.id = recipe.created_by
    JOIN member updater ON updater.id = recipe.updated_by
    WHERE recipe.household_id = ? AND recipe.id = ?
  `).bind(householdId, recipeId).first<RecipeRow>();

  if (!recipe) return null;

  const [lineResult, stepResult] = await Promise.all([
    db.prepare(`
      SELECT ingredient_line.id, ingredient_line.position,
             ingredient_line.quantity, ingredient_line.quantity_max,
             ingredient_line.unit, ingredient_line.alt_quantity,
             ingredient_line.alt_unit, ingredient_line.ingredient_id,
             ingredient.name AS ingredient_name, ingredient_line.source_line
      FROM ingredient_line
      JOIN ingredient ON ingredient.id = ingredient_line.ingredient_id
      WHERE ingredient_line.recipe_id = ? AND ingredient.household_id = ?
      ORDER BY ingredient_line.position
    `).bind(recipeId, householdId).all<IngredientLineRow>(),
    db.prepare(`
      SELECT position, text
      FROM recipe_step
      WHERE recipe_id = ?
      ORDER BY position
    `).bind(recipeId).all<RecipeStepRow>()
  ]);

  return {
    recipe,
    lines: lineResult.results,
    steps: stepResult.results
  };
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export function formatQuantity(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(value).replace(".", ",");
}

export function formatIngredientLine(line: IngredientLineRow): string {
  const parts: string[] = [];

  if (line.quantity !== null) {
    const amount = line.quantity_max !== null
      ? `${formatQuantity(line.quantity)}–${formatQuantity(line.quantity_max)}`
      : formatQuantity(line.quantity);
    parts.push(line.unit ? `${amount} ${line.unit}` : amount);
  }

  if (line.alt_quantity !== null && line.alt_unit !== null) {
    parts.push(`(${formatQuantity(line.alt_quantity)} ${line.alt_unit})`);
  }

  parts.push(line.ingredient_name);
  return parts.join(" ");
}
