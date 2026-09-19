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

export class SubrequestBudget {
  #left: number;
  #tail: number;

  constructor(left: number, tail = 0) {
    this.#left = Math.max(0, Math.floor(left));
    this.#tail = Math.max(0, Math.floor(tail));
  }

  /** Everything still unspent, the tail included. */
  get left(): number {
    return this.#left;
  }

  /** What ordinary work may still have, leaving the tail alone. */
  get spendable(): number {
    return Math.max(0, this.#left - this.#tail);
  }

  /**
   * Whether a piece of work costing at most `calls` may start.
   *
   * A gate, not a deduction: the spending happens call by call as the work
   * actually makes them. Asking for the worst case here is what stops a row
   * beginning something it cannot finish.
   */
  canAfford(calls: number): boolean {
    return this.spendable >= calls;
  }

  /** Take `calls` for work now happening. False means it must not. */
  spend(calls = 1): boolean {
    if (calls <= 0) return true;
    if (this.spendable < calls) return false;
    this.#left -= calls;
    return true;
  }

  /**
   * Take `calls` from the part held back for the mandatory finish.
   *
   * It does not compete with the row work that was going on while it waited,
   * which is the whole reason for holding it back.
   */
  spendTail(calls = 1): boolean {
    if (calls <= 0) return true;
    if (this.#left < calls || this.#tail < calls) return false;
    this.#left -= calls;
    this.#tail -= calls;
    return true;
  }

  /** The tail turned out not to be needed; let ordinary work have it. */
  releaseTail(): void {
    this.#tail = 0;
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
    if (!budget.spend(1)) return Promise.reject(new SubrequestBudgetSpent());
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
    if (!budget.spend(1)) return Promise.reject(new SubrequestBudgetSpent());
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
