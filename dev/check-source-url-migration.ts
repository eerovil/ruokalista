/**
 * What `0016_recipe_source_url.sql` does to recipes that already exist (#192).
 *
 * The migration swaps a column that carries a CHECK constraint on the most
 * referenced table in the schema, which is the operation
 * docs/codebase/data-model.md warns can go wrong quietly. What is worth proving
 * is that no existing row loses its route, that the new word is accepted and a
 * fourth one still is not, and that the children hanging off `recipe` are all
 * still there afterwards.
 *
 * `node:sqlite` rather than D1, for the same reason as
 * `dev/check-multiplier-migration.ts`: the migration is plain SQLite DDL, and
 * running it here costs nothing. What it cannot prove is that D1 accepts the
 * statements — `npm run migrate:local` and the browser suite do that.
 *
 *   ./scripts/node.sh npm run check
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const THIS_ONE = "0016_recipe_source_url.sql";

function migrationsUpTo(db: DatabaseSync, last: string): void {
  for (const file of readdirSync(MIGRATIONS).sort()) {
    if (file > last) break;
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
}

/** The database as it stood the moment before #192, with recipes in it. */
function beforeMigration(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");

  for (const file of readdirSync(MIGRATIONS).sort()) {
    if (file >= THIS_ONE) break;
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }

  db.exec(`
    INSERT INTO household (id, name) VALUES (1, 'Koti');
    INSERT INTO member (id, household_id, google_sub, email, display_name)
      VALUES (1, 1, 'a', 'a@example.com', 'A');
    INSERT INTO ingredient (id, name, created_by) VALUES (1, 'sipuli', 1);

    INSERT INTO recipe (id, household_id, title, yield_portions, source_text,
                        source_route, created_by, updated_by)
      VALUES (1, 1, 'Kaalilaatikko', 4, 'liitetty', 'pasted', 1, 1),
             (2, 1, 'Uunikaali', NULL, 'kuvattu', 'photographed', 1, 1);

    -- A part, so the parent_id self-reference is exercised by the swap too.
    INSERT INTO recipe (id, household_id, title, source_text, source_route,
                        created_by, updated_by, parent_id, part_position)
      VALUES (3, 1, 'Kastike', 'liitetty', 'pasted', 1, 1, 1, 1);

    INSERT INTO recipe_step (recipe_id, position, text)
      VALUES (1, 1, 'Kuori sipuli.');
    INSERT INTO ingredient_line (id, recipe_id, position, ingredient_id, source_line)
      VALUES (1, 1, 1, 1, '1 sipuli');
    INSERT INTO planned_batch (id, household_id, recipe_id, created_by)
      VALUES (1, 1, 1, 1);
  `);

  return db;
}

/** `node:sqlite` hands back null-prototype rows; deepEqual wants plain ones. */
function plain(row: unknown): Record<string, unknown> {
  return { ...(row as Record<string, unknown>) };
}

function routes(db: DatabaseSync): Array<Record<string, unknown>> {
  return (
    db
      .prepare("SELECT id, source_route, source_url FROM recipe ORDER BY id")
      .all() as unknown[]
  ).map(plain);
}

function migrated(): DatabaseSync {
  const db = beforeMigration();
  db.exec(readFileSync(join(MIGRATIONS, THIS_ONE), "utf8"));
  return db;
}

test("every existing recipe keeps the route it arrived by", () => {
  assert.deepEqual(routes(migrated()), [
    { id: 1, source_route: "pasted", source_url: null },
    { id: 2, source_route: "photographed", source_url: null },
    { id: 3, source_route: "pasted", source_url: null },
  ]);
});

test("nothing hanging off a recipe is lost in the column swap", () => {
  const db = migrated();
  const counts = db
    .prepare(
      `SELECT (SELECT count(*) FROM recipe_step) AS steps,
              (SELECT count(*) FROM ingredient_line) AS lines,
              (SELECT count(*) FROM planned_batch) AS batches,
              (SELECT count(*) FROM recipe WHERE parent_id = 1) AS parts`,
    )
    .get();

  assert.deepEqual(plain(counts), { steps: 1, lines: 1, batches: 1, parts: 1 });
});

test("a linked recipe may be written, and an invented route may not", () => {
  const db = migrated();
  db.exec(`
    INSERT INTO recipe (id, household_id, title, source_text, source_route,
                        source_url, created_by, updated_by)
      VALUES (4, 1, 'Netistä', 'teksti', 'linked',
              'https://esimerkki.fi/resepti', 1, 1);
  `);

  const row = db
    .prepare("SELECT source_route, source_url FROM recipe WHERE id = 4")
    .get();
  assert.deepEqual(plain(row), {
    source_route: "linked",
    source_url: "https://esimerkki.fi/resepti",
  });

  assert.throws(() =>
    db.exec(`
      INSERT INTO recipe (id, household_id, title, source_text, source_route,
                          created_by, updated_by)
        VALUES (5, 1, 'Keksitty', 'teksti', 'scraped', 1, 1);
    `),
  );
});

test("a recipe still cannot be written with no route at all", () => {
  const db = migrated();
  assert.throws(() =>
    db.exec(`
      INSERT INTO recipe (id, household_id, title, source_text, source_route,
                          created_by, updated_by)
        VALUES (6, 1, 'Tyhjä', 'teksti', NULL, 1, 1);
    `),
  );
});

test("the swap leaves no trace of the column it replaced", () => {
  const db = migrated();
  const columns = (
    db.prepare("PRAGMA table_info(recipe)").all() as Array<Record<string, unknown>>
  ).map((column) => column["name"]);

  assert.ok(columns.includes("source_route"), "source_route is still there");
  assert.ok(columns.includes("source_url"), "source_url was added");
  assert.ok(
    !columns.includes("source_route_next"),
    "the working column was renamed away",
  );
});

test("the whole migration set applies in order on an empty database", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrationsUpTo(db, "9999");
  assert.equal(
    (db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length,
    0,
  );
});
