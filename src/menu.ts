import { problem } from "./auth.ts";
import { isDate } from "./dates.ts";
import type { Member } from "./members.ts";
import type { RouteContext } from "./router.ts";

/**
 * A menu is the set of meal entries falling in a range of dates. It is not a
 * record of its own and not owned by anything — asking for a menu is asking a
 * question about dates, which is why there is no menu table.
 *
 * A slot with several rows is several people eating different food; a slot with
 * none is a slot nobody has filled. Nothing distinguishes an empty week from a
 * missing one, which is correct: there is nothing to create.
 */

export const SLOTS = ["lunch", "dinner"] as const;
export type Slot = (typeof SLOTS)[number];

/**
 * What portions to offer when a recipe does not say what it yields. The spec
 * asks only that the picker default to a household default; it never asked for
 * a column or a settings screen, and #13 added both. A constant is the whole of
 * what was specified.
 */
export const DEFAULT_PORTIONS = 4;

export interface MealEntry {
  id: number;
  date: string;
  slot: Slot;
  recipeId: number;
  title: string;
  portions: number;
}

interface EntryRow {
  id: number;
  date: string;
  slot: Slot;
  recipe_id: number;
  title: string;
  portions: number;
}

export async function menuBetween(
  db: D1Database,
  householdId: number,
  from: string,
  to: string,
): Promise<MealEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT meal_entry.id,
              meal_entry.date,
              meal_entry.slot,
              meal_entry.recipe_id,
              meal_entry.portions,
              recipe.title
         FROM meal_entry
         JOIN recipe ON recipe.id = meal_entry.recipe_id
        WHERE meal_entry.household_id = ?
          AND meal_entry.date BETWEEN ? AND ?
        ORDER BY meal_entry.date, meal_entry.slot, meal_entry.id`,
    )
    .bind(householdId, from, to)
    .all<EntryRow>();

  return results.map((row) => ({
    id: row.id,
    date: row.date,
    slot: row.slot,
    recipeId: row.recipe_id,
    title: row.title,
    portions: row.portions,
  }));
}

export class MenuRefused extends Error {}

export async function addMealEntry(
  db: D1Database,
  member: Member,
  entry: { date: string; slot: string; recipeId: number; portions: number },
): Promise<void> {
  if (!isDate(entry.date)) throw new MenuRefused("Kelvoton päivä.");
  if (!isSlot(entry.slot)) throw new MenuRefused("Kelvoton ateria.");
  if (!Number.isSafeInteger(entry.recipeId) || entry.recipeId <= 0) {
    throw new MenuRefused("Tuntematon resepti.");
  }
  if (!Number.isSafeInteger(entry.portions) || entry.portions <= 0) {
    throw new MenuRefused("Annosmäärän pitää olla vähintään yksi.");
  }

  // A recipe from another household is not on this household's menu, and a
  // part is not a dish of its own. Only parent recipes are plannable.
  const recipe = await db
    .prepare(
      `SELECT id FROM recipe
        WHERE id = ? AND household_id = ? AND parent_id IS NULL`,
    )
    .bind(entry.recipeId, member.householdId)
    .first<{ id: number }>();
  if (recipe === null) throw new MenuRefused("Tuntematon resepti.");

  await db
    .prepare(
      `INSERT INTO meal_entry
         (household_id, date, slot, recipe_id, portions, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      member.householdId,
      entry.date,
      entry.slot,
      entry.recipeId,
      entry.portions,
      member.id,
    )
    .run();
}

export async function changePortions(
  db: D1Database,
  member: Member,
  id: number,
  portions: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(portions) || portions <= 0) {
    throw new MenuRefused("Annosmäärän pitää olla vähintään yksi.");
  }

  const result = await db
    .prepare(
      "UPDATE meal_entry SET portions = ? WHERE id = ? AND household_id = ?",
    )
    .bind(portions, id, member.householdId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

export async function removeMealEntry(
  db: D1Database,
  member: Member,
  id: number,
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM meal_entry WHERE id = ? AND household_id = ?")
    .bind(id, member.householdId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

export function isSlot(value: string): value is Slot {
  return (SLOTS as readonly string[]).includes(value);
}

// ----------------------------------------------------------------- the API

/** `GET /api/menu?from=&to=` */
export async function apiMenu(
  { env, url }: RouteContext,
  member: Member,
): Promise<Response> {
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";

  if (!isDate(from) || !isDate(to)) {
    return problem(400, "Anna from ja to muodossa YYYY-MM-DD.");
  }
  if (to < from) return problem(400, "to on ennen from-päivää.");

  return Response.json({
    entries: await menuBetween(env.DB, member.householdId, from, to),
  });
}

/** `POST /api/meal-entries` */
export async function apiAddMealEntry(
  { env, request }: RouteContext,
  member: Member,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return problem(400, "Expected a JSON body.");
  }

  try {
    await addMealEntry(env.DB, member, {
      date: String(body["date"] ?? ""),
      slot: String(body["slot"] ?? ""),
      recipeId: Number(body["recipeId"]),
      portions: Number(body["portions"]),
    });
  } catch (error) {
    if (error instanceof MenuRefused) return problem(400, error.message);
    throw error;
  }

  return new Response(null, { status: 204 });
}

/** `PATCH /api/meal-entries/:id` */
export async function apiChangePortions(
  { env, request, params }: RouteContext,
  member: Member,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return problem(400, "Expected a JSON body.");
  }

  try {
    const changed = await changePortions(
      env.DB,
      member,
      Number(params["id"]),
      Number(body["portions"]),
    );
    if (!changed) return problem(404, "No such meal entry.");
  } catch (error) {
    if (error instanceof MenuRefused) return problem(400, error.message);
    throw error;
  }

  return new Response(null, { status: 204 });
}

/** `DELETE /api/meal-entries/:id` */
export async function apiRemoveMealEntry(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const removed = await removeMealEntry(env.DB, member, Number(params["id"]));
  if (!removed) return problem(404, "No such meal entry.");
  return new Response(null, { status: 204 });
}
