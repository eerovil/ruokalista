import { problem } from "./auth.ts";
import { addDays, isDate } from "./dates.ts";
import type { Member } from "./members.ts";
import type { RouteContext } from "./router.ts";

/**
 * A menu is a date-range projection of cooked batches. A batch has stable
 * identity and owns every lunch/dinner occurrence covered by the same cooking.
 * The week is still only a query: there is no menu or week record.
 */

export const SLOTS = ["lunch", "dinner"] as const;
export type Slot = (typeof SLOTS)[number];

export const DEFAULT_PORTIONS = 4;

export interface BatchOccurrence {
  date: string;
  slot: Slot;
}

export interface PlannedBatch {
  id: number;
  recipeId: number;
  title: string;
  /** The recipe's picture, so a planned meal can show what it will be. */
  imageKey: string | null;
  portions: number;
  occurrences: BatchOccurrence[];
  startDate: string;
  endDate: string;
}

interface BatchRow {
  id: number;
  recipe_id: number;
  title: string;
  image_key: string | null;
  portions: number;
  date: string;
  slot: Slot;
  start_date: string;
  end_date: string;
}

const BATCH_SELECT = `WITH spans AS (
                        SELECT batch_occurrence.batch_id,
                               min(batch_occurrence.date) AS start_date,
                               max(batch_occurrence.date) AS end_date
                          FROM batch_occurrence
                          JOIN planned_batch AS span_owner
                            ON span_owner.id = batch_occurrence.batch_id
                         WHERE span_owner.household_id = ?
                         GROUP BY batch_id
                      )
                      SELECT planned_batch.id,
                             planned_batch.recipe_id,
                             planned_batch.portions,
                             recipe.title,
                             recipe.image_key,
                             batch_occurrence.date,
                             batch_occurrence.slot,
                             spans.start_date,
                             spans.end_date
                        FROM planned_batch
                        JOIN recipe ON recipe.id = planned_batch.recipe_id
                        JOIN spans ON spans.batch_id = planned_batch.id
                        JOIN batch_occurrence
                          ON batch_occurrence.batch_id = planned_batch.id`;

/** Batches whose chronological span intersects the requested range. */
export async function menuBetween(
  db: D1Database,
  householdId: number,
  from: string,
  to: string,
): Promise<PlannedBatch[]> {
  const { results } = await db
    .prepare(
      `${BATCH_SELECT}
        WHERE planned_batch.household_id = ?
          AND spans.start_date <= ?
          AND spans.end_date >= ?
          AND batch_occurrence.date BETWEEN ? AND ?
        ORDER BY planned_batch.id,
                 batch_occurrence.date,
                 CASE batch_occurrence.slot WHEN 'lunch' THEN 0 ELSE 1 END`,
    )
    .bind(householdId, householdId, to, from, from, to)
    .all<BatchRow>();

  return groupBatches(results);
}

/** Another household's batch is absent rather than disclosed. */
export async function findPlannedBatch(
  db: D1Database,
  householdId: number,
  id: number,
): Promise<PlannedBatch | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;

  const { results } = await db
    .prepare(
      `${BATCH_SELECT}
        WHERE planned_batch.id = ? AND planned_batch.household_id = ?
        ORDER BY batch_occurrence.date,
                 CASE batch_occurrence.slot WHEN 'lunch' THEN 0 ELSE 1 END`,
    )
    .bind(householdId, id, householdId)
    .all<BatchRow>();

  return groupBatches(results)[0] ?? null;
}

function groupBatches(rows: BatchRow[]): PlannedBatch[] {
  const batches = new Map<number, PlannedBatch>();

  for (const row of rows) {
    let batch = batches.get(row.id);
    if (batch === undefined) {
      batch = {
        id: row.id,
        recipeId: row.recipe_id,
        title: row.title,
        imageKey: row.image_key,
        portions: row.portions,
        occurrences: [],
        startDate: row.start_date,
        endDate: row.end_date,
      };
      batches.set(row.id, batch);
    }
    batch.occurrences.push({ date: row.date, slot: row.slot });
  }

  return [...batches.values()];
}

export class MenuRefused extends Error {}

export async function addPlannedBatch(
  db: D1Database,
  member: Member,
  entry: { date: string; slot: string; recipeId: number; portions: number },
): Promise<number> {
  const occurrence = validateOccurrence(entry.date, entry.slot);
  validatePortions(entry.portions);
  await requireDish(db, member.householdId, entry.recipeId);

  const [inserted] = await db.batch([
    db.prepare(
      `INSERT INTO planned_batch
         (household_id, recipe_id, portions, created_by)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(member.householdId, entry.recipeId, entry.portions, member.id),
    db.prepare(
      `INSERT INTO batch_occurrence (batch_id, date, slot)
       VALUES (last_insert_rowid(), ?, ?)`,
    ).bind(occurrence.date, occurrence.slot),
  ]);

  if (inserted === undefined) throw new Error("Batch insert returned no result.");
  const id = Number(inserted.meta.last_row_id);
  return id;
}

export async function replaceOccurrences(
  db: D1Database,
  member: Member,
  id: number,
  proposed: BatchOccurrence[],
): Promise<boolean> {
  const occurrences = validateCoverage(proposed);
  const owned = await db
    .prepare("SELECT id FROM planned_batch WHERE id = ? AND household_id = ?")
    .bind(id, member.householdId)
    .first<{ id: number }>();
  if (owned === null) return false;

  await db.batch([
    db.prepare("DELETE FROM batch_occurrence WHERE batch_id = ?").bind(id),
    ...occurrences.map((occurrence) =>
      db
        .prepare(
          "INSERT INTO batch_occurrence (batch_id, date, slot) VALUES (?, ?, ?)",
        )
        .bind(id, occurrence.date, occurrence.slot),
    ),
  ]);
  return true;
}

export async function changePortions(
  db: D1Database,
  member: Member,
  id: number,
  portions: number,
): Promise<boolean> {
  validatePortions(portions);
  const result = await db
    .prepare(
      "UPDATE planned_batch SET portions = ? WHERE id = ? AND household_id = ?",
    )
    .bind(portions, id, member.householdId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function changeRecipe(
  db: D1Database,
  member: Member,
  id: number,
  recipeId: number,
): Promise<boolean> {
  await requireDish(db, member.householdId, recipeId);
  const result = await db
    .prepare(
      "UPDATE planned_batch SET recipe_id = ? WHERE id = ? AND household_id = ?",
    )
    .bind(recipeId, id, member.householdId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function removePlannedBatch(
  db: D1Database,
  member: Member,
  id: number,
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM planned_batch WHERE id = ? AND household_id = ?")
    .bind(id, member.householdId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export function validateCoverage(
  proposed: BatchOccurrence[],
): BatchOccurrence[] {
  if (proposed.length === 0) {
    throw new MenuRefused("Valitse vähintään yksi ateria.");
  }

  const unique = new Map<string, BatchOccurrence>();
  for (const item of proposed) {
    const occurrence = validateOccurrence(item.date, item.slot);
    unique.set(`${occurrence.date}:${occurrence.slot}`, occurrence);
  }
  const occurrences = [...unique.values()].sort(compareOccurrences);

  let previousDate = occurrences[0]!.date;
  for (const occurrence of occurrences.slice(1)) {
    if (occurrence.date !== previousDate) {
      if (occurrence.date !== addDays(previousDate, 1)) {
        throw new MenuRefused(
          "Jatkumon väliin ei voi jättää kokonaan tyhjää päivää.",
        );
      }
      previousDate = occurrence.date;
    }
  }
  return occurrences;
}

function validateOccurrence(date: string, slot: string): BatchOccurrence {
  if (!isDate(date)) throw new MenuRefused("Kelvoton päivä.");
  if (!isSlot(slot)) throw new MenuRefused("Kelvoton ateria.");
  return { date, slot };
}

function validatePortions(portions: number): void {
  if (!Number.isSafeInteger(portions) || portions <= 0) {
    throw new MenuRefused("Annosmäärän pitää olla vähintään yksi.");
  }
}

async function requireDish(
  db: D1Database,
  householdId: number,
  recipeId: number,
): Promise<void> {
  if (!Number.isSafeInteger(recipeId) || recipeId <= 0) {
    throw new MenuRefused("Tuntematon resepti.");
  }
  const recipe = await db
    .prepare(
      `SELECT id FROM recipe
        WHERE id = ? AND household_id = ? AND parent_id IS NULL`,
    )
    .bind(recipeId, householdId)
    .first<{ id: number }>();
  if (recipe === null) throw new MenuRefused("Tuntematon resepti.");
}

function compareOccurrences(a: BatchOccurrence, b: BatchOccurrence): number {
  return a.date.localeCompare(b.date) || SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot);
}

export function isSlot(value: string): value is Slot {
  return (SLOTS as readonly string[]).includes(value);
}

// ----------------------------------------------------------------- the API

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
    batches: await menuBetween(env.DB, member.householdId, from, to),
  });
}

export async function apiAddPlannedBatch(
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
    const id = await addPlannedBatch(env.DB, member, {
      date: String(body["date"] ?? ""),
      slot: String(body["slot"] ?? ""),
      recipeId: Number(body["recipeId"]),
      portions: Number(body["portions"]),
    });
    return Response.json({ id }, { status: 201 });
  } catch (error) {
    if (error instanceof MenuRefused) return problem(400, error.message);
    throw error;
  }
}

export async function apiUpdatePlannedBatch(
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
    const supplied = ["portions", "recipeId", "occurrences"].filter(
      (field) => body[field] !== undefined,
    );
    if (supplied.length !== 1) {
      return problem(400, "Change exactly one batch field at a time.");
    }
    let changed = false;
    if (body["portions"] !== undefined) {
      changed = await changePortions(
        env.DB,
        member,
        Number(params["id"]),
        Number(body["portions"]),
      );
    }
    if (body["recipeId"] !== undefined) {
      changed =
        (await changeRecipe(
          env.DB,
          member,
          Number(params["id"]),
          Number(body["recipeId"]),
        )) || changed;
    }
    if (body["occurrences"] !== undefined) {
      if (!Array.isArray(body["occurrences"])) {
        return problem(400, "occurrences must be an array.");
      }
      changed =
        (await replaceOccurrences(
          env.DB,
          member,
          Number(params["id"]),
          body["occurrences"].map((item) => {
            const value = item as Record<string, unknown>;
            return {
              date: String(value["date"] ?? ""),
              slot: String(value["slot"] ?? "") as Slot,
            };
          }),
        )) || changed;
    }
    if (!changed) return problem(404, "No such planned batch.");
  } catch (error) {
    if (error instanceof MenuRefused) return problem(400, error.message);
    throw error;
  }
  return new Response(null, { status: 204 });
}

export async function apiRemovePlannedBatch(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const removed = await removePlannedBatch(
    env.DB,
    member,
    Number(params["id"]),
  );
  if (!removed) return problem(404, "No such planned batch.");
  return new Response(null, { status: 204 });
}
