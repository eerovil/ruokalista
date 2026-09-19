import { today } from "./dates.ts";

/**
 * What a household's own cooking says about a recipe (#307).
 *
 * There is no cooking log and this adds none. A planned batch *is* one cooking,
 * however many meals it feeds, so the batches a household already keeps are the
 * history: a batch counts once, on the day of its first occurrence, and only
 * once that day has come. Tomorrow's plan is a plan, not a cooking — which is
 * the same line `week-screens.ts::batchCard` draws when it says "Kokataan" on
 * one side of today and "Kokattu" on the other.
 *
 * It is the reader's own household that is counted, never the publisher's. On a
 * recipe another household shared, "3× · viimeksi 12.3." means this kitchen
 * cooked it three times; a household that has never cooked it sees that it has
 * never cooked it.
 *
 * A deleted batch takes its evidence with it, because `removePlannedBatch` is a
 * real delete. That is a known and accepted edge: a week somebody tidied up
 * afterwards reads as a week that was not cooked.
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
 * a batch's occurrences down to the day that batch started, and the outer one
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
                      min(batch_occurrence.date) AS started
                 FROM planned_batch
                 JOIN batch_occurrence
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
