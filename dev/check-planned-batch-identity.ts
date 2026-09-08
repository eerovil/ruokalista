/**
 * A deleted SQLite rowid may be reused, but a stale batch action must never
 * follow that id onto a different cooking (#255).
 *
 * These checks run the real menu functions against the real migrations. The
 * `beforeBatch` hook places deletion/recreation precisely after the ownership
 * read and before occurrence replacement's transaction.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { addDays, today } from "../src/dates.ts";
import {
  addPlannedBatch,
  changeMultiplier,
  changeRecipe,
  MenuRefused,
  removePlannedBatch,
  replaceOccurrences,
  type PlannedBatchIdentity,
} from "../src/menu.ts";
import type { Member } from "../src/members.ts";
import { migratedDatabase, type FakeD1 } from "./support/d1.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const INSTANCE_MIGRATION = "0024_planned_batch_instance_key.sql";

const HOME: Member = {
  id: 1,
  householdId: 1,
  displayName: "Koti",
  email: "koti@example.com",
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
  `);
}

async function ownBatch(
  fake: FakeD1,
  date: string,
  recipeId = 1,
): Promise<PlannedBatchIdentity> {
  return addPlannedBatch(fake.db, HOME, {
    date,
    slot: "dinner",
    recipeId,
    multiplier: 1,
  });
}

function replaceRow(
  fake: FakeD1,
  id: number,
  householdId: number,
  recipeId: number,
  instanceKey: string,
  date: string,
): void {
  fake.sql.prepare("DELETE FROM planned_batch WHERE id = ?").run(id);
  fake.sql
    .prepare(
      `INSERT INTO planned_batch
         (id, household_id, recipe_id, multiplier, created_by, instance_key)
       VALUES (?, ?, ?, 1, ?, ?)`,
    )
    .run(id, householdId, recipeId, householdId, instanceKey);
  fake.sql
    .prepare("INSERT INTO batch_occurrence (batch_id, date, slot) VALUES (?, ?, 'lunch')")
    .run(id, date);
}

function occurrences(fake: FakeD1, id: number): Array<{ date: string; slot: string }> {
  return fake.sql
    .prepare("SELECT date, slot FROM batch_occurrence WHERE batch_id = ? ORDER BY date, slot")
    .all(id)
    .map((row) => ({ ...row })) as Array<{ date: string; slot: string }>;
}

test("past, future and mixed replacement cannot cross an id reuse boundary", async () => {
  const dates = [
    [addDays(today(), -2), addDays(today(), -1)],
    [today(), addDays(today(), 1)],
    [addDays(today(), -1), today()],
  ];

  for (const [first, second] of dates) {
    const fake = migratedDatabase();
    fixtures(fake);
    const original = await ownBatch(fake, first!);
    const neighbourDate = addDays(today(), 10);

    fake.beforeBatch(() => {
      replaceRow(fake, original.id, 2, 2, `neighbour-${first}`, neighbourDate);
    });

    const changed = await replaceOccurrences(
      fake.db,
      HOME,
      original.id,
      original.instanceKey,
      [
        { date: first!, slot: "dinner" },
        { date: second!, slot: "lunch" },
      ],
    );

    assert.equal(changed, false);
    assert.deepEqual(occurrences(fake, original.id), [
      { date: neighbourDate, slot: "lunch" },
    ]);
    const owner = fake.sql
      .prepare("SELECT household_id FROM planned_batch WHERE id = ?")
      .get(original.id) as { household_id: number };
    assert.equal(owner.household_id, 2);
  }
});

test("concurrent deletion is a controlled not-found with no partial replacement", async () => {
  const fake = migratedDatabase();
  fixtures(fake);
  const original = await ownBatch(fake, addDays(today(), -2));
  fake.beforeBatch(() => {
    fake.sql.prepare("DELETE FROM planned_batch WHERE id = ?").run(original.id);
  });

  const changed = await replaceOccurrences(
    fake.db,
    HOME,
    original.id,
    original.instanceKey,
    [{ date: addDays(today(), -1), slot: "dinner" }],
  );

  assert.equal(changed, false);
  assert.deepEqual(occurrences(fake, original.id), []);
});

test("a same-household replacement ignores every stale mutation", async () => {
  const fake = migratedDatabase();
  fixtures(fake);
  const original = await ownBatch(fake, addDays(today(), -2));
  const replacementKey = "same-household-replacement";
  const replacementDate = addDays(today(), 5);
  replaceRow(fake, original.id, 1, 1, replacementKey, replacementDate);

  assert.equal(
    await changeMultiplier(fake.db, HOME, original.id, original.instanceKey, 2),
    false,
  );
  assert.equal(
    await changeRecipe(fake.db, HOME, original.id, original.instanceKey, 1),
    false,
  );
  assert.equal(
    await replaceOccurrences(fake.db, HOME, original.id, original.instanceKey, [
      { date: addDays(today(), -1), slot: "dinner" },
    ]),
    false,
  );
  assert.equal(
    await removePlannedBatch(fake.db, HOME, original.id, original.instanceKey),
    false,
  );

  const replacement = fake.sql
    .prepare("SELECT instance_key, multiplier FROM planned_batch WHERE id = ?")
    .get(original.id) as { instance_key: string; multiplier: number };
  assert.deepEqual({ ...replacement }, { instance_key: replacementKey, multiplier: 1 });
  assert.deepEqual(occurrences(fake, original.id), [
    { date: replacementDate, slot: "lunch" },
  ]);
});

test("historical coverage stays editable after shared recipe access ends", async () => {
  const fake = migratedDatabase();
  fixtures(fake);
  fake.sql.exec(
    "INSERT INTO recipe_share (recipe_id, household_id, shared_by) VALUES (2, 1, 2)",
  );
  const original = await ownBatch(fake, addDays(today(), -3), 2);
  fake.sql.exec("DELETE FROM recipe_share WHERE recipe_id = 2 AND household_id = 1");

  assert.equal(
    await replaceOccurrences(fake.db, HOME, original.id, original.instanceKey, [
      { date: addDays(today(), -2), slot: "lunch" },
      { date: addDays(today(), -1), slot: "dinner" },
    ]),
    true,
  );
});

test("access lost just before a future replacement rolls the whole write back", async () => {
  const fake = migratedDatabase();
  fixtures(fake);
  fake.sql.exec(
    "INSERT INTO recipe_share (recipe_id, household_id, shared_by) VALUES (2, 1, 2)",
  );
  const original = await ownBatch(fake, today(), 2);
  const before = occurrences(fake, original.id);
  fake.beforeBatch(() => {
    fake.sql.exec("DELETE FROM recipe_share WHERE recipe_id = 2 AND household_id = 1");
  });

  await assert.rejects(
    () =>
      replaceOccurrences(fake.db, HOME, original.id, original.instanceKey, [
        { date: addDays(today(), 1), slot: "lunch" },
      ]),
    MenuRefused,
  );
  assert.deepEqual(occurrences(fake, original.id), before);
});

test("the additive migration preserves rows and enforces immutable unique keys", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of [
    "0001_init.sql",
    "0002_parts.sql",
    "0003_recipe_revision.sql",
    "0004_semantic_phases.sql",
  ]) {
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  db.exec(`
    INSERT INTO household (id, name) VALUES (1, 'Koti');
    INSERT INTO member (id, household_id, google_sub, display_name)
      VALUES (1, 1, 'home', 'Koti');
    INSERT INTO recipe
      (id, household_id, title, source_text, source_route, created_by, updated_by)
      VALUES (1, 1, 'Kaalilaatikko', 'Kaalia', 'pasted', 1, 1);
    INSERT INTO meal_entry
      (id, household_id, date, slot, recipe_id, portions, created_by)
      VALUES (7, 1, '2026-01-01', 'dinner', 1, 4, 1);
  `);
  db.exec(readFileSync(join(MIGRATIONS, "0005_planned_batches.sql"), "utf8"));
  db.exec(readFileSync(join(MIGRATIONS, INSTANCE_MIGRATION), "utf8"));

  const migrated = db
    .prepare(
      `SELECT planned_batch.id, planned_batch.instance_key, batch_occurrence.date
         FROM planned_batch
         JOIN batch_occurrence ON batch_occurrence.batch_id = planned_batch.id`,
    )
    .get() as { id: number; instance_key: string; date: string };
  assert.equal(migrated.id, 7);
  assert.match(migrated.instance_key, /^[0-9a-f]{32}$/);
  assert.equal(migrated.date, "2026-01-01");

  assert.throws(
    () =>
      db.exec(
        "INSERT INTO planned_batch (household_id, recipe_id, portions, created_by) VALUES (1, 1, 4, 1)",
      ),
    /instance_key is required/,
  );
  assert.throws(
    () => db.prepare("UPDATE planned_batch SET instance_key = 'new' WHERE id = 7").run(),
    /instance_key is immutable/,
  );
  assert.throws(
    () =>
      db.prepare(
        `INSERT INTO planned_batch
           (household_id, recipe_id, portions, created_by, instance_key)
         VALUES (1, 1, 4, 1, ?)`,
      ).run(migrated.instance_key),
    /UNIQUE constraint failed/,
  );
});
