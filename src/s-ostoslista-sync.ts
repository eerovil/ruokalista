import {
  SOstoslistaError,
  type SOstoslistaItem,
  type SOstoslistaKey,
} from "./s-ostoslista.ts";
import {
  forgetSentNoteStatement,
  rememberSentNoteStatement,
  sentNotes,
} from "./s-ostoslista-notes.ts";
import type { ShoppingItem } from "./shopping.ts";

/**
 * The part of the S-ostoslista client the reconciliation workflow needs.
 *
 * Kept structural on purpose: `SOstoslistaClient` is the production adapter,
 * while focused tests can supply a tiny fake without knowing HTTP at all.
 */
export interface SOstoslistaSyncClient {
  list(): Promise<SOstoslistaItem[]>;
  add(key: SOstoslistaKey, quantity?: number | null): Promise<unknown>;
  remove(key: SOstoslistaKey): Promise<unknown>;
  sync(): Promise<void>;
}

/** Only the shopping-row facts that can change what is sent externally. */
export type SOstoslistaSendItem = Pick<
  ShoppingItem,
  "key" | "name" | "total" | "chosen"
>;

/**
 * Why one row did not make it — the three answers that lead a member somewhere
 * different.
 *
 * - `refused`: the service looked at this row and said no, and will say no
 *   again. Only this one means the row itself is the problem.
 * - `unreachable`: the service could not answer this time. Press it again.
 * - `local`: this app's own storage failed, not the service. Also press it
 *   again — and note that this is not the same as `refused` even though
 *   neither is retried inside one send. The per-row retry only repeats calls
 *   that the service's own answer says are worth repeating, so a failed D1
 *   receipt is left alone here; that is a statement about this send, not about
 *   whether the next one will work. `a failed local receipt remains retryable
 *   after the external replacement` is the test that says so.
 */
export type SOstoslistaFailureKind = "refused" | "unreachable" | "local";

/**
 * One shopping row that did not make it, in the shape a member message and a
 * log line can both be built from.
 *
 * `name` is the ingredient, which is what a member needs to hear; the log line
 * deliberately leaves it out and carries the row key instead.
 */
export interface SOstoslistaRowFailure {
  key: string;
  name: string;
  /** True when the row goes as free text rather than as a product. */
  note: boolean;
  kind: SOstoslistaFailureKind;
  status: number | null;
  message: string;
}

export type SOstoslistaSendOutcome =
  | {
      status: "sent";
      sent: number;
      total: number;
      failures: readonly [];
      synced: true;
    }
  | {
      status: "sent";
      sent: number;
      total: number;
      failures: readonly [];
      synced: false;
      syncError: unknown;
    }
  | {
      status: "partial";
      sent: number;
      total: number;
      failures: readonly SOstoslistaRowFailure[];
      /**
       * True when the Worker ran out of subrequests rather than the rows
       * having anything wrong with them. The rows after that point were never
       * attempted, so they are not failures — see `SUBREQUEST_CEILING`.
       */
      ceiling: boolean;
    };

/**
 * How many times one row is attempted before it is written off for this send,
 * and how long the pauses between those attempts are.
 *
 * Small on purpose. The send runs inside the member's own request, so every
 * millisecond spent waiting is a millisecond the button stays spinning; the
 * pauses exist to let a moment's congestion pass, not to outlast an outage.
 */
const ROW_ATTEMPTS = 3;
const BACKOFF_MS = [200, 600];

/**
 * How many retries the whole send may spend in total, however many rows ask
 * for one.
 *
 * Without this, a service that is refusing everything turns a 32-row list into
 * 96 calls and half a minute of sleeping before the member is told anything.
 * Once the budget is gone the remaining rows are still attempted — just once
 * each — so the send still finishes and still reports every row.
 */
const RETRY_BUDGET = 8;

/**
 * The runtime refusing to make another call at all, which is what #308 turned
 * out to be: `Too many subrequests by single Worker invocation`.
 *
 * Every outgoing call an invocation makes counts against one budget — the
 * S-ostoslista calls and every D1 query alike — and on this account's plan
 * that budget is fifty and cannot be raised from `wrangler.jsonc`. A 32-row
 * list used to spend two calls per row, so it ran out somewhere in the
 * twenties, which is where "28/32" came from.
 *
 * It is matched on the message because that is the only thing the runtime
 * gives: the failure arrives as a rejected `fetch`, with no status and no
 * type of its own. Matching it matters because it is neither of the two
 * things the rest of this module knows how to do. Retrying it is pointless —
 * the budget does not come back inside the same invocation — and calling it a
 * bad row blames thirty rows that were never tried. So the send stops there
 * and says so, and the next press picks up where this one ran out.
 */
const SUBREQUEST_CEILING = /too many subrequests/i;

function isCeiling(error: unknown): boolean {
  return error instanceof SOstoslistaError && SUBREQUEST_CEILING.test(error.message);
}

export interface SOstoslistaSendOptions {
  /** Swapped out in tests so a retry path costs no wall-clock. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * Reconcile one freshly-computed Ruokalista shopping list into S-ostoslista.
 *
 * This owns the retry contract rather than the screen that happens to invoke it:
 *
 * - one external EAN row receives the aggregate packet count across local rows;
 * - a text row is remembered by its exact sent words, so only our own note can
 *   later be removed;
 * - replacements are add-first, delete-second, remember/forget-last, making a
 *   retry safe after every interruption point;
 * - an already-missing old note is the desired state, not an outage;
 * - the phone is pushed only after every row has been reconciled, and a failed
 *   push is a warning rather than a failed send.
 *
 * Every row is attempted, including the rows after one that failed (#308).
 * Abandoning the remainder at the first failure was what turned any single bad
 * row — a product the service rejects, a moment's congestion, a ceiling — into
 * the same unreadable "28/32 ainesta ehdittiin lähettää", because the one thing
 * the member was never told was which row and why. A row is retried only when
 * the service's own answer says the failure was transient; a plain refusal is
 * recorded and the send moves on.
 *
 * Retrying a whole row rather than a single call is safe for exactly the reason
 * the add-first ordering above exists: replaying a row converges on the same
 * state, because the external add is keyed and the note delete tolerates a row
 * that has already gone.
 *
 * The send opens by reading the list the service already holds, and that one
 * call is what keeps the whole thing inside the subrequest budget. A row the
 * list already holds in the state this send wants costs nothing to reconcile,
 * so a second press after a send that ran out is not the same send over again:
 * it is only what is left. It also makes an ordinary week's re-send nearly
 * free. Nothing is skipped on a guess — see `alreadyOnList`.
 */
export async function sendToSOstoslista(
  db: D1Database,
  householdId: number,
  client: SOstoslistaSyncClient,
  items: readonly SOstoslistaSendItem[],
  options: SOstoslistaSendOptions = {},
): Promise<SOstoslistaSendOutcome> {
  const wait = options.wait ?? sleep;
  const packets = packetCounts(items);
  const addedProducts = new Set<string>();
  const outstanding = await sentNotes(db, householdId);
  const held = await heldByService(client);
  const bookkeeping: Receipt[] = [];
  const failures: SOstoslistaRowFailure[] = [];
  let retriesLeft = RETRY_BUDGET;
  let ceiling = false;
  let sent = 0;

  for (const item of items) {
    let error: unknown = null;

    // The budget is checked immediately before each retry and spent only when
    // one is actually made. Deciding a row's allowance up front instead let a
    // row that failed twice take two retries out of a budget with one left in
    // it, so the eighth retry was followed by a ninth.
    for (let attempt = 1; attempt <= ROW_ATTEMPTS; attempt += 1) {
      try {
        await reconcileRow(db, householdId, client, item, {
          packets,
          addedProducts,
          outstanding,
          held,
          bookkeeping,
        });
        error = null;
        break;
      } catch (thrown) {
        error = thrown;
        if (attempt === ROW_ATTEMPTS || retriesLeft <= 0 || !isTransient(thrown)) {
          break;
        }
        retriesLeft -= 1;
        await wait(BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!);
      }
    }

    if (error === null) {
      sent += 1;
      continue;
    }
    // Out of subrequests is the invocation ending, not this row being bad. The
    // rows after it are untouched rather than failed, and there is no point
    // asking for the next one.
    if (isCeiling(error)) {
      ceiling = true;
      break;
    }
    failures.push(describeFailure(item, error));
  }

  // A lost receipt is this app losing track of a row it did put on the list,
  // so it is a `local` failure on each row that earned one — never a refusal,
  // and never a reason to tell a member to go and look at a product.
  const lost = await flush(db, bookkeeping);
  if (lost !== null) {
    for (const { item } of bookkeeping) failures.push(describeFailure(item, lost));
    sent -= bookkeeping.length;
  }

  if (failures.length > 0 || ceiling) {
    return { status: "partial", sent, total: items.length, failures, ceiling };
  }

  try {
    await client.sync();
    return { status: "sent", sent, total: items.length, failures: [], synced: true };
  } catch (syncError) {
    return {
      status: "sent",
      sent,
      total: items.length,
      failures: [],
      synced: false,
      syncError,
    };
  }
}

/**
 * What the service is holding right now, or nothing if it would not say.
 *
 * A read that fails is not a failed send: it only means this send skips
 * nothing and reconciles every row the long way, which is what it did before
 * this read existed. Refusing the whole send over it would trade a slow send
 * for no send.
 */
async function heldByService(
  client: SOstoslistaSyncClient,
): Promise<readonly SOstoslistaItem[]> {
  try {
    return await client.list();
  } catch {
    return [];
  }
}

/**
 * Put the send's note bookkeeping through in one go.
 *
 * One `db.batch` rather than a write per row, because D1 calls come out of the
 * same subrequest budget as the S-ostoslista calls and a list this size cannot
 * spare eight of them (#308).
 *
 * Deferring the writes to the end is safe for the same reason the per-row
 * ordering was: every write here is one this send has already earned
 * externally, and losing them all converges anyway. A row whose new note went
 * out and whose old note was deleted, but whose receipt never landed, is read
 * next time as still owing the old note — so the next send deletes a row that
 * has already gone, which this module has always treated as the wanted state,
 * and then records the new one.
 */
async function flush(
  db: D1Database,
  receipts: readonly Receipt[],
): Promise<unknown | null> {
  if (receipts.length === 0) return null;
  try {
    await db.batch(receipts.map((receipt) => receipt.statement));
    return null;
  } catch (error) {
    return error;
  }
}

/** The state one row's reconciliation shares with the rest of the send. */
interface RowContext {
  packets: Map<string, number>;
  addedProducts: Set<string>;
  outstanding: Map<string, string>;
  /** What the service already held when this send started. */
  held: readonly SOstoslistaItem[];
  /** Note receipts earned so far, run as one batch when the send ends. */
  bookkeeping: Receipt[];
}

/** One deferred note write, kept beside the row that earned it. */
interface Receipt {
  item: SOstoslistaSendItem;
  statement: D1PreparedStatement;
}

/**
 * Put one shopping row where it belongs on the external list.
 *
 * Unchanged from the single-pass version it was lifted out of, except that it
 * can now be called twice for the same row. `addedProducts` is what makes the
 * second call cheap rather than wrong: a product already accepted this send is
 * not re-sent, so a row that failed on its note deletion does not re-add its
 * product on the retry.
 */
async function reconcileRow(
  db: D1Database,
  householdId: number,
  client: SOstoslistaSyncClient,
  item: SOstoslistaSendItem,
  { packets, addedProducts, outstanding, held, bookkeeping }: RowContext,
): Promise<void> {
  const previous = outstanding.get(item.key) ?? null;

  if (item.chosen.length === 0) {
    const note = `${item.name} — ${item.total}`;
    if (!alreadyOnList(held, { note }, null)) await client.add({ note });

    // Re-sending identical words is the same keyed external row. Removing
    // `previous` here would delete the row we just made sure exists.
    if (previous !== note) {
      if (previous !== null) await dropRememberedNote(client, previous);
      bookkeeping.push({
        item,
        statement: rememberSentNoteStatement(db, householdId, item.key, note),
      });
    }
    return;
  }

  for (const { product } of item.chosen) {
    if (addedProducts.has(product.ean)) continue;
    const count = packets.get(product.ean) ?? 1;
    if (!alreadyOnList(held, { ean: product.ean }, count)) {
      await client.add({ ean: product.ean }, count);
    }
    addedProducts.add(product.ean);
  }

  // Product first, old text second, local receipt last. If any one of these
  // steps loses its response, repeating the whole send converges on the same
  // state instead of stranding either representation.
  if (previous !== null) {
    await dropRememberedNote(client, previous);
    bookkeeping.push({
      item,
      statement: forgetSentNoteStatement(db, householdId, item.key),
    });
  }
}

/**
 * Whether the service is already holding this row exactly as this send wants
 * it, so that adding it again would change nothing.
 *
 * Deliberately hard to satisfy. It is not enough for a row with this key to
 * exist: it has to be one the service has said out loud is still to be bought,
 * and for a product it has to be holding this trip's packet count as well. A
 * service that omits the flag has told us nothing, and #236 is exactly the bug
 * where a row that looked fine was in fact last week's, ticked — so silence
 * means add, the same answer this returned before the check existed.
 *
 * Where the list holds the same key more than once, every copy has to pass:
 * one ticked duplicate is a row the member would not buy, and the add is what
 * clears it.
 */
function alreadyOnList(
  held: readonly SOstoslistaItem[],
  key: SOstoslistaKey,
  quantity: number | null,
): boolean {
  const matching = held.filter((row) =>
    "ean" in key ? row.ean === key.ean : row.ean === null && row.name === key.note,
  );
  if (matching.length === 0) return false;
  return matching.every(
    (row) =>
      row.collectedStated &&
      !row.collected &&
      (quantity === null || row.quantity === quantity),
  );
}

/**
 * Whether pressing on is worth anything.
 *
 * Only the client's own error carries a verdict: it is the one that knows a
 * refusal's status code, and it is the one that turns a dropped connection into
 * a status-less failure. Anything else reaching here — a D1 write that failed, a
 * bug — is not something a second identical attempt fixes, so it is recorded
 * once and left alone.
 *
 * 429 and 5xx are the service saying "later"; 408 and 425 are the request never
 * having landed. Every other 4xx is the service saying "no", and retrying that
 * is how an app spends a member's afternoon on an answer it already has.
 */
function isTransient(error: unknown): boolean {
  if (!(error instanceof SOstoslistaError)) return false;
  const { status } = error;
  if (status === null) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function describeFailure(
  item: SOstoslistaSendItem,
  error: unknown,
): SOstoslistaRowFailure {
  // Not-retried and refused are different facts, and conflating them told a
  // member whose D1 receipt write failed to go and check a product choice that
  // had nothing wrong with it. Only the client's own error can be a refusal,
  // because only it has been to the service.
  const fromService = error instanceof SOstoslistaError;
  const kind: SOstoslistaFailureKind = !fromService
    ? "local"
    : isTransient(error)
      ? "unreachable"
      : "refused";
  return {
    key: item.key,
    name: item.name,
    note: item.chosen.length === 0,
    kind,
    status: fromService ? error.status : null,
    message: error instanceof Error ? error.message : String(error),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Remove a note this app previously recorded as its own.
 *
 * Somebody may have collected/cleared it on the phone since our last send; a
 * provider 404 then already means exactly what this reconciliation wants.
 */
async function dropRememberedNote(
  client: SOstoslistaSyncClient,
  note: string,
): Promise<void> {
  try {
    await client.remove({ note });
  } catch (error) {
    if (error instanceof SOstoslistaError && error.status === 404) return;
    throw error;
  }
}

/** One external product row, one packet count across every local shopping row. */
function packetCounts(items: readonly SOstoslistaSendItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const { product, count } of item.chosen) {
      counts.set(product.ean, (counts.get(product.ean) ?? 0) + count);
    }
  }
  return counts;
}
