import { problem } from "./auth.ts";
import { onListSql } from "./batch-state.ts";
import { today } from "./dates.ts";
import type { Member } from "./members.ts";
import { readableRecipeScope } from "./recipe-publish.ts";
import type { RouteContext } from "./router.ts";
import { isMultiplier, parseMultiplier } from "./scaling.ts";

/**
 * The dishes a household means to cook, with no dates (#345).
 *
 * This replaced the meal calendar. A dish on the list is still one cooking, so
 * it is still a `planned_batch` row: one with no `batch_occurrence` rows and no
 * `cooked_on`. Ticking it as cooked writes today into `cooked_on`, which takes
 * it off the list and is the day the recipe's cooking history counts.
 *
 * The calendar's own batches are still in the table with their occurrences.
 * Nothing here reads or writes them — `OPEN_ON_LIST` leaves them out — and
 * every mutation below refuses one, so a stale calendar link cannot turn an
 * old plan into a list item.
 */

export interface ListedDish {
  id: number;
  /** Immutable identity for update/delete preconditions; unlike `id`, never reused. */
  instanceKey: string;
  recipeId: number;
  title: string;
  /** The recipe's picture, so the list can show what each dish is. */
  imageKey: string | null;
  /** How much of the recipe this one cooking makes. 1 is the recipe as written. */
  multiplier: number;
}

interface ListedRow {
  id: number;
  instance_key: string;
  recipe_id: number;
  title: string;
  image_key: string | null;
  multiplier: number;
}

const OPEN_ON_LIST = onListSql();

const LISTED_SELECT = `SELECT planned_batch.id,
                              planned_batch.instance_key,
                              planned_batch.recipe_id,
                              planned_batch.multiplier,
                              recipe.title,
                              recipe.image_key
                         FROM planned_batch
                         JOIN recipe ON recipe.id = planned_batch.recipe_id`;

/** The list, in the order the dishes were put on it. */
export async function cookList(
  db: D1Database,
  householdId: number,
): Promise<ListedDish[]> {
  const { results } = await db
    .prepare(
      `${LISTED_SELECT}
        WHERE planned_batch.household_id = ?
          AND ${OPEN_ON_LIST}
        ORDER BY planned_batch.id`,
    )
    .bind(householdId)
    .all<ListedRow>();
  return results.map(listedDish);
}

/** Another household's dish, a cooked one or a calendar one is absent. */
export async function findListedDish(
  db: D1Database,
  householdId: number,
  id: number,
): Promise<ListedDish | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const row = await db
    .prepare(
      `${LISTED_SELECT}
        WHERE planned_batch.id = ?
          AND planned_batch.household_id = ?
          AND ${OPEN_ON_LIST}`,
    )
    .bind(id, householdId)
    .first<ListedRow>();
  return row === null ? null : listedDish(row);
}

function listedDish(row: ListedRow): ListedDish {
  return {
    id: row.id,
    instanceKey: row.instance_key,
    recipeId: row.recipe_id,
    title: row.title,
    imageKey: row.image_key,
    multiplier: row.multiplier,
  };
}

export class CookListRefused extends Error {}

export interface ListedIdentity {
  id: number;
  instanceKey: string;
}

/**
 * Put a dish on the list. Only a dish this household may read, and never a
 * part: a part is cooked as a piece of its dish (ADR-0002).
 */
export async function addToCookList(
  db: D1Database,
  member: Member,
  entry: { recipeId: number; multiplier: number },
): Promise<ListedIdentity> {
  const multiplier = validateMultiplier(entry.multiplier);
  if (!Number.isSafeInteger(entry.recipeId) || entry.recipeId <= 0) {
    throw new CookListRefused("Tuntematon resepti.");
  }
  const instanceKey = crypto.randomUUID();
  const readable = readableRecipeScope(member.householdId);

  const inserted = await db
    .prepare(
      `INSERT INTO planned_batch
         (household_id, recipe_id, multiplier, created_by, instance_key)
       SELECT ?, ?, ?, ?, ?
         FROM recipe
        WHERE recipe.id = ?
          AND recipe.parent_id IS NULL
          AND ${readable.sql}`,
    )
    .bind(
      member.householdId,
      entry.recipeId,
      multiplier,
      member.id,
      instanceKey,
      entry.recipeId,
      ...readable.bindings,
    )
    .run();

  if ((inserted.meta.changes ?? 0) === 0) {
    throw new CookListRefused("Tuntematon resepti.");
  }
  return { id: Number(inserted.meta.last_row_id), instanceKey };
}

/**
 * How much of the recipe this cooking makes.
 *
 * Saving one also clears `legacy_portions`, which only a calendar batch from
 * before #165 can carry; it is cleared for the same reason it always was.
 */
export async function changeMultiplier(
  db: D1Database,
  member: Member,
  id: number,
  instanceKey: string,
  multiplier: number,
): Promise<boolean> {
  const value = validateMultiplier(multiplier);
  const result = await db
    .prepare(
      `UPDATE planned_batch
          SET multiplier = ?, legacy_portions = NULL
        WHERE id = ? AND household_id = ? AND instance_key = ?
          AND ${OPEN_ON_LIST}`,
    )
    .bind(value, id, member.householdId, instanceKey)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Cooked today: off the list, and into the recipe's cooking history. */
export async function markCooked(
  db: D1Database,
  member: Member,
  id: number,
  instanceKey: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE planned_batch SET cooked_on = ?
        WHERE id = ? AND household_id = ? AND instance_key = ?
          AND ${OPEN_ON_LIST}`,
    )
    .bind(today(), id, member.householdId, instanceKey)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Off the list without being cooked. A real delete: a dish that was never
 * cooked leaves nothing behind for the history to count.
 */
export async function removeFromCookList(
  db: D1Database,
  member: Member,
  id: number,
  instanceKey: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM planned_batch
        WHERE id = ? AND household_id = ? AND instance_key = ?
          AND ${OPEN_ON_LIST}`,
    )
    .bind(id, member.householdId, instanceKey)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * The multiplier as it will be stored, or a refusal.
 *
 * Goes through the same parser a typed field does, so `1,5` off a form and
 * `1.5` off the JSON API mean the same cooking and land on the same stored
 * number.
 */
export function validateMultiplier(multiplier: number): number {
  const parsed = isMultiplier(multiplier)
    ? parseMultiplier(String(multiplier))
    : null;
  if (parsed === null) {
    throw new CookListRefused(
      "Kertoimen pitää olla positiivinen luku, esimerkiksi 0,5 tai 1,5.",
    );
  }
  return parsed;
}

// ----------------------------------------------------------------- the API

/** `GET /api/batches` — the list. */
export async function apiCookList(
  { env }: RouteContext,
  member: Member,
): Promise<Response> {
  return Response.json({ batches: await cookList(env.DB, member.householdId) });
}

/** `POST /api/batches` — `{ recipeId, multiplier }` onto the list. */
export async function apiAddToCookList(
  { env, request }: RouteContext,
  member: Member,
): Promise<Response> {
  const body = await jsonBody(request);
  if (body === null) return problem(400, "Expected a JSON body.");
  try {
    const listed = await addToCookList(env.DB, member, {
      recipeId: Number(body["recipeId"]),
      multiplier: Number(body["multiplier"]),
    });
    return Response.json(listed, { status: 201 });
  } catch (error) {
    if (error instanceof CookListRefused) return problem(400, error.message);
    throw error;
  }
}

/**
 * `PATCH /api/batches/:id` — `{ instanceKey, multiplier }` or
 * `{ instanceKey, cooked: true }`, one change at a time.
 */
export async function apiUpdateCookList(
  { env, request, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const body = await jsonBody(request);
  if (body === null) return problem(400, "Expected a JSON body.");
  const supplied = ["multiplier", "cooked"].filter(
    (field) => body[field] !== undefined,
  );
  if (supplied.length !== 1) {
    return problem(400, "Change exactly one field at a time.");
  }
  if (body["cooked"] !== undefined && body["cooked"] !== true) {
    return problem(400, "cooked can only be true.");
  }

  const id = Number(params["id"]);
  const instanceKey = String(body["instanceKey"] ?? "");
  let changed: boolean;
  try {
    changed = body["cooked"] === true
      ? await markCooked(env.DB, member, id, instanceKey)
      : await changeMultiplier(
          env.DB,
          member,
          id,
          instanceKey,
          Number(body["multiplier"]),
        );
  } catch (error) {
    if (error instanceof CookListRefused) return problem(400, error.message);
    throw error;
  }
  if (!changed) return problem(404, "No such dish on the list.");
  return new Response(null, { status: 204 });
}

/** `DELETE /api/batches/:id?instanceKey=` — off the list, not cooked. */
export async function apiRemoveFromCookList(
  { env, params, url }: RouteContext,
  member: Member,
): Promise<Response> {
  const removed = await removeFromCookList(
    env.DB,
    member,
    Number(params["id"]),
    url.searchParams.get("instanceKey") ?? "",
  );
  if (!removed) return problem(404, "No such dish on the list.");
  return new Response(null, { status: 204 });
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await request.json()) as unknown;
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
