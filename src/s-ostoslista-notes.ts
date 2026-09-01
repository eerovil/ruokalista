/**
 * What this app last sent each shopping row to the S-ostoslista as, when it
 * went as free text rather than as a product.
 *
 * The point of remembering it is deletion. The S-list deletes a text row by
 * its exact words, and those words contain the amount — so the moment the
 * week's cooking changes, the note this app sent last time can no longer be
 * worked out from today's list. Without this table, choosing a product for an
 * ingredient leaves the old text row behind forever (#244).
 *
 * Why the exact string and not something cleverer: the acceptance criterion is
 * that a send never deletes a row the household added itself. Matching live
 * rows by ingredient name would delete a `juusto` somebody typed on the phone,
 * because from the outside it is the same row. Only a note this app is on
 * record as having sent is this app's to remove.
 *
 * Household-scoped like everything else that touches household data, and keyed
 * by the shopping row's own key (`shopping.ts::ShoppingItem.key`) so a dish
 * pinned to its own product keeps its own memory.
 */

/** Every note this household currently has out on the S-list, by row key. */
export async function sentNotes(
  db: D1Database,
  householdId: number,
): Promise<Map<string, string>> {
  const { results } = await db
    .prepare(
      "SELECT row_key, note FROM s_ostoslista_sent_note WHERE household_id = ?",
    )
    .bind(householdId)
    .all<{ row_key: string; note: string }>();

  return new Map(results.map((row) => [row.row_key, row.note]));
}

/**
 * Write down the note that has just gone out for this row, replacing whatever
 * this row's note used to be.
 *
 * One row can only have one note on the list at a time, so this is an upsert
 * rather than a second entry: the previous one has already been deleted by the
 * time anybody calls this, and keeping it would only offer a stale key to the
 * next send.
 */
export async function rememberSentNote(
  db: D1Database,
  householdId: number,
  rowKey: string,
  note: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO s_ostoslista_sent_note (household_id, row_key, note, sent_at)
            VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(household_id, row_key)
       DO UPDATE SET note = excluded.note, sent_at = excluded.sent_at`,
    )
    .bind(householdId, rowKey, note)
    .run();
}

/** This row no longer has a note out on the list. */
export async function forgetSentNote(
  db: D1Database,
  householdId: number,
  rowKey: string,
): Promise<void> {
  await db
    .prepare(
      "DELETE FROM s_ostoslista_sent_note WHERE household_id = ? AND row_key = ?",
    )
    .bind(householdId, rowKey)
    .run();
}
