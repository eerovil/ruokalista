import { ingredientsFor } from "./ingredients.ts";
import type { Member } from "./members.ts";

/**
 * Saving a corrected draft, and editing a saved recipe. One D1 batch either
 * way, so a half-written recipe cannot exist.
 *
 * The approval gate lives here as well as on the screen: a line must resolve to
 * an ingredient the household has, or to a name a human approved. That rule is
 * what keeps "purjo" and "purjosipuli" from both appearing, so it is enforced
 * where it counts rather than only where it is convenient.
 *
 * A dish written in named parts becomes several recipes: the dish, and one
 * child recipe per part. See docs/adr/0002-a-part-is-a-recipe.md.
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
  /** The named part this belongs to, or null for the dish itself. */
  section: string | null;
}

export interface StepToSave {
  text: string;
  section: string | null;
}

export interface RecipeToSave {
  title: string;
  yieldPortions: number | null;
  sourceText: string;
  sourceRoute: "pasted" | "photographed";
  structuredBy: string | null;
  steps: StepToSave[];
  lines: LineToSave[];
}

export class SaveRefused extends Error {}

/** A line paired with the ingredient it finally resolved to. */
interface ResolvedLine {
  line: LineToSave;
  ingredientId: number;
}

export async function saveRecipe(
  db: D1Database,
  member: Member,
  recipe: RecipeToSave,
): Promise<number> {
  const { statements, lines } = await resolveIngredients(db, member, recipe);

  const parts = partNames(recipe);
  let nextRecipeId = await nextId(db, "recipe");
  const recipeId = nextRecipeId++;

  statements.push(
    recipeRow(db, member, recipeId, recipe, {
      title: recipe.title.trim(),
      yieldPortions: recipe.yieldPortions,
      parentId: null,
      position: null,
    }),
    ...childrenOf(db, recipeId, lines, recipe.steps, null),
  );

  // Each named part becomes a recipe of its own, hanging off the dish.
  parts.forEach((name, index) => {
    const partId = nextRecipeId++;
    statements.push(
      recipeRow(db, member, partId, recipe, {
        title: name,
        // A page almost never states a yield per part.
        yieldPortions: null,
        parentId: recipeId,
        position: index + 1,
      }),
      ...childrenOf(db, partId, lines, recipe.steps, name),
    );
  });

  await db.batch(statements);

  return recipeId;
}

/**
 * Edit a saved recipe. Its children are replaced wholesale rather than diffed —
 * positions shift when a line moves, and one batch keeps the recipe from ever
 * being half-rewritten.
 *
 * source_text and source_route are not editable and are not touched here. Parts
 * are recipes of their own and are edited on their own screens, so this leaves
 * them alone too.
 */
export async function replaceRecipe(
  db: D1Database,
  member: Member,
  recipeId: number,
  recipe: RecipeToSave,
): Promise<void> {
  const { statements, lines } = await resolveIngredients(db, member, recipe);

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
    ...childrenOf(db, recipeId, lines, recipe.steps, null),
  );

  await db.batch(statements);
}

/** The dish's parts, in the order they first appear on the page. */
function partNames(recipe: RecipeToSave): string[] {
  const names: string[] = [];

  for (const item of [...recipe.lines, ...recipe.steps]) {
    const name = item.section?.trim();
    if (!name) continue;
    if (!names.includes(name)) names.push(name);
  }

  return names;
}

function recipeRow(
  db: D1Database,
  member: Member,
  id: number,
  recipe: RecipeToSave,
  as: {
    title: string;
    yieldPortions: number | null;
    parentId: number | null;
    position: number | null;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO recipe
         (id, household_id, title, yield_portions, source_text, source_route,
          structured_by, structured_at, created_by, updated_by,
          parent_id, part_position)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?)`,
    )
    .bind(
      id,
      member.householdId,
      as.title,
      as.yieldPortions,
      // A part came from the same page, so it keeps the same record of arrival.
      recipe.sourceText,
      recipe.sourceRoute,
      recipe.structuredBy,
      member.id,
      member.id,
      as.parentId,
      as.position,
    );
}

/** The lines and steps belonging to one recipe — the dish, or one of its parts. */
function childrenOf(
  db: D1Database,
  recipeId: number,
  lines: ResolvedLine[],
  steps: StepToSave[],
  section: string | null,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  const belongs = (name: string | null) => (name?.trim() || null) === section;

  steps
    .filter((step) => belongs(step.section) && step.text.trim() !== "")
    .forEach((step, index) => {
      statements.push(
        db
          .prepare(
            "INSERT INTO recipe_step (recipe_id, position, text) VALUES (?, ?, ?)",
          )
          .bind(recipeId, index + 1, step.text.trim()),
      );
    });

  lines
    .filter((entry) => belongs(entry.line.section))
    .forEach((entry, index) => {
      const line = entry.line;
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
            entry.ingredientId,
            line.sourceLine,
          ),
      );
    });

  return statements;
}

/**
 * Validate the lines and work out which ingredient each one means, creating
 * statements for any genuinely new ones. Shared by saving and editing, so the
 * approval gate cannot be enforced in one and skipped in the other.
 */
async function resolveIngredients(
  db: D1Database,
  member: Member,
  recipe: RecipeToSave,
): Promise<{ statements: D1PreparedStatement[]; lines: ResolvedLine[] }> {
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
  const lines: ResolvedLine[] = [];

  for (const line of recipe.lines) {
    const ingredient = line.ingredient;

    if (ingredient.kind === "existing") {
      if (!knownIds.has(ingredient.id)) throw new SaveRefused("Tuntematon aines.");
      lines.push({ line, ingredientId: ingredient.id });
      continue;
    }

    if (ingredient.kind === "new") {
      const name = ingredient.name.trim();
      if (name === "") throw new SaveRefused("Uudella aineksella pitää olla nimi.");

      // Approving a name the household already has is a match, not a duplicate.
      // This is the drift the gate exists to prevent, caught one step later.
      const already = byName.get(name.toLocaleLowerCase("fi"));
      if (already !== undefined) {
        lines.push({ line, ingredientId: already });
        continue;
      }

      const id = nextIngredientId++;
      newIngredients.push({ id, name });
      byName.set(name.toLocaleLowerCase("fi"), id);
      lines.push({ line, ingredientId: id });
      continue;
    }

    throw new SaveRefused("Jokaiselle uudelle ainekselle pitää vastata.");
  }

  const statements = newIngredients.map((ingredient) =>
    db
      .prepare(
        `INSERT INTO ingredient (id, household_id, name, created_by)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(ingredient.id, member.householdId, ingredient.name, member.id),
  );

  return { statements, lines };
}

async function nextId(db: D1Database, table: string): Promise<number> {
  const row = await db
    .prepare(`SELECT coalesce(max(id), 0) + 1 AS next FROM ${table}`)
    .first<{ next: number }>();

  return row?.next ?? 1;
}
