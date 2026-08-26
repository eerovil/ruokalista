import assert from "node:assert/strict";
import test from "node:test";

import type { Env } from "../src/env.ts";
import { encodePng } from "../src/png.ts";
import { commitCrops, type CropPlan } from "../src/recipe-image-batch.ts";
import { removeRecipeImage, storeRecipeImage } from "../src/recipe-images.ts";

/**
 * What happens when storage itself fails, and when two writers race.
 *
 * Neither can be provoked through a browser: R2 does not fail on request, and
 * the window between reading a recipe's picture and writing the new one is
 * milliseconds in a test and up to three minutes in the batch generator, which
 * is the case that matters. So the bucket and the database are faked here and
 * made to fail on demand.
 *
 * The two properties being defended:
 *
 *   - **No orphans.** Every object written must end up either pointed at by its
 *     recipe or deleted. An object in R2 with nothing pointing at it is a bill
 *     nobody can explain and a file nobody can find.
 *   - **No lost updates.** A write that was planned against a picture somebody
 *     has since replaced must decline, not overwrite. The generator reads a
 *     recipe, waits minutes for a drawing, and comes back to a row that may
 *     have moved on.
 */

/** A bucket that remembers what it holds and can be told to fail. */
class FakeBucket {
  objects = new Map<string, number>();
  puts = 0;
  deletes: string[] = [];
  /** Which put, counting from one, should fail. Null means none of them. */
  failPut: number | null = null;
  failDeletes = false;

  async put(key: string, bytes: ArrayBuffer): Promise<void> {
    this.puts += 1;
    if (this.failPut === this.puts) throw new Error("R2 is unavailable");
    this.objects.set(key, bytes.byteLength);
  }

  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    if (this.failDeletes) throw new Error("R2 delete is unavailable");
    this.objects.delete(key);
  }
}

/**
 * A database holding one column that matters, and implementing the same
 * compare-and-swap the real UPDATE does.
 *
 * It reads the bound parameters rather than the SQL, which is deliberate: if
 * somebody drops the `image_key IS ?` clause, the expected key stops arriving in
 * the last position and these tests fail. The assertion below pins the clause
 * itself as well, so both halves of the mechanism are held down.
 */
class FakeDatabase {
  /** recipe id → the key its row currently holds. */
  rows = new Map<number, string | null>();
  failUpdates = false;
  lastSql = "";

  prepare(sql: string) {
    this.lastSql = sql;
    const db = this;
    return {
      bind(...args: unknown[]) {
        return {
          async run() {
            if (db.failUpdates) throw new Error("D1 is unavailable");

            // The store statement binds seven values —
            // (key, origin, fingerprint, model, id, household, expectedKey) —
            // and the remove statement binds three: (id, household, expectedKey).
            const isStore = args.length === 7;
            const newKey = isStore ? (args[0] as string) : null;
            const recipeId = args[isStore ? 4 : 0] as number;
            const expected = args[isStore ? 6 : 2] as string | null;

            if (!db.rows.has(recipeId)) return { meta: { changes: 0 } };
            if ((db.rows.get(recipeId) ?? null) !== expected) {
              return { meta: { changes: 0 } };
            }

            db.rows.set(recipeId, newKey);
            return { meta: { changes: 1 } };
          },
        };
      },
    };
  }
}

function fakeEnv(): { env: Env; bucket: FakeBucket; db: FakeDatabase } {
  const bucket = new FakeBucket();
  const db = new FakeDatabase();
  return {
    env: { DB: db as unknown as D1Database, RECIPE_IMAGES: bucket } as unknown as Env,
    bucket,
    db,
  };
}

/** A real, decodable 8×8 PNG, because the byte checks are not being faked. */
async function png(): Promise<ArrayBuffer> {
  const data = new Uint8Array(8 * 8 * 4).fill(200);
  const bytes = await encodePng({ width: 8, height: 8, data });
  return bytes.slice().buffer;
}

function plan(overrides: Partial<CropPlan> = {}): CropPlan {
  return {
    cell: 0,
    recipeId: 1,
    title: "Kaalilaatikko",
    fingerprint: "abc123",
    expectedKey: null,
    ...overrides,
  };
}

// ------------------------------------------------------------ storeRecipeImage

test("the update is conditional on the key that was read", async () => {
  const { env, db } = fakeEnv();
  db.rows.set(1, null);

  await storeRecipeImage(env, 1, 1, null, await png());

  // The mechanism, not just its effect: without this clause the CAS is gone and
  // every test below would still pass against a fake that ignored it.
  assert.match(db.lastSql, /image_key IS \?/);
});

test("a first upload succeeds against a row with no picture", async () => {
  const { env, bucket, db } = fakeEnv();
  db.rows.set(1, null);

  assert.equal(await storeRecipeImage(env, 1, 1, null, await png()), null);
  assert.equal(bucket.objects.size, 1);
  assert.equal(db.rows.get(1), [...bucket.objects.keys()][0]);
});

test("a replacement drops the picture it replaced, and only that", async () => {
  const { env, bucket, db } = fakeEnv();
  bucket.objects.set("old-key", 10);
  db.rows.set(1, "old-key");

  assert.equal(await storeRecipeImage(env, 1, 1, "old-key", await png()), null);
  assert.deepEqual(bucket.deletes, ["old-key"]);
  assert.equal(bucket.objects.has("old-key"), false);
  assert.equal(bucket.objects.size, 1);
});

test("a write planned against a picture somebody replaced is declined", async () => {
  const { env, bucket, db } = fakeEnv();
  bucket.objects.set("theirs", 10);
  // This is the race: we read `null` before the sheet was drawn, and while it
  // was being drawn somebody uploaded a picture of their own.
  db.rows.set(1, "theirs");

  const refusal = await storeRecipeImage(env, 1, 1, null, await png());

  assert.notEqual(refusal, null);
  assert.equal(refusal!.status, 409);
  assert.match(refusal!.english, /changed while/);

  // Their picture is untouched and still pointed at.
  assert.equal(db.rows.get(1), "theirs");
  assert.equal(bucket.objects.has("theirs"), true);
  // And ours is gone rather than left in the bucket as an orphan.
  assert.equal(bucket.objects.size, 1);
});

test("two generations racing: the first wins and the second is declined", async () => {
  const { env, bucket, db } = fakeEnv();
  db.rows.set(1, null);

  // Both read the same empty row before either wrote.
  const first = await storeRecipeImage(env, 1, 1, null, await png());
  const second = await storeRecipeImage(env, 1, 1, null, await png());

  assert.equal(first, null);
  assert.notEqual(second, null);
  assert.equal(second!.status, 409);

  // Exactly one object survives, and it is the one the row names.
  assert.equal(bucket.objects.size, 1);
  assert.equal(bucket.objects.has(db.rows.get(1)!), true);
});

test("a recipe deleted mid-generation leaves nothing behind", async () => {
  const { env, bucket } = fakeEnv();
  // No row at all: the recipe went away while the sheet was being drawn.

  const refusal = await storeRecipeImage(env, 1, 1, null, await png());

  assert.equal(refusal!.status, 409);
  assert.equal(bucket.objects.size, 0);
});

test("a bucket that will not take the bytes leaves the row alone", async () => {
  const { env, bucket, db } = fakeEnv();
  bucket.objects.set("old-key", 10);
  db.rows.set(1, "old-key");
  bucket.failPut = 1;
  const bytes = await png();

  await assert.rejects(
    () => storeRecipeImage(env, 1, 1, "old-key", bytes),
    /R2 is unavailable/,
  );

  // The recipe still points at the picture it had, and nothing new exists.
  assert.equal(db.rows.get(1), "old-key");
  assert.equal(bucket.objects.size, 1);
  assert.equal(bucket.objects.has("old-key"), true);
});

test("a database that will not take the update deletes the bytes it wrote", async () => {
  const { env, bucket, db } = fakeEnv();
  bucket.objects.set("old-key", 10);
  db.rows.set(1, "old-key");
  db.failUpdates = true;
  const bytes = await png();

  await assert.rejects(
    () => storeRecipeImage(env, 1, 1, "old-key", bytes),
    /D1 is unavailable/,
  );

  // The object written a moment ago is gone: no orphan, and the old picture is
  // still there and still pointed at.
  assert.equal(db.rows.get(1), "old-key");
  assert.equal(bucket.objects.size, 1);
  assert.equal(bucket.objects.has("old-key"), true);
});

// ----------------------------------------------------------- removeRecipeImage

test("removing a picture clears the row and drops the bytes", async () => {
  const { env, bucket, db } = fakeEnv();
  bucket.objects.set("mine", 10);
  db.rows.set(1, "mine");

  await removeRecipeImage(env, 1, 1, "mine");

  assert.equal(db.rows.get(1), null);
  assert.equal(bucket.objects.size, 0);
});

test("a removal that raced a replacement leaves the newer picture alone", async () => {
  const { env, bucket, db } = fakeEnv();
  bucket.objects.set("theirs", 10);
  db.rows.set(1, "theirs");

  // We are holding the key from before their upload.
  await removeRecipeImage(env, 1, 1, "ours");

  // Their picture survives, and we did not delete the bytes it points at.
  assert.equal(db.rows.get(1), "theirs");
  assert.equal(bucket.objects.has("theirs"), true);
  assert.deepEqual(bucket.deletes, []);
});

// ------------------------------------------------------------------ the batch

/** `count` crops of real PNG bytes, one per cell. */
async function crops(count: number) {
  const data = new Uint8Array(8 * 8 * 4).fill(180);
  const bytes = await encodePng({ width: 8, height: 8, data });
  return Array.from({ length: count }, (_, cell) => ({ cell, png: bytes }));
}

test("a whole batch stores, and reports each recipe by name", async () => {
  const { env, db } = fakeEnv();
  const entries = [plan({ cell: 0, recipeId: 1 }), plan({ cell: 1, recipeId: 2 })];
  for (const entry of entries) db.rows.set(entry.recipeId, null);

  const result = await commitCrops(env, 1, entries, await crops(2), "openai:gpt-image-2/s1");

  assert.equal(result.stored, 2);
  assert.deepEqual(
    result.cells.map((cell) => [cell.recipeId, cell.status]),
    [[1, "stored"], [2, "stored"]],
  );
});

test("one recipe failing does not stop the rest, and does not undo them", async () => {
  const { env, bucket, db } = fakeEnv();
  const entries = [
    plan({ cell: 0, recipeId: 1 }),
    plan({ cell: 1, recipeId: 2 }),
    plan({ cell: 2, recipeId: 3 }),
  ];
  for (const entry of entries) db.rows.set(entry.recipeId, null);

  // Only the second write fails. The first has already committed and the third
  // is still to come, which is the case the card asked to have made explicit:
  // one crop failing in the middle of a batch.
  bucket.failPut = 2;

  const result = await commitCrops(env, 1, entries, await crops(3), "openai:gpt-image-2/s1");

  assert.equal(result.stored, 2);
  assert.deepEqual(
    result.cells.map((cell) => cell.status),
    ["stored", "not-stored", "stored"],
  );
  assert.match(result.cells[1]!.reason!, /storing it failed: R2 is unavailable/);

  // Recipe 1's picture is kept rather than rolled back, and recipe 2 has none.
  assert.notEqual(db.rows.get(1), null);
  assert.equal(db.rows.get(2), null);
  assert.notEqual(db.rows.get(3), null);
  // Two rows with pictures, two objects. No orphan from the failed one.
  assert.equal(bucket.objects.size, 2);
});

test("a batch where every write fails changes nothing at all", async () => {
  const { env, bucket, db } = fakeEnv();
  const entries = [plan({ cell: 0, recipeId: 1 }), plan({ cell: 1, recipeId: 2 })];
  db.rows.set(1, "one");
  db.rows.set(2, "two");
  bucket.objects.set("one", 10);
  bucket.objects.set("two", 10);
  entries[0]!.expectedKey = "one";
  entries[1]!.expectedKey = "two";
  db.failUpdates = true;

  const result = await commitCrops(env, 1, entries, await crops(2), "openai:gpt-image-2/s1");

  assert.equal(result.stored, 0);
  for (const cell of result.cells) assert.equal(cell.status, "not-stored");

  // Both recipes keep the picture they had, and nothing was added.
  assert.equal(db.rows.get(1), "one");
  assert.equal(db.rows.get(2), "two");
  assert.equal(bucket.objects.size, 2);
});

test("a batch that loses every race reports the conflict, not a crash", async () => {
  const { env, bucket, db } = fakeEnv();
  const entries = [plan({ cell: 0, recipeId: 1 }), plan({ cell: 1, recipeId: 2 })];
  // Both rows moved on while the sheet was being drawn.
  db.rows.set(1, "someone-elses");
  db.rows.set(2, "someone-elses-too");
  bucket.objects.set("someone-elses", 10);
  bucket.objects.set("someone-elses-too", 10);

  const result = await commitCrops(env, 1, entries, await crops(2), "openai:gpt-image-2/s1");

  assert.equal(result.stored, 0);
  for (const cell of result.cells) {
    assert.equal(cell.status, "not-stored");
    assert.match(cell.reason!, /changed while/);
  }
  // The two pictures somebody else chose are intact, and ours are not lying
  // around beside them.
  assert.equal(bucket.objects.size, 2);
});

test("a crop for a cell with no plan is ignored rather than misfiled", async () => {
  const { env, db } = fakeEnv();
  db.rows.set(1, null);

  // Three crops, one planned recipe: the extra two belong to nobody.
  const result = await commitCrops(env, 1, [plan()], await crops(3), "openai:gpt-image-2/s1");

  assert.equal(result.stored, 1);
  assert.equal(result.cells.length, 1);
});
