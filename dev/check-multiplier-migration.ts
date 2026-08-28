/**
 * What `0013_recipe_multiplier.sql` does to data that already exists (#165).
 *
 * Every other check in `dev/` tests a function; this one tests a migration, by
 * building the pre-#165 schema out of the real migration files, putting rows in
 * it, and running 0013 over them. That is worth the machinery because the one
 * thing the issue is strict about — never inventing a multiplier for a row that
 * cannot be converted — is invisible in the code and only exists in the SQL.
 *
 * `node:sqlite` rather than D1: the migration is plain SQLite DDL, and running
 * it here costs nothing and needs no wrangler, no container port and no live
 * database. The one thing this cannot prove is that D1 accepts the statements,
 * which is what `npm run migrate:local` and the browser suite do.
 *
 *   ./scripts/node.sh npm run check
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const THIS_ONE = "0013_recipe_multiplier.sql";

/** The database as it stood the moment before #165, with rows worth converting. */
function beforeMigration(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");

  for (const file of readdirSync(MIGRATIONS).sort()) {
    if (file >= THIS_ONE) break;
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }

  db.exec(`
    INSERT INTO household (id, name) VALUES (1, 'Koti'), (2, 'Naapuri');
    INSERT INTO member (id, household_id, google_sub, email, display_name)
      VALUES (1, 1, 'a', 'a@example.com', 'A'), (2, 2, 'b', 'b@example.com', 'B');

    -- Yield 4: everything planned from it converts cleanly.
    INSERT INTO recipe (id, household_id, title, yield_portions, source_text,
                        source_route, created_by, updated_by)
      VALUES (1, 1, 'Kaalilaatikko', 4, 'x', 'pasted', 1, 1);
    -- No yield: nothing to convert from.
    INSERT INTO recipe (id, household_id, title, yield_portions, source_text,
                        source_route, created_by, updated_by)
      VALUES (2, 1, 'Uunikaali', NULL, 'x', 'pasted', 1, 1);
    INSERT INTO recipe (id, household_id, title, yield_portions, source_text,
                        source_route, created_by, updated_by)
      VALUES (3, 1, 'Kolmannes', 3, 'x', 'pasted', 1, 1);
    -- This old schema is not STRICT, so malformed restored data can exist even
    -- though the application would never have written it.
    INSERT INTO recipe (id, household_id, title, yield_portions, source_text,
                        source_route, created_by, updated_by)
      VALUES (4, 1, 'Rikki', '4x', 'x', 'pasted', 1, 1);

    INSERT INTO planned_batch (id, household_id, recipe_id, portions, created_by)
      VALUES (1, 1, 1, 6, 1),   -- 6/4 -> 1,5x
             (2, 1, 1, 4, 1),   -- 4/4 -> 1x
             (3, 1, 1, 8, 1),   -- 8/4 -> 2x
             (4, 1, 1, 2, 1),   -- 2/4 -> 0,5x
             (5, 1, 2, 6, 1),   -- no yield: cannot be converted
             (6, 1, 3, 1, 1),   -- 1/3 stays exact
             (7, 1, 4, 8, 1);   -- malformed yield: cannot be converted

    INSERT INTO batch_occurrence (batch_id, date, slot)
      VALUES (1, '2026-08-25', 'dinner'), (2, '2026-08-26', 'dinner'),
             (3, '2026-08-27', 'dinner'), (4, '2026-08-28', 'dinner'),
             (5, '2026-08-29', 'dinner'), (6, '2026-08-30', 'dinner'),
             (7, '2026-08-31', 'dinner');

    INSERT INTO recipe_preference (id, household_id, recipe_id, default_portions, updated_by)
      VALUES (1, 2, 1, 6, 2),   -- the neighbour's own default: 6/4 -> 1,5x
             (2, 1, 2, 8, 1),   -- no yield: was already doing nothing
             (3, 2, 3, 1, 2),   -- 1/3 stays exact
             (4, 2, 4, 8, 2);   -- malformed yield: cannot be converted
  `);
  return db;
}

/** `node:sqlite` hands back null-prototype rows, which no deepEqual likes. */
function plain<T extends object>(row: T): T {
  return { ...row };
}

function migrated(): DatabaseSync {
  const db = beforeMigration();
  db.exec(readFileSync(join(MIGRATIONS, THIS_ONE), "utf8"));
  return db;
}

test("an old batch becomes portions over yield", () => {
  const db = migrated();
  const rows = db
    .prepare("SELECT id, multiplier FROM planned_batch ORDER BY id")
    .all() as { id: number; multiplier: number }[];

  assert.deepEqual(rows.map(plain), [
    { id: 1, multiplier: 1.5 },
    { id: 2, multiplier: 1 },
    { id: 3, multiplier: 2 },
    { id: 4, multiplier: 0.5 },
    { id: 5, multiplier: 1 },
    { id: 6, multiplier: 1 / 3 },
    { id: 7, multiplier: 1 },
  ]);
});

test("a batch that cannot be converted keeps its number and is flagged", () => {
  const db = migrated();
  const row = db
    .prepare("SELECT multiplier, legacy_portions FROM planned_batch WHERE id = 5")
    .get() as { multiplier: number; legacy_portions: number | null };

  // 1x, and the six portions somebody typed are still on the row so the week
  // screen can say the conversion did not happen.
  assert.equal(row.multiplier, 1);
  assert.equal(row.legacy_portions, 6);
});

test("a converted batch carries no leftover portion count", () => {
  const db = migrated();
  const flagged = db
    .prepare("SELECT id FROM planned_batch WHERE legacy_portions IS NOT NULL")
    .all() as { id: number }[];

  assert.deepEqual(flagged.map(plain), [{ id: 5 }, { id: 7 }]);
});

test("the occurrences a batch owns survive the migration", () => {
  const db = migrated();
  const count = db
    .prepare("SELECT count(*) AS n FROM batch_occurrence")
    .get() as { n: number };

  assert.equal(count.n, 7);
});

test("a household's default converts, and stays that household's", () => {
  const db = migrated();
  const rows = db
    .prepare(
      "SELECT household_id, recipe_id, default_multiplier FROM recipe_preference ORDER BY id",
    )
    .all() as { household_id: number; recipe_id: number; default_multiplier: number }[];

  // Household 2's default for household 1's recipe, still household 2's.
  assert.deepEqual(rows.map(plain), [
    { household_id: 2, recipe_id: 1, default_multiplier: 1.5 },
    { household_id: 2, recipe_id: 3, default_multiplier: 1 / 3 },
  ]);
});

test("a preference with a missing or malformed yield is dropped, never guessed", () => {
  const db = migrated();
  const left = db
    .prepare("SELECT count(*) AS n FROM recipe_preference WHERE recipe_id IN (2, 4)")
    .get() as { n: number };

  assert.equal(left.n, 0);
});

test("the portion columns are gone and a multiplier must be positive", () => {
  const db = migrated();

  assert.throws(
    () => db.exec("SELECT portions FROM planned_batch"),
    /no such column/,
  );
  assert.throws(
    () => db.exec("SELECT default_portions FROM recipe_preference"),
    /no such column/,
  );
  assert.throws(
    () =>
      db.exec(
        "UPDATE planned_batch SET multiplier = 0 WHERE id = 1",
      ),
    /CHECK constraint failed/,
  );
});

test("the recipe's own yield is left exactly where it was", () => {
  const db = migrated();
  const rows = db
    .prepare("SELECT id, yield_portions FROM recipe ORDER BY id")
    .all() as { id: number; yield_portions: number | string | null }[];

  assert.deepEqual(rows.map(plain), [
    { id: 1, yield_portions: 4 },
    { id: 2, yield_portions: null },
    { id: 3, yield_portions: 3 },
    { id: 4, yield_portions: "4x" },
  ]);
});
