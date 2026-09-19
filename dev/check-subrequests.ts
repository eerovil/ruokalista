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

test("the tail is held back from ordinary work and spent on its own", async () => {
  const budget = new SubrequestBudget(3, 1);
  assert.equal(budget.spendable, 2);
  assert.equal(budget.spend(2), true);
  assert.equal(budget.spendable, 0);
  // Ordinary work cannot touch what the finish needs.
  assert.equal(budget.spend(1), false);
  assert.equal(budget.spendTail(1), true);
  assert.equal(budget.left, 0);
});

test("approving is a gate, not a deduction", () => {
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
