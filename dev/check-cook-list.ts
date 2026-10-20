/**
 * The dish to-do list that replaced the meal calendar (#345).
 *
 * These run the real list functions against the real migrations. What they
 * pin is the line between the list and the calendar's old batches, which
 * share one table: the list never shows or changes a dated batch, a ticked
 * dish leaves the list and enters the cooking history, and a stale action
 * never follows a reused id onto a different cooking (#255).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  cookHistory,
  everyoneCookHistory,
  resetCookHistory,
} from "../src/cook-history.ts";
import {
  addToCookList,
  changeMultiplier,
  CookListRefused,
  cookList,
  findListedDish,
  markCooked,
  removeFromCookList,
} from "../src/cook-list.ts";
import { addDays, today } from "../src/dates.ts";
import type { Member } from "../src/members.ts";
import { futurePlansElsewhere } from "../src/recipe-publish.ts";
import { migratedDatabase, type FakeD1 } from "./support/d1.ts";

const HOME: Member = {
  id: 1,
  householdId: 1,
  displayName: "Koti",
  email: "koti@example.com",
  isAdmin: false,
};

const NEIGHBOUR: Member = {
  id: 2,
  householdId: 2,
  displayName: "Naapuri",
  email: "naapuri@example.com",
  isAdmin: false,
};

function fixtures(fake: FakeD1): void {
  fake.sql.exec(`
    INSERT INTO household (id, name) VALUES (1, 'Koti'), (2, 'Naapuri');
    INSERT INTO member (id, household_id, google_sub, email, display_name)
      VALUES (1, 1, 'home', 'koti@example.com', 'Koti'),
             (2, 2, 'neighbour', 'naapuri@example.com', 'Naapuri');
    INSERT INTO recipe
      (id, household_id, title, yield_portions, source_text, source_route,
       created_by, updated_by)
      VALUES (1, 1, 'Kaalilaatikko', 4, 'Kaalia', 'pasted', 1, 1),
             (2, 2, 'Naapurin keitto', 4, 'Keittoa', 'pasted', 2, 2);
    INSERT INTO recipe
      (id, household_id, parent_id, title, source_text, source_route,
       created_by, updated_by)
      VALUES (3, 1, 1, 'Kastike', 'Kastiketta', 'pasted', 1, 1);
    INSERT INTO ingredient (id, name, created_by) VALUES (1, 'kaali', 1);
    INSERT INTO ingredient_line
      (recipe_id, position, quantity, unit, ingredient_id, source_line)
      VALUES (1, 1, 1, 'kpl', 1, '1 kaali'), (2, 1, 1, 'kpl', 1, '1 kaali');
    INSERT INTO recipe_step (recipe_id, position, text)
      VALUES (1, 1, 'Keitä.'), (2, 1, 'Keitä.');
  `);
}

/** A batch the old calendar planned, with one occurrence on `date`. */
function calendarBatch(fake: FakeD1, id: number, householdId: number, recipeId: number, date: string): void {
  fake.sql
    .prepare(
      `INSERT INTO planned_batch
         (id, household_id, recipe_id, multiplier, created_by, instance_key)
       VALUES (?, ?, ?, 1, ?, ?)`,
    )
    .run(id, householdId, recipeId, householdId, `calendar-${id}`);
  fake.sql
    .prepare("INSERT INTO batch_occurrence (batch_id, date, slot) VALUES (?, ?, 'dinner')")
    .run(id, date);
}

test("a dish goes on the list at its size, and a part or a stranger's dish does not", async () => {
  const fake = migratedDatabase();
  fixtures(fake);

  const listed = await addToCookList(fake.db, HOME, { recipeId: 1, multiplier: 1.5 });
  assert.deepEqual(
    (await cookList(fake.db, 1)).map(({ id, title, multiplier }) => ({ id, title, multiplier })),
    [{ id: listed.id, title: "Kaalilaatikko", multiplier: 1.5 }],
  );

  await assert.rejects(() => addToCookList(fake.db, HOME, { recipeId: 3, multiplier: 1 }), CookListRefused);
  await assert.rejects(() => addToCookList(fake.db, HOME, { recipeId: 2, multiplier: 1 }), CookListRefused);
  await assert.rejects(() => addToCookList(fake.db, HOME, { recipeId: 1, multiplier: 0 }), CookListRefused);
  assert.equal((await cookList(fake.db, 1)).length, 1);
  assert.equal((await cookList(fake.db, 2)).length, 0);
});

test("the calendar's old batches are neither shown nor changed by the list", async () => {
  const fake = migratedDatabase();
  fixtures(fake);
  calendarBatch(fake, 7, 1, 1, addDays(today(), 3));

  assert.deepEqual(await cookList(fake.db, 1), []);
  assert.equal(await findListedDish(fake.db, 1, 7), null);
  assert.equal(await changeMultiplier(fake.db, HOME, 7, "calendar-7", 2), false);
  assert.equal(await markCooked(fake.db, HOME, 7, "calendar-7"), false);
  assert.equal(await removeFromCookList(fake.db, HOME, 7, "calendar-7"), false);

  const row = fake.sql
    .prepare("SELECT multiplier, cooked_on FROM planned_batch WHERE id = 7")
    .get() as { multiplier: number; cooked_on: string | null };
  assert.deepEqual({ ...row }, { multiplier: 1, cooked_on: null });
});

test("ticking a dish takes it off the list and counts it as cooked today", async () => {
  const fake = migratedDatabase();
  fixtures(fake);
  // One old calendar cooking, already past, which the history kept counting.
  calendarBatch(fake, 7, 1, 1, addDays(today(), -10));
  const listed = await addToCookList(fake.db, HOME, { recipeId: 1, multiplier: 1 });

  // Still on the list: a plan, not a cooking.
  assert.deepEqual((await cookHistory(fake.db, 1)).get(1), {
    times: 1,
    lastCooked: addDays(today(), -10),
  });

  assert.equal(await markCooked(fake.db, HOME, listed.id, listed.instanceKey), true);
  assert.deepEqual(await cookList(fake.db, 1), []);
  assert.deepEqual((await cookHistory(fake.db, 1)).get(1), {
    times: 2,
    lastCooked: today(),
  });

  // Ticked once is cooked once.
  assert.equal(await markCooked(fake.db, HOME, listed.id, listed.instanceKey), false);
  assert.equal((await cookHistory(fake.db, 1)).get(1)?.times, 2);
});

test("starting the count over keeps every batch, and a later cooking counts (#366)", async () => {
  const fake = migratedDatabase();
  fixtures(fake);
  calendarBatch(fake, 7, 1, 1, addDays(today(), -10));
  // A calendar day still to come is a plan, not a cooking, and stays unmarked.
  calendarBatch(fake, 8, 1, 1, addDays(today(), 3));
  const cooked = await addToCookList(fake.db, HOME, { recipeId: 1, multiplier: 1 });
  await markCooked(fake.db, HOME, cooked.id, cooked.instanceKey);
  const listed = await addToCookList(fake.db, HOME, { recipeId: 1, multiplier: 1 });

  await resetCookHistory(fake.db, 1, 1);
  assert.equal((await cookHistory(fake.db, 1)).get(1), undefined);

  // Nothing is deleted: the calendar batch keeps its day.
  const kept = fake.sql
    .prepare(
      `SELECT planned_batch.id, count_reset, count(batch_occurrence.date) AS days
         FROM planned_batch
         LEFT JOIN batch_occurrence ON batch_occurrence.batch_id = planned_batch.id
        GROUP BY planned_batch.id ORDER BY planned_batch.id`,
    )
    .all() as { id: number; count_reset: number; days: number }[];
  assert.deepEqual(
    kept.map((row) => ({ ...row })),
    [
      { id: 7, count_reset: 1, days: 1 },
      { id: 8, count_reset: 0, days: 1 },
      { id: cooked.id, count_reset: 1, days: 0 },
      { id: listed.id, count_reset: 0, days: 0 },
    ],
  );

  // The dish that was still on the list counts once it is cooked.
  assert.equal(await markCooked(fake.db, HOME, listed.id, listed.instanceKey), true);
  assert.deepEqual((await cookHistory(fake.db, 1)).get(1), { times: 1, lastCooked: today() });
});

test("every household's cooking adds up, and only the others' sets their latest day (#368)", async () => {
  const fake = migratedDatabase();
  fixtures(fake);
  calendarBatch(fake, 7, 1, 2, addDays(today(), -2));
  calendarBatch(fake, 8, 2, 2, addDays(today(), -20));
  calendarBatch(fake, 9, 2, 2, addDays(today(), -5));
  // Still to come: a plan, and nobody's cooking yet.
  calendarBatch(fake, 10, 2, 2, addDays(today(), 3));
  // Our own dish, cooked only by us: no other household's day.
  calendarBatch(fake, 11, 1, 1, addDays(today(), -1));

  const seen = await everyoneCookHistory(fake.db, 1);
  assert.deepEqual(seen.get(2), { times: 3, othersLastCooked: addDays(today(), -5) });
  assert.deepEqual(seen.get(1), { times: 1, othersLastCooked: null });
  // The same cooking, read by the neighbour: our day is now the others' one.
  assert.deepEqual((await everyoneCookHistory(fake.db, 2)).get(2), {
    times: 3,
    othersLastCooked: addDays(today(), -2),
  });

  // A count started over is gone from the total too.
  await resetCookHistory(fake.db, 2, 2);
  assert.deepEqual((await everyoneCookHistory(fake.db, 1)).get(2), {
    times: 1,
    othersLastCooked: null,
  });
});

test("taking a dish off uncooked leaves nothing for the history", async () => {
  const fake = migratedDatabase();
  fixtures(fake);
  const listed = await addToCookList(fake.db, HOME, { recipeId: 1, multiplier: 1 });

  assert.equal(await removeFromCookList(fake.db, HOME, listed.id, listed.instanceKey), true);
  assert.deepEqual(await cookList(fake.db, 1), []);
  assert.equal((await cookHistory(fake.db, 1)).get(1), undefined);
});

test("a stale key, a reused id or another household changes nothing", async () => {
  const fake = migratedDatabase();
  fixtures(fake);
  const original = await addToCookList(fake.db, HOME, { recipeId: 1, multiplier: 1 });

  for (const member of [HOME, NEIGHBOUR]) {
    const key = member === HOME ? "not-the-key" : original.instanceKey;
    assert.equal(await changeMultiplier(fake.db, member, original.id, key, 2), false);
    assert.equal(await markCooked(fake.db, member, original.id, key), false);
    assert.equal(await removeFromCookList(fake.db, member, original.id, key), false);
  }
  assert.equal(await findListedDish(fake.db, 2, original.id), null);

  // The row is deleted and its id reused by a different cooking: the old
  // key must not follow the id onto it.
  await removeFromCookList(fake.db, HOME, original.id, original.instanceKey);
  fake.sql
    .prepare(
      `INSERT INTO planned_batch
         (id, household_id, recipe_id, multiplier, created_by, instance_key)
       VALUES (?, 1, 1, 1, 1, 'replacement')`,
    )
    .run(original.id);
  assert.equal(await markCooked(fake.db, HOME, original.id, original.instanceKey), false);
  assert.equal(await changeMultiplier(fake.db, HOME, original.id, original.instanceKey, 2), false);
  assert.equal((await findListedDish(fake.db, 1, original.id))?.instanceKey, "replacement");
});

test("a dish on another household's list stops its owner unsharing it, a cooked one does not", async () => {
  const fake = migratedDatabase();
  fixtures(fake);
  fake.sql.exec("UPDATE recipe SET published_at = datetime('now'), published_by = 2 WHERE id = 2");
  const listed = await addToCookList(fake.db, HOME, { recipeId: 2, multiplier: 1 });

  assert.equal(await futurePlansElsewhere(fake.db, 2, 2), 1);
  await markCooked(fake.db, HOME, listed.id, listed.instanceKey);
  assert.equal(await futurePlansElsewhere(fake.db, 2, 2), 0);

  // The calendar's rule still holds for its own batches: today or later counts.
  calendarBatch(fake, 20, 1, 2, today());
  assert.equal(await futurePlansElsewhere(fake.db, 2, 2), 1);
  fake.sql.exec("UPDATE batch_occurrence SET date = '2000-01-01' WHERE batch_id = 20");
  assert.equal(await futurePlansElsewhere(fake.db, 2, 2), 0);
});

test("the cooked day must be a date", () => {
  const fake = migratedDatabase();
  fixtures(fake);
  calendarBatch(fake, 7, 1, 1, today());
  assert.throws(
    () => fake.sql.exec("UPDATE planned_batch SET cooked_on = 'eilen' WHERE id = 7"),
    /CHECK constraint failed/,
  );
});
