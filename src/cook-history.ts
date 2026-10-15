import { today } from "./dates.ts";

/**
 * What a household's own cooking says about a recipe (#307).
 *
 * There is no cooking log and this adds none. A planned batch *is* one cooking,
 * however many meals it feeds, so the batches a household already keeps are the
 * history. A dish ticked off the to-do list (#345) counts once, on the day it
 * was ticked. A batch from the old meal calendar counts once, on the day of its
 * first occurrence, and only once that day has come. A dish still on the list
 * has neither, so it is a plan and not a cooking.
 *
 * It is the reader's own household that is counted, never the publisher's. On a
 * recipe another household shared, "3× · viimeksi 12.3." means this kitchen
 * cooked it three times; a household that has never cooked it sees that it has
 * never cooked it.
 *
 * A dish taken off the list without being cooked leaves nothing, because
 * `removeFromCookList` is a real delete.
 */
export interface CookRecord {
  /** How many times this household has cooked it. One batch is one cooking. */
  times: number;
  /** The day of the most recent cooking, or null when there has been none. */
  lastCooked: string | null;
}

export const NEVER_COOKED: CookRecord = { times: 0, lastCooked: null };

export type CookHistory = ReadonlyMap<number, CookRecord>;

export function cookedRecord(
  history: CookHistory,
  recipeId: number,
): CookRecord {
  return history.get(recipeId) ?? NEVER_COOKED;
}

interface HistoryRow {
  recipe_id: number;
  times: number;
  last_cooked: string | null;
}

/**
 * Every recipe this household has cooked, by recipe id.
 *
 * One query for the whole list rather than one per row: the inner select folds
 * a batch down to the day it was cooked, and the outer one
 * counts the batches. A recipe missing from the map has never been cooked here,
 * which is an ordinary state and not an absence to work around — `cookedRecord`
 * hands back `NEVER_COOKED` for it.
 */
export async function cookHistory(
  db: D1Database,
  householdId: number,
  upTo: string = today(),
): Promise<CookHistory> {
  const { results } = await db
    .prepare(
      `SELECT recipe_id, count(*) AS times, max(started) AS last_cooked
         FROM (SELECT planned_batch.id AS batch_id,
                      planned_batch.recipe_id AS recipe_id,
                      coalesce(planned_batch.cooked_on,
                               min(batch_occurrence.date)) AS started
                 FROM planned_batch
                 LEFT JOIN batch_occurrence
                   ON batch_occurrence.batch_id = planned_batch.id
                WHERE planned_batch.household_id = ?
                GROUP BY planned_batch.id)
        WHERE started <= ?
        GROUP BY recipe_id`,
    )
    .bind(householdId, upTo)
    .all<HistoryRow>();

  return new Map(
    results.map((row) => [
      row.recipe_id,
      { times: row.times, lastCooked: row.last_cooked },
    ]),
  );
}

/** This household's cooking of one recipe. */
export async function cookRecordFor(
  db: D1Database,
  householdId: number,
  recipeId: number,
): Promise<CookRecord> {
  return cookedRecord(await cookHistory(db, householdId), recipeId);
}

/**
 * Start a recipe's count over for this household (#366).
 *
 * The history is the batches themselves, so forgetting it is deleting the ones
 * the count reads: a dish ticked as cooked, or an old calendar batch whose
 * first day has come — exactly what `cookHistory` counts, and nothing else. A
 * dish still on the to-do list stays, and so does any other household's
 * cooking of the same shared recipe.
 */
export async function resetCookHistory(
  db: D1Database,
  householdId: number,
  recipeId: number,
  upTo: string = today(),
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM planned_batch
        WHERE household_id = ? AND recipe_id = ?
          AND coalesce(cooked_on,
                       (SELECT min(batch_occurrence.date)
                          FROM batch_occurrence
                         WHERE batch_occurrence.batch_id = planned_batch.id))
              <= ?`,
    )
    .bind(householdId, recipeId, upTo)
    .run();
}
