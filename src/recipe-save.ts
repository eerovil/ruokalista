import { ingredientsFor } from "./ingredients.ts";
import type { Member } from "./members.ts";

/**
 * Saving a corrected draft. One D1 batch, so a half-written recipe cannot
 * exist — the spec's step 5, end to end.
 *
 * The approval gate lives here as well as on the screen: a line must resolve to
 * an ingredient the household has, or to a name a human approved. That rule is
 * what keeps "purjo" and "purjosipuli" from both appearing, so it is enforced
 * where it counts rather than only where it is convenient.
 */

export type LineIngredient =
  | { kind: "existing"; id: number }
  | { kind: "new"; name: string }
  // What an unanswered line looks like. Refused, never guessed.
  | { kind: "unanswered" };

export interface LineToSave {
  quantity: number | null;
  quantityMax: number | null;
  unit: string | null;
  altQuantity: number | null;
  altUnit: string | null;
  ingredient: LineIngredient;
  sourceLine: string;
}

export interface RecipeToSave {
  title: string;
  yieldPortions: number | null;
  sourceText: string;
  sourceRoute: "pasted" | "photographed";
  structuredBy: string | null;
  steps: string[];
  lines: LineToSave[];
}

export class SaveRefused extends Error {}

/**
 * Validate the lines and work out which ingredient each one means, creating
 * statements for any genuinely new ones. Shared by saving and editing, so the
 * approval gate cannot be enforced in one and skipped in the other.
 */
async function resolveIngredients(
  db: D1Database,
  member: Member,
  recipe: RecipeToSave,
): Promise<{ statements: D1PreparedStatement[]; resolved: number[] }> {
  if (recipe.title.trim() === "") {
    throw new SaveRefused("Reseptillä pitää olla nimi.");
  }
  if (recipe.lines.length === 0) {
    throw new SaveRefused("Reseptissä pitää olla ainakin yksi aines.");
  }
  if (recipe.lines.some((line) => line.ingredient.kind === "unanswered")) {
    throw new SaveRefused("Jokaiselle uudelle ainekselle pitää vastata.");
  }

  const existing = await ingredientsFor(db, member.householdId);
  const byName = new Map(
    existing.map((ingredient) => [
      ingredient.name.toLocaleLowerCase("fi"),
      ingredient.id,
    ]),
  );
  const knownIds = new Set(existing.map((ingredient) => ingredient.id));

  // Ids are allocated up front so the whole save is one batch. Two imports
  // racing in the same household would collide on the primary key and the batch
  // would roll back — loud, and correct, for a household of a few people.
  let nextIngredientId = await nextId(db, "ingredient");

  const newIngredients: { id: number; name: string }[] = [];
  const resolved: number[] = [];

  for (const line of recipe.lines) {
    const ingredient = line.ingredient;

    if (ingredient.kind === "existing") {
      if (!knownIds.has(ingredient.id)) {
        throw new SaveRefused("Tuntematon aines.");
      }
      resolved.push(ingredient.id);
      continue;
    }

    if (ingredient.kind === "new") {
      const name = ingredient.name.trim();
      if (name === "") throw new SaveRefused("Uudella aineksella pitää olla nimi.");

      // Approving a name the household already has is a match, not a duplicate.
      // This is the drift the gate exists to prevent, caught one step later.
      const already = byName.get(name.toLocaleLowerCase("fi"));
      if (already !== undefined) {
        resolved.push(already);
        continue;
      }

      const id = nextIngredientId++;
      newIngredients.push({ id, name });
      byName.set(name.toLocaleLowerCase("fi"), id);
      resolved.push(id);
      continue;
    }

    throw new SaveRefused("Jokaiselle uudelle ainekselle pitää vastata.");
  }

  const statements: D1PreparedStatement[] = [];

  for (const ingredient of newIngredients) {
    statements.push(
      db
        .prepare(
          `INSERT INTO ingredient (id, household_id, name, created_by)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(ingredient.id, member.householdId, ingredient.name, member.id),
    );
  }

  return { statements, resolved };
}

export async function saveRecipe(
  db: D1Database,
  member: Member,
  recipe: RecipeToSave,
): Promise<number> {
  const { statements, resolved } = await resolveIngredients(db, member, recipe);
  const recipeId = await nextId(db, "recipe");

  statements.push(
    db
      .prepare(
        `INSERT INTO recipe
           (id, household_id, title, yield_portions, source_text, source_route,
            structured_by, structured_at, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)`,
      )
      .bind(
        recipeId,
        member.householdId,
        recipe.title.trim(),
        recipe.yieldPortions,
        recipe.sourceText,
        recipe.sourceRoute,
        recipe.structuredBy,
        member.id,
        member.id,
      ),
  );

  statements.push(...childStatements(db, recipeId, recipe, resolved));
  await db.batch(statements);

  return recipeId;
}

/**
 * Edit a saved recipe. Its children are replaced wholesale rather than diffed —
 * positions shift when a line moves, and one batch keeps the recipe from ever
 * being half-rewritten.
 *
 * source_text and source_route are not editable and are not touched here.
 */
export async function replaceRecipe(
  db: D1Database,
  member: Member,
  recipeId: number,
  recipe: RecipeToSave,
): Promise<void> {
  const { statements, resolved } = await resolveIngredients(db, member, recipe);

  statements.push(
    db
      .prepare(
        `UPDATE recipe
            SET title = ?, yield_portions = ?,
                updated_at = datetime('now'), updated_by = ?
          WHERE id = ? AND household_id = ?`,
      )
      .bind(
        recipe.title.trim(),
        recipe.yieldPortions,
        member.id,
        recipeId,
        member.householdId,
      ),
    db.prepare("DELETE FROM recipe_step WHERE recipe_id = ?").bind(recipeId),
    db.prepare("DELETE FROM ingredient_line WHERE recipe_id = ?").bind(recipeId),
  );

  statements.push(...childStatements(db, recipeId, recipe, resolved));
  await db.batch(statements);
}

function childStatements(
  db: D1Database,
  recipeId: number,
  recipe: RecipeToSave,
  resolved: number[],
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];

  recipe.steps.forEach((text, index) => {
    if (text.trim() === "") return;
    statements.push(
      db
        .prepare(
          "INSERT INTO recipe_step (recipe_id, position, text) VALUES (?, ?, ?)",
        )
        .bind(recipeId, index + 1, text.trim()),
    );
  });

  recipe.lines.forEach((line, index) => {
    statements.push(
      db
        .prepare(
          `INSERT INTO ingredient_line
             (recipe_id, position, quantity, quantity_max, unit,
              alt_quantity, alt_unit, ingredient_id, source_line)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          recipeId,
          index + 1,
          line.quantity,
          line.quantityMax,
          line.unit,
          line.altQuantity,
          line.altUnit,
          resolved[index]!,
          line.sourceLine,
        ),
    );
  });

  return statements;
}

async function nextId(db: D1Database, table: string): Promise<number> {
  const row = await db
    .prepare(`SELECT coalesce(max(id), 0) + 1 AS next FROM ${table}`)
    .first<{ next: number }>();

  return row?.next ?? 1;
}
