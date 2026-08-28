import assert from "node:assert/strict";
import test from "node:test";

import { scheduledBackup } from "../src/backup-scheduled.ts";
import {
  BACKUP_TABLES,
  backupIsStale,
  base64ToUtf8,
  canonicalJson,
  createBackupSnapshot,
  serializeBackupSnapshot,
  utf8ToBase64,
  writeSnapshotToGitHub,
} from "../src/backup.ts";

const SCHEDULED_AT = "2026-08-25T02:17:00.000Z";
const CAPTURED_AT = "2026-08-25T02:17:03.000Z";

test("canonical JSON and GitHub base64 preserve deterministic Finnish text", () => {
  assert.equal(
    canonicalJson({ z: 1, a: { ö: "crème fraîche", a: "½ dl" } }),
    canonicalJson({ a: { a: "½ dl", ö: "crème fraîche" }, z: 1 }),
  );

  const finnish = "Kaalilaatikko – ½ dl öljyä, crème fraîche";
  assert.equal(base64ToUtf8(utf8ToBase64(finnish)), finnish);
});

test("snapshot reads schema and every allowlisted table in one D1 batch", async () => {
  const fake = fakeDatabase();
  const snapshot = await createBackupSnapshot(fake.db, SCHEDULED_AT, CAPTURED_AT);

  assert.equal(fake.batchCalls(), 1);
  assert.equal(fake.preparedQueries().length, BACKUP_TABLES.length + 1);
  assert.deepEqual(Object.keys(snapshot.tables), BACKUP_TABLES.map(({ name }) => name));
  assert.equal(snapshot.row_counts.recipe, 1);
  assert.equal(snapshot.tables.recipe[0]?.source_text, "Kaalilaatikko\n½ dl öljyä");
  assert.equal(snapshot.tables.ingredient_product[0]?.ean, "6415712506032");
  assert.match(snapshot.sha256, /^[0-9a-f]{64}$/);

  const again = await createBackupSnapshot(
    fakeDatabase().db,
    SCHEDULED_AT,
    CAPTURED_AT,
  );
  assert.equal(again.sha256, snapshot.sha256);
  assert.equal(serializeBackupSnapshot(snapshot).endsWith("\n"), true);
});

test("same scheduled timestamp is idempotent", async () => {
  const existing = JSON.stringify({ scheduled_at: SCHEDULED_AT });
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    calls.push(init?.method ?? "GET");
    return jsonResponse({
      sha: "old-sha",
      size: existing.length,
      encoding: "base64",
      content: utf8ToBase64(existing),
    });
  };

  const committed = await writeSnapshotToGitHub(
    "{}\n",
    SCHEDULED_AT,
    "test-token",
    { fetchImpl, sleep: async () => {} },
  );

  assert.equal(committed, false);
  assert.deepEqual(calls, ["GET"]);
});

test("transient GitHub failures retry before committing", async () => {
  const responses = [
    new Response("temporary", { status: 500 }),
    new Response("missing", { status: 404 }),
    jsonResponse({ commit: { sha: "new-commit" } }, 201),
  ];
  const sleeps: number[] = [];
  const fetchImpl: typeof fetch = async () => responses.shift()!;

  const committed = await writeSnapshotToGitHub(
    "{}\n",
    SCHEDULED_AT,
    "test-token",
    { fetchImpl, sleep: async (milliseconds) => sleeps.push(milliseconds) },
  );

  assert.equal(committed, true);
  assert.deepEqual(sleeps, [100]);
  assert.equal(responses.length, 0);
});

test("409 conflict refetches and recognizes a concurrent identical run", async () => {
  const old = JSON.stringify({ scheduled_at: "2026-08-24T02:17:00.000Z" });
  const current = JSON.stringify({ scheduled_at: SCHEDULED_AT });
  const responses = [
    jsonResponse({
      sha: "old-sha",
      size: old.length,
      encoding: "base64",
      content: utf8ToBase64(old),
    }),
    new Response("conflict", { status: 409 }),
    jsonResponse({
      sha: "winning-sha",
      size: current.length,
      encoding: "base64",
      content: utf8ToBase64(current),
    }),
  ];
  const fetchImpl: typeof fetch = async () => responses.shift()!;

  const committed = await writeSnapshotToGitHub(
    "{}\n",
    SCHEDULED_AT,
    "test-token",
    { fetchImpl, sleep: async () => {} },
  );

  assert.equal(committed, false);
  assert.equal(responses.length, 0);
});

test("watchdog freshness boundary is 36 hours and invalid timestamps are stale", () => {
  const now = new Date("2026-08-26T14:17:00.000Z");
  assert.equal(backupIsStale("2026-08-25T02:17:00.000Z", now), false);
  assert.equal(backupIsStale("2026-08-25T02:16:59.999Z", now), true);
  assert.equal(backupIsStale("not-a-date", now), true);
});

test("the scheduled entrypoint performs the backup path locally", async () => {
  const fake = fakeDatabase();
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const methods: string[] = [];

  globalThis.fetch = async (_input, init) => {
    const method = init?.method ?? "GET";
    methods.push(method);
    if (method === "GET") return new Response("missing", { status: 404 });
    return jsonResponse({ commit: { sha: "scheduled-commit" } }, 201);
  };
  console.log = () => {};

  try {
    await scheduledBackup(
      { scheduledTime: Date.parse(SCHEDULED_AT) },
      { DB: fake.db, BACKUP_GITHUB_TOKEN: "test-token" },
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }

  assert.equal(fake.batchCalls(), 1);
  assert.deepEqual(methods, ["GET", "PUT"]);
});

function fakeDatabase(): {
  db: D1Database;
  batchCalls: () => number;
  preparedQueries: () => string[];
} {
  const queries: string[] = [];
  let batches = 0;

  const schemaRows = [
    {
      type: "table",
      name: "recipe",
      tbl_name: "recipe",
      sql: "CREATE TABLE recipe (id INTEGER PRIMARY KEY, source_text TEXT NOT NULL)",
    },
  ];
  const tableRows: Record<string, Record<string, unknown>[]> = {
    household: [{ id: 1, name: "Koti" }, { id: 2, name: "Naapuri" }],
    member: [{ id: 1, household_id: 1, display_name: "Eero" }],
    intake_job: [{
      id: "job-1",
      household_id: 1,
      created_by: 1,
      status: "failed",
      lease_id: null,
      source_route: "pasted",
      source_text: "Uunikaali",
      image_refs: null,
      draft_json: null,
      error_message: "Jäsennys epäonnistui.",
      created_at: "2026-08-25 00:00:00",
      updated_at: "2026-08-25 00:01:00",
    }],
    ingredient: [{ id: 1, name: "öljy" }],
    recipe: [
      {
        id: 1,
        household_id: 1,
        title: "Kaalilaatikko",
        source_text: "Kaalilaatikko\n½ dl öljyä",
      },
    ],
    recipe_share: [
      {
        recipe_id: 1,
        household_id: 2,
        shared_at: "2026-08-25 00:00:00",
        shared_by: 1,
      },
    ],
    recipe_step: [{ recipe_id: 1, position: 1, text: "Paista." }],
    ingredient_line: [
      {
        id: 1,
        recipe_id: 1,
        position: 1,
        quantity: 0.5,
        unit: "dl",
        source_line: "½ dl öljyä",
      },
    ],
    planned_batch: [{ id: 1, household_id: 1, recipe_id: 1, multiplier: 1, legacy_portions: null }],
    batch_occurrence: [
      { batch_id: 1, date: "2026-08-25", slot: "dinner" },
    ],
    pantry_entry: [
      { id: 1, household_id: 1, ingredient_id: 1, state: "unlimited" },
    ],
    recipe_preference: [
      { id: 1, household_id: 1, recipe_id: 1, default_multiplier: 1.5 },
    ],
    ingredient_product: [
      {
        id: 1,
        ingredient_id: 1,
        ean: "6415712506032",
        name: "Kotimaista rypsiöljy 500 ml",
        image_url:
          "https://cdn.s-cloud.fi/v1/w256_q75/product/ean/6415712506032_kuva1.jpg",
        package_quantity: 500,
        package_unit: "ml",
        position: 1,
      },
    ],
    recipe_ingredient_product: [
      {
        id: 1,
        household_id: 1,
        recipe_id: 1,
        ingredient_id: 1,
        ean: "6415712506049",
        name: "Keiton oma öljy 250 ml",
      },
    ],
  };

  const db = {
    prepare(query: string) {
      queries.push(query);
      return { __query: query };
    },
    async batch(statements: Array<{ __query: string }>) {
      batches += 1;
      return statements.map(({ __query }) => {
        const rows = __query.includes("FROM sqlite_schema")
          ? schemaRows
          : tableRows[
              BACKUP_TABLES.find(({ name }) =>
                __query.includes(`FROM ${name} `),
              )?.name ?? ""
            ] ?? [];
        return { results: rows, success: true, meta: {} };
      });
    },
  } as unknown as D1Database;

  return {
    db,
    batchCalls: () => batches,
    preparedQueries: () => queries,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
