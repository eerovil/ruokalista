import { getRecipe } from "./recipes";
import { validateCorrectedDraft, type CorrectedDraftPayload } from "./intake";

export interface EditableRecipePayload extends CorrectedDraftPayload {}

export async function loadEditableRecipe(db: D1Database, householdId: number, recipeId: number): Promise<EditableRecipePayload | null> {
  const detail = await getRecipe(db, householdId, recipeId);
  if (!detail) return null;
  return {
    title: detail.recipe.title,
    yield_portions: detail.recipe.yield_portions,
    source_text: detail.recipe.source_text,
    source_route: detail.recipe.source_route,
    structured_by: "manual-edit",
    steps: detail.steps.map(step => step.text),
    lines: detail.lines.map(line => ({
      quantity: line.quantity,
      quantity_max: line.quantity_max,
      unit: line.unit,
      alt_quantity: line.alt_quantity,
      alt_unit: line.alt_unit,
      ingredient_id: line.ingredient_id,
      ingredient_name: line.ingredient_name,
      source_line: line.source_line
    }))
  };
}

export function validateRecipeEdit(value: unknown): EditableRecipePayload {
  return validateCorrectedDraft(value);
}

export async function updateRecipeFromDraft(db: D1Database, householdId: number, memberId: number, recipeId: number, payload: EditableRecipePayload): Promise<boolean> {
  const recipe = await db.prepare(`SELECT id FROM recipe WHERE id = ? AND household_id = ?`).bind(recipeId, householdId).first<{id:number}>();
  if (!recipe) return false;

  const ingredientIds: number[] = [];
  for (const line of payload.lines) {
    if (line.ingredient_id !== null) {
      const ingredient = await db.prepare(`SELECT id FROM ingredient WHERE id = ? AND household_id = ?`).bind(line.ingredient_id, householdId).first<{id:number}>();
      if (!ingredient) throw new Error(`Ainesta ${line.ingredient_name} ei löytynyt.`);
      ingredientIds.push(ingredient.id);
    } else {
      await db.prepare(`INSERT INTO ingredient (household_id, name, created_by) VALUES (?, ?, ?) ON CONFLICT(household_id, name) DO NOTHING`).bind(householdId, line.ingredient_name, memberId).run();
      const ingredient = await db.prepare(`SELECT id FROM ingredient WHERE household_id = ? AND name = ?`).bind(householdId, line.ingredient_name).first<{id:number}>();
      if (!ingredient) throw new Error(`Uutta ainesta ${line.ingredient_name} ei voitu hyväksyä.`);
      ingredientIds.push(ingredient.id);
    }
  }

  const statements: D1PreparedStatement[] = [
    db.prepare(`UPDATE recipe SET title = ?, yield_portions = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ? AND household_id = ?`).bind(payload.title, payload.yield_portions, memberId, recipeId, householdId),
    db.prepare(`DELETE FROM recipe_step WHERE recipe_id = ?`).bind(recipeId),
    db.prepare(`DELETE FROM ingredient_line WHERE recipe_id = ?`).bind(recipeId)
  ];
  payload.steps.forEach((step, index) => statements.push(db.prepare(`INSERT INTO recipe_step (recipe_id, position, text) VALUES (?, ?, ?)`).bind(recipeId, index + 1, step)));
  payload.lines.forEach((line, index) => statements.push(db.prepare(`INSERT INTO ingredient_line (recipe_id, position, quantity, quantity_max, unit, alt_quantity, alt_unit, ingredient_id, source_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(recipeId, index + 1, line.quantity, line.quantity_max, line.unit, line.alt_quantity, line.alt_unit, ingredientIds[index], line.source_line)));
  await db.batch(statements);
  return true;
}
