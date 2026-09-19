import { SOstoslistaError, type SOstoslistaKey } from "./s-ostoslista.ts";
import {
  forgetSentNote,
  rememberSentNote,
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
 * One shopping row that did not make it, in the shape a member message and a
 * log line can both be built from.
 *
 * `permanent` is the whole point of recording these: it is what separates "the
 * shop was busy, press it again" from "this row will never go, look at it".
 * `name` is the ingredient, which is what a member needs to hear; the log line
 * deliberately leaves it out and carries the row key instead.
 */
export interface SOstoslistaRowFailure {
  key: string;
  name: string;
  /** True when the row goes as free text rather than as a product. */
  note: boolean;
  permanent: boolean;
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
  const failures: SOstoslistaRowFailure[] = [];
  let retriesLeft = RETRY_BUDGET;
  let sent = 0;

  for (const item of items) {
    const attempts = retriesLeft > 0 ? ROW_ATTEMPTS : 1;
    let error: unknown = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await reconcileRow(db, householdId, client, item, {
          packets,
          addedProducts,
          outstanding,
        });
        error = null;
        break;
      } catch (thrown) {
        error = thrown;
        if (attempt === attempts || !isTransient(thrown)) break;
        retriesLeft -= 1;
        await wait(BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!);
      }
    }

    if (error === null) {
      sent += 1;
      continue;
    }
    failures.push(describeFailure(item, error));
  }

  if (failures.length > 0) {
    return { status: "partial", sent, total: items.length, failures };
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

/** The state one row's reconciliation shares with the rest of the send. */
interface RowContext {
  packets: Map<string, number>;
  addedProducts: Set<string>;
  outstanding: Map<string, string>;
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
  { packets, addedProducts, outstanding }: RowContext,
): Promise<void> {
  const previous = outstanding.get(item.key) ?? null;

  if (item.chosen.length === 0) {
    const note = `${item.name} — ${item.total}`;
    await client.add({ note });

    // Re-sending identical words is the same keyed external row. Removing
    // `previous` here would delete the row we just made sure exists.
    if (previous !== note) {
      if (previous !== null) await dropRememberedNote(client, previous);
      await rememberSentNote(db, householdId, item.key, note);
    }
    return;
  }

  for (const { product } of item.chosen) {
    if (addedProducts.has(product.ean)) continue;
    await client.add({ ean: product.ean }, packets.get(product.ean) ?? 1);
    addedProducts.add(product.ean);
  }

  // Product first, old text second, local receipt last. If any one of these
  // steps loses its response, repeating the whole send converges on the same
  // state instead of stranding either representation.
  if (previous !== null) {
    await dropRememberedNote(client, previous);
    await forgetSentNote(db, householdId, item.key);
  }
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
  const status = error instanceof SOstoslistaError ? error.status : null;
  return {
    key: item.key,
    name: item.name,
    note: item.chosen.length === 0,
    permanent: !isTransient(error),
    status,
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
