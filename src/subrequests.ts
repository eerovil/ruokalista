/**
 * How many outgoing calls one Worker invocation has left, and who may have
 * them.
 *
 * Every `fetch` a Worker makes and every D1 statement it runs comes out of one
 * per-invocation allowance. On this deployment's plan that allowance is 50 and
 * `wrangler.jsonc` cannot raise it — `limits.subrequests` tops out at the
 * plan's own number. Exceeding it is not a slow failure or a degraded one: the
 * runtime refuses the call outright with `Too many subrequests by single
 * Worker invocation`, and whatever the code was in the middle of stops there.
 *
 * Issue #308 was that failure, and several attempts at it all did the same
 * thing in different places: start an operation, and deal with the refusal if
 * one came back. That answers the question too late, and each guard was
 * correct about its own call and silent about the next.
 *
 * So the work says what it is about to cost, the ledger says whether that
 * fits, and an operation that does not fit is not begun.
 *
 * ## Two jobs, deliberately split
 *
 * **Spending** happens at the real boundary. `meteredFetch` draws down the
 * ledger immediately before each outgoing request, so `left` counts what
 * Cloudflare counts — not what some caller estimated. This matters because one
 * call in this app's vocabulary is not always one subrequest:
 * `SOstoslistaClient.add` is a keyed `POST` and then, when the answer comes
 * back disagreeing, a `PATCH` as well. Pricing that as one was how the ledger
 * came to measure a different unit from the runtime.
 *
 * **Approving** happens per unit of work. A shopping row is approved as a
 * whole against its worst-case price before any of it runs, because half a
 * reconciled row is the state this issue exists to avoid. Where the worst case
 * does not materialise the difference simply stays in the ledger — approval
 * gates, it does not deduct.
 *
 * ## The tail
 *
 * Some of a send's calls are not optional: writing down what was sent has to
 * happen, or the next send cannot tell its own old rows from the household's.
 * That allowance is held back from row work entirely and spent through
 * `spendTail`. Pushing the phone's list *is* optional — the service syncs on
 * its own schedule — so it simply asks at the time and does without.
 */

/**
 * The per-invocation allowance this Worker actually has.
 *
 * Free plan. Raising it means a paid plan, not a config change: Cloudflare's
 * `limits.subrequests` maximum on this plan is this same number.
 */
export const SUBREQUEST_CEILING = 50;

/**
 * The ledger refusing a call before it is made.
 *
 * Distinct from the runtime's own refusal on purpose. This one arrives instead
 * of a subrequest rather than because of one, so nothing has been spent and
 * nothing is half-done.
 */
export class SubrequestBudgetSpent extends Error {
  constructor() {
    super("No subrequests left in this invocation's budget.");
    this.name = "SubrequestBudgetSpent";
  }
}

/**
 * An allowance set aside for one operation, and spent by that operation's own
 * calls.
 *
 * This is the single rule the rest of the file exists to keep: one external
 * operation reserves its worst case *before* it starts, the real HTTP and D1
 * boundaries spend from that reservation as the calls actually happen, and
 * whatever was not needed goes back at the end. While it is open, nothing the
 * operation does may be paid for from anywhere else.
 *
 * The unit is the operation, not the piece of work it belongs to. Reserving a
 * whole shopping row at once was too blunt for the list #308 is about: a text
 * row whose amount changed is a create that may take two calls and a delete
 * that takes one, and with two calls free the row was refused outright even
 * though the create would have used one and handed the other straight to the
 * delete. Each operation reserving its own worst case costs nothing in safety
 * — a create still takes its two atomically — and stops the arithmetic being
 * pessimistic about work it can see the shape of.
 *
 * Two things went wrong without it, and they are the same thing. The receipt
 * batch was charged once by the send and once again by the metered database,
 * so with exactly the reserved call left the batch was refused by our own
 * ledger. And an `add` was priced at one call on a guess about the service,
 * which let a row begin on a single free slot and stop between its `POST` and
 * its `PATCH` — a row on the list, still ticked, which is the state #236
 * exists to prevent.
 */
export class SubrequestReservation {
  #remaining: number;

  constructor(calls: number) {
    this.#remaining = calls;
  }

  get remaining(): number {
    return this.#remaining;
  }

  /** Internal: the budget draws a call down through this. */
  take(): boolean {
    if (this.#remaining <= 0) return false;
    this.#remaining -= 1;
    return true;
  }

  /** Internal: what is handed back when the operation ends. */
  surrender(): number {
    const left = this.#remaining;
    this.#remaining = 0;
    return left;
  }
}

export class SubrequestBudget {
  #left: number;
  /** Calls promised to reservations that are still open. */
  #held = 0;
  /** The reservation the meters are currently spending from, if any. */
  #active: SubrequestReservation | null = null;

  constructor(left: number) {
    this.#left = Math.max(0, Math.floor(left));
  }

  /** Everything still unspent, reservations included. */
  get left(): number {
    return this.#left;
  }

  /** What is not already promised to some open reservation. */
  get free(): number {
    return Math.max(0, this.#left - this.#held);
  }

  /** Whether work costing at most `calls` could be reserved right now. */
  canAfford(calls: number): boolean {
    return this.free >= calls;
  }

  /**
   * Set `calls` aside for one operation, or refuse.
   *
   * Refusing is the whole point: an operation that cannot be finished is never
   * begun, so nothing is left half-done.
   */
  reserve(calls: number): SubrequestReservation | null {
    const wanted = Math.max(0, Math.floor(calls));
    if (this.free < wanted) return null;
    this.#held += wanted;
    return new SubrequestReservation(wanted);
  }

  /** Hand back whatever the operation did not need. */
  release(reservation: SubrequestReservation): void {
    this.#held -= reservation.surrender();
    if (this.#active === reservation) this.#active = null;
  }

  /**
   * Run `work` with its calls spent from `reservation` rather than from the
   * free allowance, and give the remainder back when it ends.
   */
  async within<T>(
    reservation: SubrequestReservation,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#active;
    this.#active = reservation;
    try {
      return await work();
    } finally {
      this.#active = previous;
      this.release(reservation);
    }
  }

  /**
   * Take one call for something now happening.
   *
   * Called by the meters, never by the work itself. Inside an operation it
   * draws on that operation's reservation, so the same allowance is spent
   * exactly once; outside one it draws on what is free.
   */
  spend(): boolean {
    // Inside an operation the reservation is the whole of what may be spent.
    // Falling through to the free pool when the token ran out would make the
    // reservation an estimate again: a `reserve(1)` operation could make two
    // calls whenever the pool happened to have a spare, which is exactly the
    // drift reservations exist to remove.
    if (this.#active !== null) {
      if (!this.#active.take()) return false;
      this.#held -= 1;
      this.#left -= 1;
      return true;
    }
    if (this.free < 1) return false;
    this.#left -= 1;
    return true;
  }
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * The same transport, spending the ledger as it goes.
 *
 * This is the one place that knows what a subrequest is, which is why the
 * count cannot drift from the runtime's: whatever the caller believed it was
 * doing, a request that leaves here is one call and is charged as one. A
 * request that would go over does not leave at all.
 */
export function meteredFetch(budget: SubrequestBudget, fetcher: Fetcher): Fetcher {
  return (input, init) => {
    if (!budget.spend()) return Promise.reject(new SubrequestBudgetSpent());
    return fetcher(input, init);
  };
}

/**
 * The same database, spending the ledger as it goes.
 *
 * D1 statements come out of the same per-invocation allowance as `fetch`, so
 * leaving them to a hand-counted constant was the other half of the ledger
 * measuring a different unit from the runtime. The constant said six; the real
 * number moves — `shopping.ts::shoppingLinesFor` runs an extra batch when a
 * legacy product still needs its package size written down, and
 * `d1-query.ts::boundedInChunks` runs one statement per chunk when there are
 * enough ids to need more than one.
 *
 * Counted the way the runtime counts: one per statement executed, and one for
 * a whole `batch` however many statements it holds.
 *
 * A statement that would go over is refused here rather than by the runtime,
 * so nothing is half-done. `prepare` and `bind` cost nothing — they make no
 * request — which is why only the four executing methods are wrapped.
 */
const RAW = Symbol("unmetered statement");

export function meteredDatabase(budget: SubrequestBudget, db: D1Database): D1Database {
  // Rejected rather than thrown: every method this wraps is async, and a
  // caller awaiting one should not have to guard a synchronous throw as well.
  const spend = (run: () => unknown): unknown => {
    if (!budget.spend()) return Promise.reject(new SubrequestBudgetSpent());
    return run();
  };

  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const real = statement as unknown as Record<string, (...args: unknown[]) => unknown>;
    return new Proxy(statement, {
      get(_target, key: string | symbol) {
        // A batch is one subrequest for the whole set, so the statements
        // inside it are handed on unmetered: charging them again would count
        // work the runtime never separates.
        if (key === RAW) return statement;
        if (typeof key !== "string") return (real as Record<string, unknown>)[String(key)];
        if (key === "bind") {
          return (...args: unknown[]) => wrap(real["bind"]!(...args) as D1PreparedStatement);
        }
        if (key === "first" || key === "all" || key === "run" || key === "raw") {
          return (...args: unknown[]) => spend(() => real[key]!(...args));
        }
        return real[key];
      },
    });
  };

  const real = db as unknown as Record<string, (...args: unknown[]) => unknown>;
  return new Proxy(db, {
    get(_target, key: string) {
      if (key === "prepare") {
        return (text: string) => wrap(real["prepare"]!(text) as D1PreparedStatement);
      }
      if (key === "batch") {
        return (statements: D1PreparedStatement[]) =>
          spend(() =>
            real["batch"]!(
              statements.map((one) => {
                const inner = (one as unknown as Record<symbol, D1PreparedStatement>)[RAW];
                return inner ?? one;
              }),
            ),
          );
      }
      return real[key];
    },
  }) as D1Database;
}
