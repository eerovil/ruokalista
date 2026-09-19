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
  correct(id: string, quantity?: number | null): Promise<unknown>;
  remove(key: SOstoslistaKey): Promise<unknown>;
  sync(): Promise<void>;
}

/** Only the shopping-row facts that can change what is sent externally. */
export type SOstoslistaSendItem = Pick<
  ShoppingItem,
  "key" | "name" | "total" | "chosen"
>;

/**
 * Why one row did not make it — the four answers that lead a member somewhere
 * different.
 *
 * - `refused`: the service looked at this row and said no, and will say no
 *   again. Only this one means the row itself is the problem.
 * - `unreachable`: the service could not answer this time. Press it again.
 * - `malformed`: the service answered, and the answer is not one this client
 *   can act on. Not a connection problem, and not the row's fault either.
 * - `local`: this app's own storage failed, not the service. Also press it
 *   again — and note that this is not the same as `refused` even though
 *   neither is retried inside one send. The per-row retry only repeats calls
 *   that the service's own answer says are worth repeating, so a failed D1
 *   receipt is left alone here; that is a statement about this send, not about
 *   whether the next one will work. `a failed local receipt remains retryable
 *   after the external replacement` is the test that says so.
 */
export type SOstoslistaFailureKind =
  | "refused"
  | "unreachable"
  | "malformed"
  | "local";

/**
 * Which part of reconciling a row failed — which is not the same question as
 * what kind of row it was.
 *
 * Putting a product on the list and deleting the text reminder that used to
 * stand in for it are two calls in one row's reconciliation, and they fail for
 * different reasons and want different words. Reading the row's own shape to
 * decide got this wrong in the case that matters most: a product row whose
 * product the service accepted and whose *old note* was then refused came out
 * as a refused product, and the member was sent to check a product choice
 * nothing was wrong with (#308 review).
 *
 * - `product`: getting this EAN onto the list at this trip's count.
 * - `note`: getting these words onto the list.
 * - `old-note`: removing the words a previous send left there. The row itself
 *   has already gone through by the time this runs.
 * - `receipt`: this app writing down what it sent. Nothing external at all.
 */
export type SOstoslistaOperation =
  | { kind: "product"; ean: string }
  | { kind: "note"; note: string }
  | { kind: "old-note"; note: string }
  | { kind: "receipt" };

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
  /** What this row was in the middle of when it failed. */
  operation: SOstoslistaOperation;
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

/**
 * Deliberately not narrowed to `SOstoslistaError`. The budget is shared with
 * D1, so the same failure can arrive from a statement as easily as from a
 * fetch, and it is the message that identifies it either way.
 */
function isCeiling(error: unknown): boolean {
  return error instanceof Error && SUBREQUEST_CEILING.test(error.message);
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
 * call is what keeps the whole thing inside the subrequest budget: it tells
 * every row whether it needs a call at all, and if it does, which single call.
 * So a row costs at most one, and a second press after a send that ran out is
 * not the same send over again — it is only what is left. Nothing is decided
 * on a guess; see `ensureOnList`.
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
  const opening = await heldByService(client);
  // Out of budget before the first row. Carrying on would mean a row call per
  // item that cannot land, so there is nothing to do but say so; nothing has
  // been sent and nothing has been written down.
  if (opening.ceiling) {
    return {
      status: "partial",
      sent: 0,
      total: items.length,
      failures: [],
      ceiling: true,
    };
  }
  const held = opening.held;
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
        const why = causeOf(thrown);
        // The ceiling first, because it reaches here looking exactly like a
        // dropped connection — a transport failure, which `isTransient` says to
        // retry. Retrying it is the one thing it must never get: the budget
        // does not come back inside this invocation, so each further attempt is
        // another call that cannot succeed and another backoff spent waiting
        // for nothing.
        if (isCeiling(why)) break;
        if (attempt === ROW_ATTEMPTS || retriesLeft <= 0 || !isTransient(why)) {
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
    if (isCeiling(causeOf(error))) {
      ceiling = true;
      break;
    }
    failures.push(describeFailure(item, error));
  }

  // Nothing follows the ceiling. Not the receipts, not the push — the budget
  // is gone, so every one of those is a call that cannot succeed, and the
  // batch failing was being charged back against `sent`, which is how a send
  // that really did put rows on the list could report "Mitään ei lähetetty".
  //
  // The receipts simply stay unwritten. That is safe for the reason the whole
  // send is safe to repeat: the next press reads the list first, finds those
  // rows already there, re-earns the same receipts for no external call, and
  // writes them then.
  if (!ceiling) {
    const lost = await flush(db, bookkeeping);
    if (lost !== null) {
      // The batch itself can be the call that runs out. Same answer.
      if (isCeiling(lost)) {
        ceiling = true;
      } else {
        // A lost receipt is this app losing track of a row it did put on the
        // list — never a refusal, and never a reason to send a member looking
        // at a product. `sent` is not reduced for it either: the row reached
        // the service, which is what that number says.
        for (const { item } of bookkeeping) failures.push(describeFailure(item, lost));
      }
    }
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
): Promise<{ held: readonly SOstoslistaItem[]; ceiling: boolean }> {
  try {
    return { held: await client.list(), ceiling: false };
  } catch (error) {
    // Running out of subrequests is the one failure this cannot shrug off. It
    // does not mean "no shortcut this time", it means there are no calls left
    // — and every row would then spend one proving it.
    if (isCeiling(error)) return { held: [], ceiling: true };
    return { held: [], ceiling: false };
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

/**
 * An error with the operation that raised it attached.
 *
 * The alternative was to guess afterwards from the row's shape, which is
 * exactly the guess that mis-blamed a product for a note deletion. Tagging at
 * the call site costs one wrapper and removes the guess.
 */
class StepFailure extends Error {
  // Declared and assigned rather than written as constructor parameter
  // properties: `npm run check` runs these modules under Node's strip-only
  // TypeScript, which cannot compile a parameter property and refuses the
  // whole file with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. It typechecks and runs
  // under `tsx` either way, so the only thing that catches it is the check.
  readonly operation: SOstoslistaOperation;
  readonly reason: unknown;

  constructor(operation: SOstoslistaOperation, reason: unknown) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = "StepFailure";
    this.operation = operation;
    this.reason = reason;
  }
}

/** Run one step of a row's reconciliation, saying what it was. */
async function step<T>(
  operation: SOstoslistaOperation,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw error instanceof StepFailure ? error : new StepFailure(operation, error);
  }
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
    await step({ kind: "note", note }, () =>
      ensureOnList(client, held, { note }, null),
    );

    // Re-sending identical words is the same keyed external row. Removing
    // `previous` here would delete the row we just made sure exists.
    if (previous !== note) {
      if (previous !== null) {
        await step({ kind: "old-note", note: previous }, () =>
          dropRememberedNote(client, previous),
        );
      }
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
    await step({ kind: "product", ean: product.ean }, () =>
      ensureOnList(client, held, { ean: product.ean }, count),
    );
    addedProducts.add(product.ean);
  }

  // Product first, old text second, local receipt last. If any one of these
  // steps loses its response, repeating the whole send converges on the same
  // state instead of stranding either representation.
  if (previous !== null) {
    await step({ kind: "old-note", note: previous }, () =>
      dropRememberedNote(client, previous),
    );
    bookkeeping.push({
      item,
      statement: forgetSentNoteStatement(db, householdId, item.key),
    });
  }
}

/**
 * Make sure the service is holding this row, still to be bought, at this
 * trip's count — for as few calls as the list read allows.
 *
 * Three cases, and the middle one is what #308's review was about:
 *
 * - the service is not holding it at all: one keyed `POST`, which is the only
 *   call that can create a row;
 * - it is holding it but has it ticked, or at last week's count, or will not
 *   say: one `PATCH` straight at the id the list already gave us. This is the
 *   ordinary state of a re-used shopping list, not an edge case, and it used
 *   to cost a `POST` whose entire purpose was to be told an id we were already
 *   looking at, and then the same `PATCH` anyway;
 * - it is holding it exactly as asked: nothing at all.
 *
 * So a row costs at most one call however the list started, which is what
 * keeps a normal week inside one invocation's budget.
 *
 * `agrees` is deliberately hard to satisfy: a service that omits `collected`
 * has told us nothing, and #236 is exactly the bug where a row that looked
 * fine was last week's, ticked. Silence therefore counts as disagreement and
 * gets the correction. Where the list holds the same key more than once, every
 * copy that disagrees is corrected — one ticked duplicate is still a row the
 * member would not buy, and the old keyed `POST` could never reach more than
 * one of them.
 */
async function ensureOnList(
  client: SOstoslistaSyncClient,
  held: readonly SOstoslistaItem[],
  key: SOstoslistaKey,
  quantity: number | null,
): Promise<void> {
  const matching = held.filter((row) =>
    "ean" in key ? row.ean === key.ean : row.ean === null && row.name === key.note,
  );
  if (matching.length === 0) {
    await client.add(key, quantity);
    return;
  }
  for (const row of matching) {
    if (agrees(row, quantity)) continue;
    await client.correct(row.id, quantity);
  }
}

function agrees(row: SOstoslistaItem, quantity: number | null): boolean {
  return (
    row.collectedStated &&
    !row.collected &&
    (quantity === null || row.quantity === quantity)
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
  switch (error.cause) {
    // The request never landed. Nothing was said, so saying it again is the
    // whole of the remedy.
    case "transport":
      return true;
    // This app refused to send something. It will refuse identically.
    case "local":
      return false;
    // The service answered. Whether that is worth repeating is a question
    // about the status it answered with, and about nothing else — including
    // when the body was unreadable, because a gateway's HTML error page at 502
    // is still a 502, while a broken body on a 200 is a broken body.
    case "http":
    case "response": {
      const { status } = error;
      if (status === null) return false;
      return status === 408 || status === 425 || status === 429 || status >= 500;
    }
  }
}

/** The error a step actually failed on, out from under its operation tag. */
function causeOf(error: unknown): unknown {
  return error instanceof StepFailure ? error.reason : error;
}

/** Where a failed step was aimed, for an error that never got tagged. */
const UNTAGGED: SOstoslistaOperation = { kind: "receipt" };

function describeFailure(
  item: SOstoslistaSendItem,
  thrown: unknown,
): SOstoslistaRowFailure {
  const operation = thrown instanceof StepFailure ? thrown.operation : UNTAGGED;
  const error = causeOf(thrown);
  return {
    key: item.key,
    name: item.name,
    operation,
    kind: kindOf(error),
    status: error instanceof SOstoslistaError ? error.status : null,
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Not-retried and refused are different facts, and so are refused and
 * answered-with-nonsense.
 *
 * Anything that is not the client's own error never reached the service — a
 * failed D1 write, a bug — so it cannot be a refusal. Beyond that the cause
 * decides: the service saying no is a refusal, the service saying something
 * unreadable is its own thing rather than a connection problem to blame on the
 * network, and this app's own validation is local.
 */
function kindOf(error: unknown): SOstoslistaFailureKind {
  if (!(error instanceof SOstoslistaError)) return "local";
  if (error.cause === "local") return "local";
  if (error.cause === "response") return "malformed";
  return isTransient(error) ? "unreachable" : "refused";
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
