import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

/**
 * The one-EAN-per-ingredient mapping #147 made, carried across #161's schema
 * change without losing anything.
 *
 * This runs the repository's own migration files against a real SQLite in
 * memory, in the order Wrangler applies them and with foreign keys on the way
 * D1 has them, so it is the migration that is tested rather than a hand-written
 * restatement of it. It is the cheap half of the drill; the restore round-trip
 * (`scripts/check-restore-roundtrip.ts`) is the expensive half that proves the
 * same rows survive a backup.
 */

const MIGRATIONS = readdirSync("migrations")
  .filter((name) => name.endsWith(".sql"))
  .sort();

const UNDER_TEST = "0013_ingredient_products.sql";

function applyThrough(db: DatabaseSync, last: string): void {
  for (const name of MIGRATIONS) {
    db.exec(readFileSync(`migrations/${name}`, "utf8"));
    if (name === last) return;
  }
  throw new Error(`migration not found: ${last}`);
}

/** A household with one mapped ingredient, exactly as #147 left it. */
function seeded(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyThrough(db, "0012_s_ostoslista_products.sql");

  db.exec(`
    INSERT INTO household (id, name) VALUES (1, 'Koti');
    INSERT INTO member (id, household_id, google_sub, display_name)
      VALUES (1, 1, 'sub-1', 'Eero');
    INSERT INTO ingredient (id, name, created_by) VALUES
      (1, 'jauheliha', 1),
      (2, 'öljy', 1),
      (3, 'suola', 1);
    INSERT INTO recipe (id, household_id, title, source_text, source_route,
                        structured_by, created_by, updated_by)
      VALUES (1, 1, 'Lasagne', 'Lasagne', 'pasted', 'test', 1, 1);
    UPDATE ingredient
       SET ean = '6410405082657',
           external_product_name = 'Atria naudan jauheliha 400 g',
           external_product_image_url = 'https://cdn.s-cloud.fi/jauheliha.jpg'
     WHERE id = 1;
    -- An ingredient somebody half-mapped and gave up on: the empty string must
    -- not become a product with no EAN.
    UPDATE ingredient SET ean = '' WHERE id = 2;
  `);
  return db;
}

function rows(db: DatabaseSync, sql: string): Array<Record<string, unknown>> {
  return db.prepare(sql).all() as Array<Record<string, unknown>>;
}

test("an existing mapping becomes the ingredient's first product", () => {
  const db = seeded();
  db.exec(readFileSync(`migrations/${UNDER_TEST}`, "utf8"));

  const products = rows(db, "SELECT * FROM ingredient_product");
  assert.equal(products.length, 1);
  assert.equal(products[0]!["ingredient_id"], 1);
  assert.equal(products[0]!["ean"], "6410405082657");
  assert.equal(products[0]!["name"], "Atria naudan jauheliha 400 g");
  assert.equal(products[0]!["image_url"], "https://cdn.s-cloud.fi/jauheliha.jpg");
  assert.equal(products[0]!["position"], 1);
  // SQLite cannot read `400 g` out of a name; the app fills this the first
  // time it sees the row, and until then it is honestly empty.
  assert.equal(products[0]!["package_quantity"], null);
  db.close();
});

test("an ingredient that was never mapped gets no product", () => {
  const db = seeded();
  db.exec(readFileSync(`migrations/${UNDER_TEST}`, "utf8"));

  assert.deepEqual(
    rows(db, "SELECT ingredient_id FROM ingredient_product ORDER BY ingredient_id")
      .map((row) => row["ingredient_id"]),
    [1],
  );
  db.close();
});

test("the ingredient row keeps its name and loses only the product columns", () => {
  const db = seeded();
  db.exec(readFileSync(`migrations/${UNDER_TEST}`, "utf8"));

  const columns = rows(db, "PRAGMA table_info(ingredient)").map((row) => row["name"]);
  assert.deepEqual(columns.includes("name"), true);
  for (const gone of ["ean", "external_product_name", "external_product_image_url"]) {
    assert.equal(columns.includes(gone), false, `${gone} should be gone`);
  }
  assert.equal(rows(db, "SELECT count(*) AS n FROM ingredient")[0]!["n"], 3);
  db.close();
});

test("a product cannot outlive the ingredient it stands for", () => {
  const db = seeded();
  db.exec(readFileSync(`migrations/${UNDER_TEST}`, "utf8"));

  db.exec("DELETE FROM ingredient WHERE id = 1");
  assert.equal(rows(db, "SELECT count(*) AS n FROM ingredient_product")[0]!["n"], 0);
  db.close();
});

test("one ingredient may hold several package sizes but not the same one twice", () => {
  const db = seeded();
  db.exec(readFileSync(`migrations/${UNDER_TEST}`, "utf8"));

  db.exec(`
    INSERT INTO ingredient_product
      (ingredient_id, ean, name, package_quantity, package_unit, position)
    VALUES (1, '6410405082664', 'Atria naudan jauheliha 700 g', 700, 'g', 2)
  `);
  assert.equal(rows(db, "SELECT count(*) AS n FROM ingredient_product")[0]!["n"], 2);

  assert.throws(
    () =>
      db.exec(`
        INSERT INTO ingredient_product (ingredient_id, ean, name)
        VALUES (1, '6410405082664', 'Sama tuote uudestaan')
      `),
    /UNIQUE/,
  );
  db.close();
});

test("a recipe may pin one ingredient once, per household", () => {
  const db = seeded();
  db.exec(readFileSync(`migrations/${UNDER_TEST}`, "utf8"));

  db.exec(`
    INSERT INTO recipe_ingredient_product
      (household_id, recipe_id, ingredient_id, ean, name, package_quantity, package_unit)
    VALUES (1, 1, 1, '6410405082664', 'Atria naudan jauheliha 700 g', 700, 'g')
  `);
  assert.throws(
    () =>
      db.exec(`
        INSERT INTO recipe_ingredient_product
          (household_id, recipe_id, ingredient_id, ean, name)
        VALUES (1, 1, 1, '6410405082657', 'Toinen tuote')
      `),
    /UNIQUE/,
  );

  // And it goes with the recipe rather than hanging on after it.
  db.exec("DELETE FROM recipe WHERE id = 1");
  assert.equal(
    rows(db, "SELECT count(*) AS n FROM recipe_ingredient_product")[0]!["n"],
    0,
  );
  db.close();
});
