/**
 * How many outgoing calls one Worker invocation has left, and who has claimed
 * them.
 *
 * Every `fetch` a Worker makes and every D1 statement it runs comes out of one
 * per-invocation allowance. On this deployment's plan that allowance is 50 and
 * `wrangler.jsonc` cannot raise it — `limits.subrequests` tops out at the
 * plan's own number. Exceeding it is not a slow failure or a degraded one: the
 * runtime refuses the call outright with `Too many subrequests by single
 * Worker invocation`, and whatever the code was in the middle of stops there.
 *
 * Issue #308 was that failure, and the first several attempts at it all did
 * the same thing in different places: start an operation, and deal with the
 * refusal if one came back. That answers the question too late. Five separate
 * guards grew out of it — one in the retry loop, one for the opening list
 * read, one for the receipt batch, one for the screen's re-render — and each
 * was correct about its own call and silent about the next one.
 *
 * This is the other way round. The work says what it is about to cost, the
 * ledger says whether that fits, and an operation that does not fit is not
 * begun. The runtime's refusal stays as a backstop for when this accounting
 * is wrong, which is what a backstop is for — not as the plan.
 *
 * ## Reserving
 *
 * Some of a send's calls are not optional. Writing down what was sent has to
 * happen or the next send re-derives it; pushing the phone's list does not,
 * because the service syncs on its own schedule anyway. So the mandatory tail
 * is reserved before the work starts and spent from the reservation at the
 * end, and the optional tail simply asks at the time and does without.
 */

/**
 * The per-invocation allowance this Worker actually has.
 *
 * Free plan. Raising it means a paid plan, not a config change — see
 * `limits.subrequests` in the Cloudflare docs, whose maximum on this plan is
 * this same number.
 */
export const SUBREQUEST_CEILING = 50;

export class SubrequestBudget {
  #left: number;
  #reserved = 0;

  constructor(left: number) {
    this.#left = Math.max(0, Math.floor(left));
  }

  /** What is left over once reservations are honoured. */
  get spendable(): number {
    return Math.max(0, this.#left - this.#reserved);
  }

  /** Everything still unspent, reserved or not. */
  get left(): number {
    return this.#left;
  }

  /** Set this many aside for work that must be able to happen later. */
  reserve(calls: number): void {
    this.#reserved += Math.max(0, calls);
  }

  /**
   * Take `calls` from the free part of the budget.
   *
   * False means "do not start": nothing is taken, and the caller has been told
   * before making the call rather than after being refused one.
   */
  claim(calls = 1): boolean {
    if (calls <= 0) return true;
    if (this.spendable < calls) return false;
    this.#left -= calls;
    return true;
  }

  /**
   * Take `calls` from what was set aside, and stop setting it aside.
   *
   * This is the tail spending its own reservation, so it does not compete with
   * the work that was going on while it waited.
   */
  claimReserved(calls = 1): boolean {
    if (calls <= 0) return true;
    if (this.#left < calls) return false;
    this.#left -= calls;
    this.#reserved = Math.max(0, this.#reserved - calls);
    return true;
  }

  /** Give back space that turned out not to be needed. */
  release(calls: number): void {
    this.#reserved = Math.max(0, this.#reserved - Math.max(0, calls));
  }
}
