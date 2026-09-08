import assert from "node:assert/strict";
import test from "node:test";

import type { Env } from "../src/env.ts";
import { BACKUP_TABLES, canonicalJson, type BackupSnapshotUnsigned } from "../src/backup.ts";
import { assertRestoredRows, finalizeSnapshot, generateRestoreSql, parseAndValidateSnapshot } from "../src/restore.ts";
import { apiDeleteRecipe, deleteRecipeForm } from "../src/recipe-editor.ts";
import type { RouteContext } from "../src/router.ts";
import {
  cleanupDeletedRecipeImages,
  deleteRecipeWithImages,
  IMAGE_CLEANUP_LIMIT,
} from "../src/recipe-deletion.ts";
import { migratedDatabase } from "./support/d1.ts";

/** Real save-boundary SQL and migrations, with faults only at the R2 boundary. */
function fixture() {
  const database = migratedDatabase();
  const { sql } = database;
  sql.exec(`
    INSERT INTO household (id, name) VALUES (1, 'Koti'), (2, 'Naapuri');
    INSERT INTO member (id, household_id, google_sub, display_name)
      VALUES (1, 1, 'one', 'One'), (2, 2, 'two', 'Two');
    INSERT INTO recipe
      (id, household_id, title, source_text, source_route, created_by, updated_by,
       parent_id, image_key)
      VALUES
        (10, 1, 'Dish', '', 'pasted', 1, 1, NULL, 'recipes/1/10/dish.png'),
        (11, 1, 'Part', '', 'pasted', 1, 1, 10, 'recipes/1/11/part.png'),
        (20, 2, 'Other', '', 'pasted', 2, 2, NULL, 'recipes/2/20/other.png');
  `);
  const objects = new Set([
    'recipes/1/10/dish.png', 'recipes/1/11/part.png', 'recipes/2/20/other.png',
  ]);
  const deletes: string[] = [];
  const failures = new Set<string>();
  const env = {
    DB: database.db,
    RECIPE_IMAGES: {
      delete: async (key: string) => {
        deletes.push(key);
        assert.equal(count("SELECT count(*) AS n FROM recipe WHERE image_key = ?", key), 0,
          "R2 must never delete a referenced image");
        if (failures.has(key)) throw new Error("R2 temporarily unavailable");
        objects.delete(key); // Missing objects are already successfully cleaned up.
      },
    },
  } as unknown as Env;
  function count(query: string, ...values: (number | string)[]): number {
    return (sql.prepare(query).get(...values) as { n: number }).n;
  }
  function pending(): string[] {
    return (sql.prepare("SELECT image_key FROM recipe_image_cleanup ORDER BY image_key")
      .all() as { image_key: string }[]).map((row) => row.image_key);
  }
  return { database, sql, objects, deletes, failures, env, count, pending };
}

for (const target of [10, 11]) {
  test(`deleting recipe ${target} commits before deleting exactly its image objects`, async () => {
    const f = fixture();
    try {
      assert.equal(await deleteRecipeWithImages(f.env, 1, target), true);
      assert.equal(f.count("SELECT count(*) AS n FROM recipe WHERE id = ?", target), 0);
      assert.deepEqual(f.deletes.sort(), target === 10
        ? ['recipes/1/10/dish.png', 'recipes/1/11/part.png']
        : ['recipes/1/11/part.png']);
      assert.ok(f.objects.has('recipes/2/20/other.png'));
      assert.deepEqual(f.pending(), []);
    } finally { f.sql.close(); }
  });
}

test("an image-less recipe needs no storage operation", async () => {
  const f = fixture();
  try {
    f.sql.exec("UPDATE recipe SET image_key = NULL WHERE household_id = 1");
    assert.equal(await deleteRecipeWithImages(f.env, 1, 10), true);
    assert.deepEqual(f.deletes, []);
  } finally { f.sql.close(); }
});

for (const reason of ["foreign", "missing", "published", "shared"] as const) {
  test(`${reason} recipes do not acquire a delete token, queue work or lose bytes`, async () => {
    const f = fixture();
    try {
      if (reason === "published") f.sql.exec("UPDATE recipe SET published_at = '2026-09-08' WHERE id = 10");
      if (reason === "shared") f.sql.exec("INSERT INTO recipe_share (recipe_id, household_id, shared_by) VALUES (10, 2, 1)");
      const id = reason === "foreign" ? 20 : reason === "missing" ? 99 : 10;
      assert.equal(await deleteRecipeWithImages(f.env, 1, id), false);
      assert.equal(f.count("SELECT count(*) AS n FROM recipe"), 3);
      assert.equal(f.count("SELECT count(*) AS n FROM recipe WHERE edit_token IS NOT NULL"), 0);
      assert.deepEqual(f.pending(), []);
      assert.deepEqual(f.deletes, []);
    } finally { f.sql.close(); }
  });
}

for (const planned of [10, 11]) {
  test(`planning recipe ${planned} after a screen precheck refuses the whole tree deletion`, async () => {
    const f = fixture();
    try {
      assert.equal(f.count("SELECT count(*) AS n FROM planned_batch"), 0);
      f.database.beforeBatch(() => f.sql.prepare(
        `INSERT INTO planned_batch
           (id, instance_key, household_id, recipe_id, multiplier, created_by)
         VALUES (1, 'delete-race', 2, ?, 1, 2)`,
      ).run(planned));
      assert.equal(await deleteRecipeWithImages(f.env, 1, 10), false);
      assert.equal(f.count("SELECT count(*) AS n FROM recipe"), 3);
      assert.deepEqual(f.pending(), []);
      assert.deepEqual(f.deletes, []);
      assert.equal(f.objects.size, 3);
    } finally { f.sql.close(); }
  });
}

test("sharing after the explanatory read also refuses atomically", async () => {
  const f = fixture();
  try {
    f.database.beforeBatch(() => f.sql.exec(
      "INSERT INTO recipe_share (recipe_id, household_id, shared_by) VALUES (10, 2, 1)",
    ));
    assert.equal(await deleteRecipeWithImages(f.env, 1, 10), false);
    assert.equal(f.count("SELECT count(*) AS n FROM recipe"), 3);
    assert.deepEqual(f.pending(), []);
    assert.deepEqual(f.deletes, []);
  } finally { f.sql.close(); }
});

test("a database failure after child deletion rolls back the tree and cleanup queue", async () => {
  const f = fixture();
  try {
    f.sql.exec(`CREATE TRIGGER fail_parent BEFORE DELETE ON recipe WHEN OLD.id = 10
      BEGIN SELECT RAISE(ABORT, 'injected parent delete failure'); END;`);
    await assert.rejects(() => deleteRecipeWithImages(f.env, 1, 10), /injected/);
    assert.equal(f.count("SELECT count(*) AS n FROM recipe"), 3);
    assert.equal(f.count("SELECT count(*) AS n FROM recipe WHERE edit_token IS NOT NULL"), 0);
    assert.deepEqual(f.pending(), []);
    assert.deepEqual(f.deletes, []);
    assert.equal(f.objects.size, 3);
  } finally { f.sql.close(); }
});

test("R2 failure does not fail a committed deletion; durable replay is idempotent", async () => {
  const f = fixture();
  try {
    f.failures.add('recipes/1/11/part.png');
    assert.equal(await deleteRecipeWithImages(f.env, 1, 10), true);
    assert.equal(f.count("SELECT count(*) AS n FROM recipe WHERE household_id = 1"), 0);
    assert.deepEqual(f.pending(), ['recipes/1/11/part.png']);
    assert.ok(f.objects.has('recipes/1/11/part.png'));
    f.failures.clear();
    await cleanupDeletedRecipeImages(f.env);
    assert.deepEqual(f.pending(), []);
    const attempts = f.deletes.length;
    await cleanupDeletedRecipeImages(f.env);
    assert.equal(f.deletes.length, attempts);
    assert.ok(!f.objects.has('recipes/1/11/part.png'));
  } finally { f.sql.close(); }
});

test("an R2 success with a failed D1 acknowledgement safely retries an absent object", async () => {
  const f = fixture();
  try {
    f.sql.exec(`CREATE TRIGGER fail_ack BEFORE DELETE ON recipe_image_cleanup
      BEGIN SELECT RAISE(ABORT, 'injected acknowledgement failure'); END;`);
    assert.equal(await deleteRecipeWithImages(f.env, 1, 10), true);
    assert.equal(f.pending().length, 2);
    assert.equal(f.objects.size, 1);
    f.sql.exec("DROP TRIGGER fail_ack");
    await cleanupDeletedRecipeImages(f.env);
    assert.deepEqual(f.pending(), []);
    assert.equal(f.objects.size, 1);
  } finally { f.sql.close(); }
});

test("a concurrent image replacement queues the key at deletion time, not a stale read", async () => {
  const f = fixture();
  try {
    f.database.beforeBatch(() => {
      f.objects.add('recipes/1/10/new.png');
      f.sql.exec("UPDATE recipe SET image_key = 'recipes/1/10/new.png' WHERE id = 10");
      f.objects.delete('recipes/1/10/dish.png'); // The successful upload's own cleanup.
    });
    assert.equal(await deleteRecipeWithImages(f.env, 1, 10), true);
    assert.deepEqual(f.deletes.sort(), ['recipes/1/10/new.png', 'recipes/1/11/part.png']);
    assert.equal(f.objects.size, 1);
  } finally { f.sql.close(); }
});

test("cleanup preserves live references in any household and freshly uploaded images", async () => {
  const f = fixture();
  try {
    f.sql.exec(`INSERT INTO recipe_image_cleanup (image_key, household_id)
      VALUES ('recipes/2/20/other.png', 1);`);
    f.objects.add('recipes/1/10/fresh-upload.png');
    await cleanupDeletedRecipeImages(f.env, 1);
    assert.deepEqual(f.deletes, []);
    assert.ok(f.objects.has('recipes/2/20/other.png'));
    assert.ok(f.objects.has('recipes/1/10/fresh-upload.png'));
    assert.deepEqual(f.pending(), ['recipes/2/20/other.png']);
  } finally { f.sql.close(); }
});

test("cleanup work is bounded, household-scoped, and failed keys do not starve later work", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < IMAGE_CLEANUP_LIMIT + 1; i++) {
      const key = `recipes/1/99/${String(i).padStart(2, '0')}.png`;
      f.sql.prepare(`INSERT INTO recipe_image_cleanup (image_key, household_id, queued_at)
        VALUES (?, 1, '2020-01-01 00:00:00.000')`).run(key);
      f.objects.add(key);
      f.failures.add(key);
    }
    f.sql.exec(`INSERT INTO recipe_image_cleanup (image_key, household_id, queued_at)
      VALUES ('recipes/2/99/pending.png', 2, '2019-01-01 00:00:00.000');`);
    await cleanupDeletedRecipeImages(f.env, 1);
    assert.equal(f.deletes.length, IMAGE_CLEANUP_LIMIT);
    assert.ok(f.deletes.every((key) => key.startsWith('recipes/1/')));
    const last = `recipes/1/99/${String(IMAGE_CLEANUP_LIMIT).padStart(2, '0')}.png`;
    await cleanupDeletedRecipeImages(f.env, 1);
    assert.equal(f.deletes[IMAGE_CLEANUP_LIMIT], last);
    assert.ok(f.deletes.length <= IMAGE_CLEANUP_LIMIT * 2);
  } finally { f.sql.close(); }
});

test("a cleanup receipt failure prevents the database deletion too", async () => {
  const f = fixture();
  try {
    f.sql.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON recipe_image_cleanup
      BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END;`);
    await assert.rejects(() => deleteRecipeWithImages(f.env, 1, 10), /receipt failure/);
    assert.equal(f.count("SELECT count(*) AS n FROM recipe"), 3);
    assert.equal(f.count("SELECT count(*) AS n FROM recipe WHERE edit_token IS NOT NULL"), 0);
    assert.deepEqual(f.pending(), []);
    assert.deepEqual(f.deletes, []);
  } finally { f.sql.close(); }
});

test("losing the database response after commit leaves durable cleanup receipts", async () => {
  const f = fixture();
  try {
    const batch = f.env.DB.batch.bind(f.env.DB);
    f.env.DB = { ...f.env.DB, batch: async (statements) => {
      await batch(statements);
      throw new Error("lost committed response");
    } } as D1Database;
    await assert.rejects(() => deleteRecipeWithImages(f.env, 1, 10), /lost committed response/);
    assert.equal(f.count("SELECT count(*) AS n FROM recipe WHERE household_id = 1"), 0);
    assert.equal(f.pending().length, 2);
    assert.deepEqual(f.deletes, []);
    await cleanupDeletedRecipeImages(f.env);
    assert.deepEqual(f.pending(), []);
    assert.equal(f.objects.size, 1);
  } finally { f.sql.close(); }
});

const member = {
  id: 1, householdId: 1, displayName: "One", email: null, isAdmin: false,
};

function context(env: Env, api: boolean): RouteContext {
  const url = new URL(api ? "https://example.com/api/recipes/10" : "https://example.com/recipes/10/delete");
  return { env, url, params: { id: "10" }, request: new Request(url, { method: api ? "DELETE" : "POST" }) };
}

for (const api of [false, true]) {
  const name = api ? "API" : "screen";
  const handler = api ? apiDeleteRecipe : deleteRecipeForm;

  test(`${name} deletion refuses a planning race after its actual menu precheck`, async () => {
    const f = fixture();
    try {
      const db = f.env.DB;
      // Reads in loadRecipe also use batch(). Arm the race only once the real
      // delete operation is prepared, after this handler's explanatory reads.
      f.env.DB = { ...db, prepare: (text: string) => {
        if (text.includes("UPDATE recipe SET edit_token")) {
          assert.equal(f.count("SELECT count(*) AS n FROM planned_batch"), 0);
          f.database.beforeBatch(() => f.sql.exec(`INSERT INTO planned_batch
            (id, instance_key, household_id, recipe_id, multiplier, created_by)
            VALUES (1, 'handler-delete-race', 1, 10, 1, 1)`));
        }
        return db.prepare(text);
      } } as D1Database;
      const response = await handler(context(f.env, api), member);
      assert.equal(response.status, 409);
      assert.match(response.headers.get("content-type")!, api ? /json/ : /text\/html/);
      const body = await response.text();
      assert.match(body, api ? /could not be deleted/ : /class="refused"/);
      if (!api) assert.match(body, /sitä ei poistettu/);
      assert.equal(f.count("SELECT count(*) AS n FROM recipe"), 3);
      assert.deepEqual(f.pending(), []);
      assert.deepEqual(f.deletes, []);
      assert.equal(f.objects.size, 3);
    } finally { f.sql.close(); }
  });

  test(`${name} deletion still succeeds when part-image cleanup fails`, async () => {
    const f = fixture();
    try {
      f.failures.add("recipes/1/11/part.png");
      const response = await handler(context(f.env, api), member);
      assert.equal(response.status, api ? 204 : 303);
      if (!api) assert.equal(response.headers.get("location"), "/recipes");
      assert.equal(f.count("SELECT count(*) AS n FROM recipe WHERE household_id = 1"), 0);
      assert.deepEqual(f.pending(), ["recipes/1/11/part.png"]);
      assert.ok(f.objects.has("recipes/1/11/part.png"));
      assert.ok(f.objects.has("recipes/2/20/other.png"));
    } finally { f.sql.close(); }
  });
}

test("pending cleanup survives a real migrated-SQLite backup/restore and seed reset", async () => {
  const f = fixture();
  const target = migratedDatabase();
  try {
    f.failures.add("recipes/1/11/part.png");
    assert.equal(await deleteRecipeWithImages(f.env, 1, 10), true);
    const tables = Object.fromEntries(BACKUP_TABLES.map(({ name, orderBy }) => [
      name, f.sql.prepare(`SELECT * FROM ${name} ORDER BY ${orderBy}`).all(),
    ])) as BackupSnapshotUnsigned["tables"];
    const names = BACKUP_TABLES.map(({ name }) => `'${name}'`).join(", ");
    const snapshot = await finalizeSnapshot({
      format_version: 1,
      scheduled_at: "2026-09-08T00:00:00Z",
      captured_at: "2026-09-08T00:00:01Z",
      schema: f.sql.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
        WHERE sql IS NOT NULL AND (name IN (${names}) OR tbl_name IN (${names}))
        ORDER BY type, name`).all() as unknown as BackupSnapshotUnsigned["schema"],
      row_counts: Object.fromEntries(BACKUP_TABLES.map(({ name }) => [name, tables[name].length])) as BackupSnapshotUnsigned["row_counts"],
      tables,
    });
    const parsed = await parseAndValidateSnapshot(canonicalJson(snapshot));
    target.sql.exec(generateRestoreSql(parsed));
    const restored = Object.fromEntries(BACKUP_TABLES.map(({ name, orderBy }) => [
      name, target.sql.prepare(`SELECT * FROM ${name} ORDER BY ${orderBy}`).all(),
    ])) as BackupSnapshotUnsigned["tables"];
    assertRestoredRows(parsed, restored);
    assert.equal(restored.recipe_image_cleanup[0]?.image_key, "recipes/1/11/part.png");
    assert.notEqual(restored.recipe_image_cleanup[0]?.last_attempt_at, null);
    const { readFileSync } = await import("node:fs");
    target.sql.exec(readFileSync(new URL("./seed.sql", import.meta.url), "utf8"));
    assert.equal((target.sql.prepare("SELECT count(*) AS n FROM recipe_image_cleanup").get() as { n: number }).n, 0);
  } finally { target.sql.close(); f.sql.close(); }
});

test("a restored live reference appearing after queue selection prevents cleanup", async () => {
  const f = fixture();
  try {
    const key = "recipes/1/99/restored.png";
    f.objects.add(key);
    f.sql.prepare("INSERT INTO recipe_image_cleanup (image_key, household_id) VALUES (?, 1)").run(key);
    const db = f.env.DB;
    f.env.DB = { ...db, prepare: (text: string) => {
      if (text.includes("UPDATE recipe_image_cleanup")) {
        f.sql.prepare("UPDATE recipe SET image_key = ? WHERE id = 20").run(key);
      }
      return db.prepare(text);
    } } as D1Database;
    await cleanupDeletedRecipeImages(f.env);
    assert.deepEqual(f.deletes, []);
    assert.deepEqual(f.pending(), [key]);
    assert.ok(f.objects.has(key));
  } finally { f.sql.close(); }
});
