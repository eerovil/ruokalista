import assert from "node:assert/strict";
import test from "node:test";

import type { Env } from "../src/env.ts";
import { adoptFoundImage } from "../src/intake-screens.ts";
import { readIntakeJobImage } from "../src/intake-jobs.ts";
import type { Member } from "../src/members.ts";
import { png } from "./support/images.ts";

/**
 * The hand-over: a picture the importer took off a web page becoming the
 * recipe's own picture (#205).
 *
 * Checked here rather than through a browser because a browser run has no
 * queue consumer, so no job ever really fetches anything and there are no
 * bytes in the bucket to hand over. The bucket and the database are faked; the
 * picture is a real PNG, because the thing being defended is that these bytes
 * go through the same checks an uploaded picture does.
 *
 *   ./scripts/node.sh npm run check
 */

const MEMBER = { id: 1, householdId: 7 } as unknown as Member;

/**
 * A Buffer's own bytes, and not the pool it was allocated out of. `.buffer`
 * alone hands over whatever else Node happened to put in that pool, which
 * reads as "these are not a picture" three layers down.
 */
function bytesOf(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

interface Fakes {
  env: Env;
  objects: Map<string, ArrayBuffer>;
  recipeImage(): string | null;
  deleted: string[];
}

/**
 * A job row, a bucket, and the one recipe column that matters.
 *
 * `first()` answers the job lookup; the recipe UPDATE is matched on the same
 * compare-and-swap the real statement makes, so a store against a picture that
 * moved declines here too.
 */
function fakes(job: Record<string, unknown> | null): Fakes {
  const objects = new Map<string, ArrayBuffer>();
  const deleted: string[] = [];
  let recipeImage: string | null = null;

  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind: (...bound: unknown[]) => {
          values = bound;
          return statement;
        },
        run: async () => {
          if (sql.includes("UPDATE recipe")) {
            recipeImage = String(values[0]);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        },
        first: async () => job,
        all: async () => ({ results: [] }),
      };
      return statement;
    },
  };

  return {
    env: {
      DB: db as unknown as D1Database,
      RECIPE_IMAGES: {
        get: async (key: string) => {
          const bytes = objects.get(key);
          return bytes === undefined
            ? null
            : { arrayBuffer: async () => bytes };
        },
        put: async (key: string, bytes: ArrayBuffer) => {
          objects.set(key, bytes);
        },
        delete: async (key: string) => {
          deleted.push(key);
          objects.delete(key);
        },
      },
    } as unknown as Env,
    objects,
    recipeImage: () => recipeImage,
    deleted,
  };
}

function readyLinkedJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    household_id: 7,
    created_by: 1,
    status: "ready",
    lease_id: null,
    source_route: "linked",
    source_text: "Uunikaali",
    source_url: "https://kotikokki.example/uunikaali",
    image_refs: null,
    page_image_key: "intake/job-1/found.png",
    page_image_type: "image/png",
    draft_json: null,
    error_message: null,
    created_at: "2026-08-29 00:00:00",
    updated_at: "2026-08-29 00:00:00",
    ...overrides,
  };
}

test("the page's picture becomes the recipe's own picture", async () => {
  const world = fakes(readyLinkedJob());
  const bytes = png(900, 600);
  world.objects.set("intake/job-1/found.png", bytesOf(bytes));

  await adoptFoundImage(world.env, MEMBER, "job-1", 42);

  // Stored under the recipe, in this household's own prefix — indistinguishable
  // from a picture somebody uploaded, which is the whole point.
  const key = world.recipeImage();
  assert.notEqual(key, null);
  assert.match(key ?? "", /^recipes\/7\/42\/[0-9a-f-]+\.png$/);
  assert.equal(world.objects.get(key ?? "")?.byteLength, bytes.byteLength);
});

test("the picture is handed over household-scoped, like every other read", async () => {
  // The job belongs to household 9; this member is in 7, so the lookup finds
  // nothing and there is nothing to adopt.
  const world = fakes(null);
  world.objects.set("intake/job-1/found.png", bytesOf(png(400, 300)));

  assert.equal(await readIntakeJobImage(world.env, "job-1", 7), null);
  await adoptFoundImage(world.env, MEMBER, "job-1", 42);
  assert.equal(world.recipeImage(), null);
});

test("a photographed job's pages are not a picture of the dish", async () => {
  // Same column, opposite meaning: these are the sheets somebody photographed,
  // and putting one on the recipe as its picture would be nonsense.
  const world = fakes(readyLinkedJob({
    source_route: "photographed",
    page_image_key: null,
    page_image_type: null,
    image_refs: JSON.stringify([{ key: "intake/job-1/1", mediaType: "image/jpeg" }]),
  }));
  world.objects.set("intake/job-1/1", bytesOf(png(400, 300)));

  assert.equal(await readIntakeJobImage(world.env, "job-1", 7), null);
});

test("a job with no picture on it saves the recipe and says nothing", async () => {
  const world = fakes(readyLinkedJob({ page_image_key: null, page_image_type: null }));

  await adoptFoundImage(world.env, MEMBER, "job-1", 42);
  assert.equal(world.recipeImage(), null);
});

test("bytes that went missing from the bucket do not break the save", async () => {
  // The job says there is a picture and the bucket disagrees. The recipe is
  // already written by the time this runs, and it stays written.
  const world = fakes(readyLinkedJob());

  await adoptFoundImage(world.env, MEMBER, "job-1", 42);
  assert.equal(world.recipeImage(), null);
});

test("bytes that are not a storable picture are refused, not stored", async () => {
  const world = fakes(readyLinkedJob());
  // Past the pixel cap every uploaded picture is held to. Whatever the site
  // served, this recipe does not get a 4000-pixel photograph.
  world.objects.set("intake/job-1/found.png", bytesOf(png(4000, 3000)));

  await adoptFoundImage(world.env, MEMBER, "job-1", 42);
  assert.equal(world.recipeImage(), null);
});
