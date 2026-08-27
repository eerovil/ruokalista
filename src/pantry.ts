import type { ShoppingItem } from "./shopping.ts";

/**
 * The cupboard: which ingredients the household already has at home, so the
 * shopping list can stop asking it to buy them.
 *
 * v1's answer is the row itself. An ingredient in the cupboard is treated as
 * unlimited — however much the week's cooking calls for, it is covered — and
 * an ingredient with no row is not assumed to be anywhere. Running out is
 * removing the row, not writing a second kind of it (#125).
 *
 * `quantity` is the state this model exists to leave room for: 6 kpl of eggs
 * against the 10 a week needs, buy 4. Its columns are already in the table
 * (`migrations/0008_pantry.sql`), nothing in v1 writes them, and the split
 * below deliberately reads only membership — so counted inventory later is a
 * new branch rather than a replaced model.
 *
 * Nothing here fuzzy-matches a name. Matching is by `ingredient_id`, the
 * household's own canonical identity for a foodstuff, because deciding that
 * "suola" and "hienosuola" are the same thing is how a list quietly stops
 * mentioning something the household actually needed.
 */

export class PantryRefused extends Error {}

/** One ingredient the household keeps in. */
export interface PantryItem {
  ingredientId: number;
  name: string;
  /** How many recipes use it, so a staple's usefulness is visible. */
  recipeCount: number;
}

interface PantryRow {
  ingredient_id: number;
  name: string;
  recipe_count: number;
}

/**
 * What is in the cupboard, alphabetically in Finnish.
 *
 * Sorted here rather than in SQL for the same reason the ingredient list is:
 * SQLite's NOCASE is ASCII-only and files ä and ö after z.
 */
export async function pantryContents(
  db: D1Database,
  householdId: number,
): Promise<PantryItem[]> {
  const { results } = await db
    .prepare(
      `SELECT ingredient.id AS ingredient_id,
              ingredient.name,
              count(DISTINCT ingredient_line.recipe_id) AS recipe_count
         FROM pantry_entry
         JOIN ingredient
           ON ingredient.id = pantry_entry.ingredient_id
          AND ingredient.household_id = pantry_entry.household_id
         LEFT JOIN ingredient_line
                ON ingredient_line.ingredient_id = ingredient.id
        WHERE pantry_entry.household_id = ?
        GROUP BY ingredient.id, ingredient.name`,
    )
    .bind(householdId)
    .all<PantryRow>();

  const collator = new Intl.Collator("fi");

  return results
    .map((row) => ({
      ingredientId: row.ingredient_id,
      name: row.name,
      recipeCount: row.recipe_count,
    }))
    .sort((a, b) => collator.compare(a.name, b.name));
}

/** Just the ids, which is all the shopping list needs to sort its rows. */
export async function pantryIngredientIds(
  db: D1Database,
  householdId: number,
): Promise<Set<number>> {
  const { results } = await db
    .prepare(
      "SELECT ingredient_id FROM pantry_entry WHERE household_id = ?",
    )
    .bind(householdId)
    .all<{ ingredient_id: number }>();

  return new Set(results.map((row) => row.ingredient_id));
}

/**
 * Put an ingredient in the cupboard.
 *
 * The ingredient is checked against the household first: another household's
 * ingredient is not a 403, it simply is not an ingredient this household has
 * (`CLAUDE.md`'s isolation rule). Adding one that is already there is not an
 * error — the member asked for a state, not for a change, and they now have
 * it.
 */
export async function addToPantry(
  db: D1Database,
  householdId: number,
  memberId: number,
  ingredientId: number,
): Promise<void> {
  await requireIngredient(db, householdId, ingredientId);

  await db
    .prepare(
      `INSERT INTO pantry_entry
         (household_id, ingredient_id, state, quantity, quantity_unit,
          added_at, added_by)
       VALUES (?, ?, 'unlimited', NULL, NULL, datetime('now'), ?)
       ON CONFLICT (household_id, ingredient_id) DO NOTHING`,
    )
    .bind(householdId, ingredientId, memberId)
    .run();
}

/**
 * Take it back out, because it ran out.
 *
 * Removing what is not there is not an error either, for the same reason: the
 * cupboard ends up in the state that was asked for.
 */
export async function removeFromPantry(
  db: D1Database,
  householdId: number,
  ingredientId: number,
): Promise<void> {
  await requireIngredient(db, householdId, ingredientId);

  await db
    .prepare(
      "DELETE FROM pantry_entry WHERE household_id = ? AND ingredient_id = ?",
    )
    .bind(householdId, ingredientId)
    .run();
}

async function requireIngredient(
  db: D1Database,
  householdId: number,
  ingredientId: number,
): Promise<void> {
  if (!Number.isSafeInteger(ingredientId)) {
    throw new PantryRefused("Tuntematon aines.");
  }

  const known = await db
    .prepare("SELECT id FROM ingredient WHERE id = ? AND household_id = ?")
    .bind(ingredientId, householdId)
    .first<{ id: number }>();
  if (known === null) throw new PantryRefused("Tuntematon aines.");
}

/** A shopping list sorted into what to buy and what is already at home. */
export interface PantrySplit {
  /** The rows that still have to be bought. */
  buy: ShoppingItem[];
  /** The rows the cupboard already covers, in the order the list had them. */
  atHome: ShoppingItem[];
}

/**
 * Sort an aggregated list by what the cupboard holds.
 *
 * A whole row goes one way or the other: v1 has no amounts to subtract, so an
 * ingredient in the cupboard is covered however much the week asks for (#125).
 * Neither side loses anything — the rows keep their totals and their
 * breakdowns, because "why does the week need oregano at all" is a question
 * worth being able to answer about a staple too.
 */
export function splitByPantry(
  items: ShoppingItem[],
  inPantry: ReadonlySet<number>,
): PantrySplit {
  const buy: ShoppingItem[] = [];
  const atHome: ShoppingItem[] = [];

  for (const item of items) {
    (inPantry.has(item.ingredientId) ? atHome : buy).push(item);
  }

  return { buy, atHome };
}
