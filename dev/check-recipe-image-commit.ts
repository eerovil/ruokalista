import assert from "node:assert/strict";
import test from "node:test";

import type { Env } from "../src/env.ts";
import { encodePng } from "../src/png.ts";
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
 *     has since replaced must decline, not overwrite. The image screen reads a
 *     recipe, the admin goes away to draw a sheet, and the crops come back to
 *     rows that may have moved on.
 *
 * Since #111 the batch loop itself runs in the admin's browser
 * (`src/client/recipe-image-split.ts`), because the Worker's plan gives a
 * request 10 ms of CPU and cutting a sheet needs a hundred times that. The
 * batch section at the bottom therefore drives the same *sequence* of
 * `storeRecipeImage` calls that loop makes, which is where every property worth
 * defending actually lives — the browser adds only which order to call them in
 * and what to say afterwards.
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

/**
 * What the browser's upload loop does, in one function, so its two ordering
 * rules can be checked without a browser.
 *
 * It is deliberately the dumb version — store each crop in turn, keep going
 * after a failure, record what happened — because that is exactly what
 * `src/client/recipe-image-split.ts` does once the crops are cut. What cannot be
 * checked here is the part before it: that no crop is uploaded until all of them
 * have been cut and validated. That is the browser suite's job, and
 * `tests/recipe-image-admin.spec.ts` holds it by uploading a sheet that cannot
 * be cut and finding every recipe untouched.
 */
async function uploadEach(
  env: Env,
  recipeIds: readonly number[],
  expected: ReadonlyMap<number, string | null>,
): Promise<{ stored: number; outcomes: ("stored" | "refused" | "failed")[] }> {
  const outcomes: ("stored" | "refused" | "failed")[] = [];
  let stored = 0;

  for (const recipeId of recipeIds) {
    try {
      const refusal = await storeRecipeImage(
        env,
        1,
        recipeId,
        expected.get(recipeId) ?? null,
        await png(),
        { origin: "generated", fingerprint: "abc123", model: "supplied:manual/s1" },
      );
      if (refusal === null) {
        stored += 1;
        outcomes.push("stored");
      } else {
        outcomes.push("refused");
      }
    } catch {
      // The browser catches per recipe too: one recipe's answer, not the batch's.
      outcomes.push("failed");
    }
  }

  return { stored, outcomes };
}

test("a whole batch stores every crop", async () => {
  const { env, bucket, db } = fakeEnv();
  db.rows.set(1, null);
  db.rows.set(2, null);

  const result = await uploadEach(env, [1, 2], new Map());

  assert.equal(result.stored, 2);
  assert.deepEqual(result.outcomes, ["stored", "stored"]);
  assert.equal(bucket.objects.size, 2);
});

test("one recipe failing does not stop the rest, and does not undo them", async () => {
  const { env, bucket, db } = fakeEnv();
  for (const id of [1, 2, 3]) db.rows.set(id, null);

  // Only the second write fails. The first has already committed and the third
  // is still to come, which is the case worth making explicit: one crop failing
  // in the middle of a batch that is already cut.
  bucket.failPut = 2;

  const result = await uploadEach(env, [1, 2, 3], new Map());

  assert.equal(result.stored, 2);
  assert.deepEqual(result.outcomes, ["stored", "failed", "stored"]);

  // Recipe 1's picture is kept rather than rolled back, and recipe 2 has none.
  assert.notEqual(db.rows.get(1), null);
  assert.equal(db.rows.get(2), null);
  assert.notEqual(db.rows.get(3), null);
  // Two rows with pictures, two objects. No orphan from the failed one.
  assert.equal(bucket.objects.size, 2);
});

test("a batch where every write fails changes nothing at all", async () => {
  const { env, bucket, db } = fakeEnv();
  db.rows.set(1, "one");
  db.rows.set(2, "two");
  bucket.objects.set("one", 10);
  bucket.objects.set("two", 10);
  db.failUpdates = true;

  const result = await uploadEach(
    env,
    [1, 2],
    new Map([[1, "one"], [2, "two"]]),
  );

  assert.equal(result.stored, 0);
  assert.deepEqual(result.outcomes, ["failed", "failed"]);

  // Both recipes keep the picture they had, and nothing was added.
  assert.equal(db.rows.get(1), "one");
  assert.equal(db.rows.get(2), "two");
  assert.equal(bucket.objects.size, 2);
});

test("a batch that loses every race reports the conflict, not a crash", async () => {
  const { env, bucket, db } = fakeEnv();
  // Both rows moved on while the admin was drawing the sheet.
  db.rows.set(1, "someone-elses");
  db.rows.set(2, "someone-elses-too");
  bucket.objects.set("someone-elses", 10);
  bucket.objects.set("someone-elses-too", 10);

  const result = await uploadEach(env, [1, 2], new Map());

  assert.equal(result.stored, 0);
  assert.deepEqual(result.outcomes, ["refused", "refused"]);
  // The two pictures somebody else chose are intact, and ours are not lying
  // around beside them.
  assert.equal(bucket.objects.size, 2);
});
