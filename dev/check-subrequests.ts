import assert from "node:assert/strict";
import test from "node:test";

import {
  SubrequestBudget,
  SubrequestBudgetSpent,
  meteredDatabase,
  meteredFetch,
} from "../src/subrequests.ts";
import { migratedDatabase } from "./support/d1.ts";

/**
 * The ledger itself: does it count what the runtime counts?
 *
 * Everything else in #308 rests on this. A ledger that measures a different
 * unit from Cloudflare is worse than none, because it reads like a guarantee.
 */

test("a statement and a batch each cost one, and prepare costs nothing", async () => {
  const fake = migratedDatabase();
  const budget = new SubrequestBudget(10);
  const db = meteredDatabase(budget, fake.db);

  // Building a statement makes no request, so it must not be charged for one.
  const statement = db.prepare("SELECT 1 AS n").bind();
  assert.equal(budget.left, 10);

  await statement.all();
  assert.equal(budget.left, 9);

  // One for the whole batch, however many statements are inside it.
  await db.batch([
    db.prepare("SELECT 1"),
    db.prepare("SELECT 2"),
    db.prepare("SELECT 3"),
  ]);
  assert.equal(budget.left, 8);
});

test("a statement that would go over is refused rather than run", async () => {
  const fake = migratedDatabase();
  const budget = new SubrequestBudget(1);
  const db = meteredDatabase(budget, fake.db);

  await db.prepare("SELECT 1").all();
  assert.equal(budget.left, 0);
  await assert.rejects(
    () => db.prepare("SELECT 1").all(),
    (error: unknown) => error instanceof SubrequestBudgetSpent,
  );
});

test("a reservation is held back from ordinary work and spent from itself", async () => {
  const budget = new SubrequestBudget(3);
  const tail = budget.reserve(1)!;
  assert.notEqual(tail, null);
  assert.equal(budget.free, 2);

  // Ordinary work can have what is free and no more, whatever is left in total.
  assert.equal(budget.spend(), true);
  assert.equal(budget.spend(), true);
  assert.equal(budget.free, 0);
  assert.equal(budget.left, 1, "the reservation is still unspent");
  assert.equal(budget.spend(), false, "ordinary work cannot touch it");

  // The work the reservation was made for spends it, once.
  await budget.within(tail, async () => {
    assert.equal(budget.spend(), true);
  });
  assert.equal(budget.left, 0);
});

test("a reservation hands back what it did not use", async () => {
  const budget = new SubrequestBudget(4);
  const hold = budget.reserve(2)!;
  assert.equal(budget.free, 2);

  await budget.within(hold, async () => {
    assert.equal(budget.spend(), true);
  });

  // One of the two was used; the other is free again, not lost and not spent.
  assert.equal(budget.left, 3);
  assert.equal(budget.free, 3);
});

test("a reservation that does not fit is refused rather than shrunk", () => {
  const budget = new SubrequestBudget(3);
  assert.equal(budget.reserve(4), null);
  assert.equal(budget.free, 3, "a refusal promises nothing");
  assert.notEqual(budget.reserve(3), null);
  assert.equal(budget.free, 0);
});

test("reserving is a gate, not a deduction", () => {
  const budget = new SubrequestBudget(5);
  assert.equal(budget.canAfford(5), true);
  assert.equal(budget.left, 5, "asking does not spend");
  assert.equal(budget.canAfford(6), false);
});

test("a fetch that would go over never leaves", async () => {
  const budget = new SubrequestBudget(1);
  let made = 0;
  const fetcher = meteredFetch(budget, async () => {
    made += 1;
    return new Response("ok");
  });

  await fetcher("https://example.invalid/");
  assert.equal(made, 1);
  await assert.rejects(
    () => fetcher("https://example.invalid/"),
    (error: unknown) => error instanceof SubrequestBudgetSpent,
  );
  assert.equal(made, 1, "the second request was never made");
});

test("an active reservation is a ceiling, not a floor (#308 review)", async () => {
  // The hole this closes: `spend()` used to fall through to the free pool when
  // the token ran out, so a `reserve(1)` operation could make two calls
  // whenever the pool happened to have a spare. A reservation that can be
  // exceeded is an estimate, and estimates are what the last several rounds
  // were about.
  const budget = new SubrequestBudget(5);
  const hold = budget.reserve(1)!;
  assert.equal(budget.free, 4, "the pool still has room, which is the point");

  await budget.within(hold, async () => {
    assert.equal(budget.spend(), true, "the call this operation reserved");
    assert.equal(budget.spend(), false, "and not one more, pool or no pool");
    assert.equal(budget.spend(), false);
  });

  // Exactly one call spent, and the pool is untouched by the refusals.
  assert.equal(budget.left, 4);
  assert.equal(budget.free, 4);
});

test("one operation's reservation cannot be spent by the next (#308 review)", async () => {
  const budget = new SubrequestBudget(3);
  const tail = budget.reserve(1)!;
  const step = budget.reserve(2)!;

  await budget.within(step, async () => {
    assert.equal(budget.spend(), true);
    assert.equal(budget.spend(), true);
    // Two were reserved and two are gone. The tail is not this step's to take.
    assert.equal(budget.spend(), false);
  });

  assert.equal(budget.left, 1, "the tail survived the step that ran beside it");
  await budget.within(tail, async () => {
    assert.equal(budget.spend(), true);
  });
  assert.equal(budget.left, 0);
});
