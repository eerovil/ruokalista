/**
 * Where a planned batch stands, as SQL every module that asks shares (#345).
 *
 * One table holds two kinds of batch: the dishes on the to-do list, which have
 * no days, and the old meal calendar's batches, which have occurrences. The
 * list ignores the calendar's rows, but the rules about sharing and deleting a
 * recipe have to read both, so the two questions live here rather than once
 * in each of those modules.
 */

/** On the to-do list: never dated by the calendar, and not yet cooked. */
export function onListSql(alias = "planned_batch"): string {
  return `(${alias}.cooked_on IS NULL
           AND NOT EXISTS (
                 SELECT 1 FROM batch_occurrence AS listed_occurrence
                  WHERE listed_occurrence.batch_id = ${alias}.id
               ))`;
}

/**
 * Still somebody's plan: on the to-do list, or on a calendar day that has not
 * passed. One placeholder, which takes today.
 *
 * `>= today` rather than `> today` for the calendar: a batch being cooked this
 * evening is still somebody's dinner tonight. "Today" is today in the kitchen
 * (`src/dates.ts`), not in UTC.
 */
export function stillPlannedSql(alias = "planned_batch"): string {
  return `(${onListSql(alias)}
           OR EXISTS (
                SELECT 1 FROM batch_occurrence AS future_occurrence
                 WHERE future_occurrence.batch_id = ${alias}.id
                   AND future_occurrence.date >= ?
              ))`;
}
