import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { assertImagesReadable, auditBackupImages } from "../scripts/backup-images.ts";
import { BACKUP_TABLES, canonicalJson, type BackupSnapshotUnsigned } from "../src/backup.ts";
import type { Env } from "../src/env.ts";
import { encodePng } from "../src/png.ts";
import { deleteRecipeWithImages } from "../src/recipe-deletion.ts";
import {
  cleanupRetiredRecipeImages,
  IMAGE_RECOVERY_DAYS,
  IMAGE_RESTORE_MARGIN_DAYS,
  removeRecipeImage,
  storeRecipeImage,
  type ImageProvenance,
} from "../src/recipe-image-lifecycle.ts";
import { assertRestoredRows, finalizeSnapshot, generateRestoreSql, parseAndValidateSnapshot } from "../src/restore.ts";
import { migratedDatabase, type FakeD1 } from "./support/d1.ts";

async function snapshotOf(database: FakeD1) {
  const tables = Object.fromEntries(BACKUP_TABLES.map(({ name, orderBy }) => [
    name, database.sql.prepare(`SELECT * FROM ${name} ORDER BY ${orderBy}`).all(),
  ])) as BackupSnapshotUnsigned["tables"];
  const names = BACKUP_TABLES.map(({ name }) => `'${name}'`).join(", ");
  const now = new Date().toISOString();
  return parseAndValidateSnapshot(canonicalJson(await finalizeSnapshot({
    format_version: 1, scheduled_at: now, captured_at: now,
    schema: database.sql.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
      WHERE sql IS NOT NULL AND (name IN (${names}) OR tbl_name IN (${names}))
      ORDER BY type, name`).all() as unknown as BackupSnapshotUnsigned["schema"],
    tables,
    row_counts: Object.fromEntries(BACKUP_TABLES.map(({ name }) => [name, tables[name].length])) as BackupSnapshotUnsigned["row_counts"],
  })));
}

function fixture(t: TestContext) {
  const database = migratedDatabase();
  t.after(() => database.sql.close());
  const { sql } = database;
  sql.exec(`
    INSERT INTO household (id, name) VALUES (1, 'Home'), (2, 'Other');
    INSERT INTO member (id, household_id, google_sub, display_name)
      VALUES (1, 1, 'one', 'One'), (2, 2, 'two', 'Two');
    INSERT INTO recipe (id, household_id, parent_id, title, source_text, source_route, created_by, updated_by)
      VALUES (1, 1, NULL, 'Dish', '', 'pasted', 1, 1),
             (2, 1, 1, 'Part', '', 'pasted', 1, 1),
             (3, 2, NULL, 'Other', '', 'pasted', 2, 2);
  `);
  const objects = new Map<string, Uint8Array>();
  const deletes: string[] = [];
  const bucket = {
    put: async (key: string, bytes: ArrayBuffer) => { objects.set(key, new Uint8Array(bytes).slice()); },
    delete: async (key: string) => { deletes.push(key); objects.delete(key); },
  };
  const env = { DB: database.db, RECIPE_IMAGES: bucket } as unknown as Env;
  const read = async (key: string) => objects.get(key) ?? null;
  function key(id = 1): string | null {
    return (sql.prepare("SELECT image_key FROM recipe WHERE id = ?").get(id) as { image_key: string | null } | undefined)?.image_key ?? null;
  }
  function receipt(value: string) {
    return sql.prepare("SELECT * FROM recipe_image_cleanup WHERE image_key = ?").get(value) as
      { image_key: string; queued_at: string; last_attempt_at: string | null } | undefined;
  }
  function age(modifier: string, value?: string) {
    sql.prepare(`UPDATE recipe_image_cleanup SET queued_at = strftime('%Y-%m-%d %H:%M:%f', 'now', ?)
      WHERE (? IS NULL OR image_key = ?)`)
      .run(modifier, value ?? null, value ?? null);
  }
  async function upload(id = 1, oldKey: string | null = null, color = 100, provenance?: ImageProvenance) {
    const bytes = await encodePng({ width: 2, height: 2, data: new Uint8Array(16).fill(color) });
    assert.equal(await storeRecipeImage(env, id === 3 ? 2 : 1, id, oldKey, bytes.slice().buffer, provenance), null);
    return key(id)!;
  }
  return { database, sql, objects, deletes, bucket, env, read, key, receipt, age, upload };
}

const MANUAL: ImageProvenance = { origin: "manual" }; // Uploads and URL imports use this same path.
const GENERATED: ImageProvenance = { origin: "generated", fingerprint: "fixture", model: "supplied:manual/test" };

test("the historical contract is 30 days plus one restore day", () => {
  assert.equal(IMAGE_RECOVERY_DAYS, 30);
  assert.equal(IMAGE_RESTORE_MARGIN_DAYS, 1);
});

for (const origin of [MANUAL, GENERATED]) {
  for (const action of ["replace", "remove", "delete"] as const) {
    test(`${origin.origin} ${action}: original parent/part bytes survive a 30-day snapshot restore`, async (t) => {
      const f = fixture(t);
      const parent = await f.upload(1, null, 100, origin);
      const part = await f.upload(2, null, 200, origin);
      const snapshot = await snapshotOf(f.database);
      const original = await auditBackupImages(snapshot, f.read);
      assertImagesReadable(original);
      if (action === "delete") assert.equal(await deleteRecipeWithImages(f.env, 1, 1), true);
      else {
        for (const [id, old] of [[1, parent], [2, part]] as const) {
          if (action === "replace") await f.upload(id, old, 250, origin);
          else await removeRecipeImage(f.env, 1, id, old);
        }
      }
      assert.ok(f.receipt(parent));
      assert.ok(f.receipt(part));
      f.age("-30 days");
      await cleanupRetiredRecipeImages(f.env);
      assert.deepEqual(f.deletes, []);
      assert.deepEqual((await auditBackupImages(snapshot, f.read)).objects, original.objects);

      const restored = migratedDatabase();
      t.after(() => restored.sql.close());
      restored.sql.exec(generateRestoreSql(snapshot));
      const after = await snapshotOf(restored);
      assertRestoredRows(snapshot, after.tables);
      const recovered = await auditBackupImages(after, f.read);
      assertImagesReadable(recovered);
      assert.deepEqual(recovered.objects, original.objects, "both original digests, not replacement bytes");
      await cleanupRetiredRecipeImages({ ...f.env, DB: restored.db });
      assert.deepEqual(f.deletes, [], "restored live references cannot be cleaned");
    });
  }
}

test("cleanup waits through the safety margin and accepts the exact expiry boundary", async (t) => {
  const f = fixture(t);
  const old = await f.upload();
  await removeRecipeImage(f.env, 1, 1, old);
  for (const age of ["-30 days", "-743 hours"]) {
    f.age(age);
    await cleanupRetiredRecipeImages(f.env);
    assert.ok(f.objects.has(old));
    assert.equal(f.receipt(old)?.last_attempt_at, null);
    assert.deepEqual(f.deletes, []);
  }
  f.age("-31 days");
  await cleanupRetiredRecipeImages(f.env);
  assert.ok(!f.objects.has(old));
  assert.equal(f.receipt(old), undefined);
  await cleanupRetiredRecipeImages(f.env);
  assert.deepEqual(f.deletes, [old]);
});

for (const action of ["replace", "remove", "delete"] as const) {
  test(`${action} resets a restored image's old retirement and failed-attempt timestamps`, async (t) => {
    const f = fixture(t);
    const old = await f.upload();
    f.sql.prepare(`INSERT INTO recipe_image_cleanup (image_key, household_id, queued_at, last_attempt_at)
      VALUES (?, 1, '2020-01-01 00:00:00.000', '2020-02-01 00:00:00.000')`).run(old);
    await cleanupRetiredRecipeImages(f.env);
    assert.deepEqual(f.deletes, [], "old age never defeats a live reference");
    if (action === "replace") await f.upload(1, old);
    if (action === "remove") await removeRecipeImage(f.env, 1, 1, old);
    if (action === "delete") assert.equal(await deleteRecipeWithImages(f.env, 1, 1), true);
    assert.ok(f.receipt(old)!.queued_at > "2020-02-01");
    assert.equal(f.receipt(old)!.last_attempt_at, null);
    await cleanupRetiredRecipeImages(f.env);
    assert.deepEqual(f.deletes, []);
  });
}

for (const action of ["replace", "remove"] as const) {
  test(`${action}: a failed CAS does not renew the old receipt or retire the winner`, async (t) => {
    const f = fixture(t);
    const a = await f.upload();
    const b = await f.upload(1, a, 200);
    f.age("-20 days", a);
    const before = f.receipt(a);
    if (action === "replace") {
      const bytes = await encodePng({ width: 2, height: 2, data: new Uint8Array(16).fill(240) });
      const refusal = await storeRecipeImage(f.env, 1, 1, a, bytes.slice().buffer);
      assert.equal(refusal?.status, 409);
      assert.equal(f.objects.size, 2, "only the confirmed losing upload is discarded");
    } else await removeRecipeImage(f.env, 1, 1, a);
    assert.equal(f.key(), b);
    assert.deepEqual(f.receipt(a), before);
    assert.equal(f.receipt(b), undefined);
    assert.ok(f.objects.has(a));
    assert.ok(f.objects.has(b));
  });
}

for (const action of ["replace", "remove"] as const) {
  for (const failure of ["receipt", "update"] as const) {
    test(`${action}: ${failure} failure rolls back both detachment and retirement`, async (t) => {
      const f = fixture(t);
      const old = await f.upload();
      f.sql.exec(failure === "receipt"
        ? `CREATE TRIGGER fail BEFORE INSERT ON recipe_image_cleanup BEGIN SELECT RAISE(ABORT, 'receipt failure'); END;`
        : `CREATE TRIGGER fail BEFORE UPDATE OF image_key ON recipe BEGIN SELECT RAISE(ABORT, 'update failure'); END;`);
      const bytes = await encodePng({ width: 2, height: 2, data: new Uint8Array(16).fill(200) });
      await assert.rejects(action === "replace"
        ? storeRecipeImage(f.env, 1, 1, old, bytes.slice().buffer)
        : removeRecipeImage(f.env, 1, 1, old), new RegExp(`${failure} failure`));
      assert.equal(f.key(), old);
      assert.equal(f.receipt(old), undefined);
      assert.ok(f.objects.has(old));
      assert.deepEqual(f.deletes, []);
    });
  }
}

test("a lost committed response never deletes a published upload, even after a newer replacement", async (t) => {
  const f = fixture(t);
  const a = await f.upload();
  const batch = f.env.DB.batch.bind(f.env.DB);
  let intermediate: Awaited<ReturnType<typeof snapshotOf>> | undefined;
  let b: string | undefined;
  f.env.DB.batch = async (statements) => {
    await batch(statements);
    f.env.DB.batch = batch;
    b = f.key()!;
    intermediate = await snapshotOf(f.database);
    await f.upload(1, b, 250);
    throw new Error("lost committed response");
  };
  const bytes = await encodePng({ width: 2, height: 2, data: new Uint8Array(16).fill(200) });
  await assert.rejects(storeRecipeImage(f.env, 1, 1, a, bytes.slice().buffer), /lost committed response/);
  assert.notEqual(f.key(), b);
  assert.equal(f.objects.size, 3);
  assertImagesReadable(await auditBackupImages(intermediate!, f.read));
  assert.ok(f.receipt(a));
  assert.ok(f.receipt(b!));
  assert.deepEqual(f.deletes, []);
});

test("a restored-and-retired key appearing after selection invalidates the stale cleanup attempt", async (t) => {
  const f = fixture(t);
  const old = await f.upload();
  await removeRecipeImage(f.env, 1, 1, old);
  f.age("-32 days");
  const db = f.env.DB;
  f.env.DB = { ...db, prepare: (text: string) => {
    if (text.includes("UPDATE recipe_image_cleanup")) f.age("+0 days", old);
    return db.prepare(text);
  } } as D1Database;
  await cleanupRetiredRecipeImages(f.env);
  assert.deepEqual(f.deletes, []);
  assert.ok(f.objects.has(old));
  assert.equal(f.receipt(old)?.last_attempt_at, null);
});

test("a delayed acknowledgement cannot delete a renewed retirement receipt", async (t) => {
  const f = fixture(t);
  const old = await f.upload();
  await removeRecipeImage(f.env, 1, 1, old);
  f.age("-32 days");
  const remove = f.bucket.delete;
  f.bucket.delete = async (key: string) => {
    await remove(key);
    f.age("+0 days", key);
  };
  await cleanupRetiredRecipeImages(f.env);
  assert.ok(f.receipt(old));
  assert.deepEqual(f.deletes, [old]);
});

test("invalid/future retirement dates are retained, and old live keys in any household survive", async (t) => {
  const f = fixture(t);
  const old = await f.upload();
  const other = await f.upload(3);
  await removeRecipeImage(f.env, 1, 1, old);
  f.sql.prepare(`INSERT INTO recipe_image_cleanup (image_key, household_id, queued_at)
    VALUES (?, 1, '2020-01-01 00:00:00.000')`).run(other);
  for (const date of ["invalid", "", "3026-09-08 00:00:00.000"]) {
    f.sql.prepare("UPDATE recipe_image_cleanup SET queued_at = ? WHERE image_key = ?").run(date, old);
    await cleanupRetiredRecipeImages(f.env);
    assert.deepEqual(f.deletes, []);
    assert.ok(f.objects.has(old));
    assert.ok(f.objects.has(other));
  }
});

test("same-bucket retention cannot mask a full bucket loss", async (t) => {
  const f = fixture(t);
  await f.upload();
  const snapshot = await snapshotOf(f.database);
  f.objects.clear();
  const audit = await auditBackupImages(snapshot, f.read);
  assert.throws(() => assertImagesReadable(audit), /unavailable=1/);
});
