/**
 * The S-list rows this app put there, and taking them all off again (#358).
 *
 * The household asked for one button that clears what Ruokalista added to the
 * S-ostoslista and leaves what they typed on the phone. The service records no
 * author, so this app keeps its own: the id of every row a send *created*
 * (`s_ostoslista_sent_item`). Ids rather than keys, because the service
 * deletes by EAN across every copy and a note's words are not unique either.
 *
 * Rows sent before that record existed are not in it. The owner chose to have
 * the button guess those too rather than leave them by hand: a product row
 * whose EAN is one this household has chosen for an ingredient, and a text
 * row whose words this app remembers sending (`s_ostoslista_sent_note`). That
 * guess also takes a phone-added row of the same product — a risk the owner
 * accepted, so it is written down here rather than discovered.
 */

import { forgetSentNoteStatement, sentNotes } from "./s-ostoslista-notes.ts";
import {
  SOstoslistaError,
  type SOstoslistaItem,
} from "./s-ostoslista.ts";
import type { SubrequestBudget } from "./subrequests.ts";

/** Every S-list row id this household's sends created and nobody removed. */
export async function sentItemIds(
  db: D1Database,
  householdId: number,
): Promise<Set<string>> {
  const { results } = await db
    .prepare("SELECT item_id FROM s_ostoslista_sent_item WHERE household_id = ?")
    .bind(householdId)
    .all<{ item_id: string }>();
  return new Set(results.map((row) => row.item_id));
}

/** A send created this row — not yet run, so it joins the send's one batch. */
export function rememberSentItemStatement(
  db: D1Database,
  householdId: number,
  itemId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO s_ostoslista_sent_item (household_id, item_id, sent_at)
            VALUES (?, ?, datetime('now'))
       ON CONFLICT(household_id, item_id) DO NOTHING`,
    )
    .bind(householdId, itemId);
}

/** This row is off the list, by this app or by anybody. */
export function forgetSentItemStatement(
  db: D1Database,
  householdId: number,
  itemId: string,
): D1PreparedStatement {
  return db
    .prepare(
      "DELETE FROM s_ostoslista_sent_item WHERE household_id = ? AND item_id = ?",
    )
    .bind(householdId, itemId);
}

/** Every EAN this household has chosen, for an ingredient or one dish's line. */
async function chosenEans(db: D1Database, householdId: number): Promise<Set<string>> {
  // `ingredient_product` has no household: the integration is gated to one
  // household (`SOSTOSLISTA_HOUSEHOLD_ID`), and its mappings are global.
  const { results } = await db
    .prepare(
      `SELECT ean FROM ingredient_product
       UNION
       SELECT ean FROM recipe_ingredient_product WHERE household_id = ?`,
    )
    .bind(householdId)
    .all<{ ean: string }>();
  return new Set(results.map((row) => row.ean));
}

/** What the screen needs to know before anything is removed. */
export interface AppRows {
  /** Rows on the list, ticked or not, that this app put there. */
  rows: SOstoslistaItem[];
  /** Recorded ids no longer on the list, to be forgotten for free. */
  gone: string[];
  /** Remembered notes, by row key, for forgetting the ones taken off. */
  notes: Map<string, string>;
}

/**
 * Which of `list` is this app's: recorded, or guessed as above.
 *
 * Ticked rows count. The button is for clearing up after a shop, and the rows
 * left behind then are exactly the ticked ones.
 */
export async function appRows(
  db: D1Database,
  householdId: number,
  list: readonly SOstoslistaItem[],
): Promise<AppRows> {
  const [recorded, eans, notes] = await Promise.all([
    sentItemIds(db, householdId),
    chosenEans(db, householdId),
    sentNotes(db, householdId),
  ]);
  const noteWords = new Set(notes.values());
  const onList = new Set(list.map((row) => row.id));
  return {
    rows: list.filter(
      (row) =>
        recorded.has(row.id) ||
        (row.ean !== null ? eans.has(row.ean) : noteWords.has(row.name)),
    ),
    gone: [...recorded].filter((id) => !onList.has(id)),
    notes,
  };
}

export interface RemoveAppRowsClient {
  list(): Promise<SOstoslistaItem[]>;
  removeById(id: string): Promise<void>;
  sync(): Promise<void>;
}

export interface RemoveAppRowsOutcome {
  removed: number;
  /** How many there were to remove; more than `removed` when the calls ran out. */
  total: number;
  /** Whether the phone was pushed straight away. */
  synced: boolean;
}

/**
 * Take every row this app put on the S-list off it.
 *
 * `db` and `client` are both metered against `budget`, so every statement and
 * every call is counted where it is made. Each removal is one call, so a long
 * list can outrun one request's allowance; it stops at a row boundary, keeping
 * one call for the bookkeeping batch and one for the phone push, and says how
 * far it got — pressing again finishes the rest, because what was removed is no
 * longer on the list to be counted.
 *
 * A row already gone (404) is the wanted state: somebody cleared it on the
 * phone since the list was read.
 */
export async function removeAppRows(
  db: D1Database,
  householdId: number,
  client: RemoveAppRowsClient,
  budget: SubrequestBudget,
): Promise<RemoveAppRowsOutcome> {
  const list = await client.list();
  const { rows, gone, notes } = await appRows(db, householdId, list);

  const removed: SOstoslistaItem[] = [];
  let failure: unknown = null;
  for (const row of rows) {
    // The delete, the bookkeeping batch after it, and the phone push.
    if (!budget.canAfford(3)) break;
    try {
      await client.removeById(row.id);
    } catch (error) {
      if (!(error instanceof SOstoslistaError && error.status === 404)) {
        failure = error;
        break;
      }
    }
    removed.push(row);
  }

  const removedWords = new Set(
    removed.filter((row) => row.ean === null).map((row) => row.name),
  );
  const writes = [
    ...[...gone, ...removed.map((row) => row.id)].map((id) =>
      forgetSentItemStatement(db, householdId, id),
    ),
    ...[...notes]
      .filter(([, note]) => removedWords.has(note))
      .map(([rowKey]) => forgetSentNoteStatement(db, householdId, rowKey)),
  ];
  if (writes.length > 0) await db.batch(writes);

  // Nothing went and something broke: that is a failure to tell, not a count.
  if (failure !== null && removed.length === 0) throw failure;

  let synced = false;
  if (removed.length > 0 && budget.canAfford(1)) {
    try {
      await client.sync();
      synced = true;
    } catch {
      // The rows are already off the service's copy; the phone catches up at
      // the service's next sweep.
    }
  }
  return { removed: removed.length, total: rows.length, synced };
}
