import assert from "node:assert/strict";
import test from "node:test";

import type { ProductChoice } from "../src/ingredient-products.ts";
import {
  sendToSOstoslista,
  type SOstoslistaSendItem,
  type SOstoslistaSyncClient,
} from "../src/s-ostoslista-sync.ts";
import { rememberSentNote, sentNotes } from "../src/s-ostoslista-notes.ts";
import { SOstoslistaError, type SOstoslistaKey } from "../src/s-ostoslista.ts";
import { migratedDatabase, type FakeD1 } from "./support/d1.ts";

type Call =
  | { kind: "add"; key: SOstoslistaKey; quantity: number | null }
  | { kind: "remove"; key: SOstoslistaKey }
  | { kind: "sync" };

class FakeClient implements SOstoslistaSyncClient {
  readonly calls: Call[] = [];
  fail: ((call: Call) => unknown | null) | null = null;

  async add(key: SOstoslistaKey, quantity: number | null = null): Promise<void> {
    const call: Call = { kind: "add", key, quantity };
    this.calls.push(call);
    this.maybeFail(call);
  }

  async remove(key: SOstoslistaKey): Promise<void> {
    const call: Call = { kind: "remove", key };
    this.calls.push(call);
    this.maybeFail(call);
  }

  async sync(): Promise<void> {
    const call: Call = { kind: "sync" };
    this.calls.push(call);
    this.maybeFail(call);
  }

  private maybeFail(call: Call): void {
    const error = this.fail?.(call) ?? null;
    if (error !== null) throw error;
  }
}

function database(): FakeD1 {
  const fake = migratedDatabase();
  fake.sql.exec("INSERT INTO household (id, name) VALUES (1, 'Koti')");
  return fake;
}

function product(ean: string, name = "Tuote"): ProductChoice {
  return {
    ean,
    name,
    imageUrl: null,
    packageQuantity: 400,
    packageUnit: "g",
  };
}

function item(
  key: string,
  name: string,
  total: string,
  chosen: SOstoslistaSendItem["chosen"] = [],
): SOstoslistaSendItem {
  return { key, name, total, chosen };
}

test("an unchanged text row is reasserted without deleting itself", async () => {
  const fake = database();
  const client = new FakeClient();
  await rememberSentNote(fake.db, 1, "1", "maito — 1 l");

  const outcome = await sendToSOstoslista(
    fake.db,
    1,
    client,
    [item("1", "maito", "1 l")],
  );

  assert.deepEqual(outcome, {
    status: "sent",
    sent: 1,
    total: 1,
    failures: [],
    synced: true,
  });
  assert.deepEqual(client.calls, [
    { kind: "add", key: { note: "maito — 1 l" }, quantity: null },
    { kind: "sync" },
  ]);
  assert.equal((await sentNotes(fake.db, 1)).get("1"), "maito — 1 l");
});

test("a changed text row is add-first, delete-old, remember-new", async () => {
  const fake = database();
  const client = new FakeClient();
  await rememberSentNote(fake.db, 1, "1", "maito — 1 l");

  const outcome = await sendToSOstoslista(
    fake.db,
    1,
    client,
    [item("1", "maito", "2 l")],
  );

  assert.equal(outcome.status, "sent");
  assert.deepEqual(client.calls, [
    { kind: "add", key: { note: "maito — 2 l" }, quantity: null },
    { kind: "remove", key: { note: "maito — 1 l" } },
    { kind: "sync" },
  ]);
  assert.equal((await sentNotes(fake.db, 1)).get("1"), "maito — 2 l");
});

test("one EAN is sent once with the aggregate packet count across rows", async () => {
  const fake = database();
  const client = new FakeClient();
  const milk = product("6415712506032", "Maito 400 g");

  const outcome = await sendToSOstoslista(fake.db, 1, client, [
    item("1", "maito", "800 g", [{ product: milk, count: 2 }]),
    item("1:r3", "maito", "1200 g", [{ product: milk, count: 3 }]),
  ]);

  assert.deepEqual(outcome, {
    status: "sent",
    sent: 2,
    total: 2,
    failures: [],
    synced: true,
  });
  assert.deepEqual(client.calls, [
    { kind: "add", key: { ean: "6415712506032" }, quantity: 5 },
    { kind: "sync" },
  ]);
});

test("product replacement keeps the old-note receipt until deletion succeeds", async () => {
  const fake = database();
  const client = new FakeClient();
  const milk = product("6415712506032", "Maito 400 g");
  await rememberSentNote(fake.db, 1, "1", "maito — 800 g");

  let failed = false;
  client.fail = (call) => {
    if (!failed && call.kind === "remove") {
      failed = true;
      return new Error("service unavailable");
    }
    return null;
  };

  const first = await sendToSOstoslista(
    fake.db,
    1,
    client,
    [item("1", "maito", "800 g", [{ product: milk, count: 2 }])],
  );
  assert.equal(first.status, "partial");
  if (first.status === "partial") {
    assert.equal(first.sent, 0);
    assert.equal(first.failures.length, 1);
    assert.equal(first.failures[0]?.permanent, true);
    assert.match(String(first.failures[0]?.message), /service unavailable/);
  }
  assert.equal((await sentNotes(fake.db, 1)).get("1"), "maito — 800 g");
  assert.equal(client.calls.some((call) => call.kind === "sync"), false);

  client.fail = null;
  client.calls.length = 0;
  const retried = await sendToSOstoslista(
    fake.db,
    1,
    client,
    [item("1", "maito", "800 g", [{ product: milk, count: 2 }])],
  );
  assert.equal(retried.status, "sent");
  assert.deepEqual(client.calls, [
    { kind: "add", key: { ean: "6415712506032" }, quantity: 2 },
    { kind: "remove", key: { note: "maito — 800 g" } },
    { kind: "sync" },
  ]);
  assert.equal((await sentNotes(fake.db, 1)).has("1"), false);
});

test("an already-missing remembered note is successful cleanup", async () => {
  const fake = database();
  const client = new FakeClient();
  await rememberSentNote(fake.db, 1, "1", "maito — 1 l");
  client.fail = (call) =>
    call.kind === "remove"
      ? new SOstoslistaError("gone", 404)
      : null;

  const outcome = await sendToSOstoslista(
    fake.db,
    1,
    client,
    [item("1", "maito", "2 l")],
  );

  assert.equal(outcome.status, "sent");
  assert.equal((await sentNotes(fake.db, 1)).get("1"), "maito — 2 l");
  assert.equal(client.calls.at(-1)?.kind, "sync");
});

test("a failed local receipt remains retryable after the external replacement", async () => {
  const fake = database();
  const client = new FakeClient();
  await rememberSentNote(fake.db, 1, "1", "maito — 1 l");

  fake.sql.exec(`
    CREATE TRIGGER fail_sent_note_receipt
    BEFORE INSERT ON s_ostoslista_sent_note
    WHEN NEW.note = 'maito — 2 l'
    BEGIN
      SELECT RAISE(ABORT, 'receipt write failed');
    END;
  `);

  const first = await sendToSOstoslista(
    fake.db,
    1,
    client,
    [item("1", "maito", "2 l")],
  );
  assert.equal(first.status, "partial");
  if (first.status === "partial") {
    assert.equal(first.sent, 0);
    assert.equal(first.failures.length, 1);
    assert.match(String(first.failures[0]?.message), /receipt write failed/);
  }
  assert.equal((await sentNotes(fake.db, 1)).get("1"), "maito — 1 l");
  assert.deepEqual(client.calls, [
    { kind: "add", key: { note: "maito — 2 l" }, quantity: null },
    { kind: "remove", key: { note: "maito — 1 l" } },
  ]);

  fake.sql.exec("DROP TRIGGER fail_sent_note_receipt");
  client.calls.length = 0;
  client.fail = (call) =>
    call.kind === "remove"
      ? new SOstoslistaError("already gone", 404)
      : null;

  const retried = await sendToSOstoslista(
    fake.db,
    1,
    client,
    [item("1", "maito", "2 l")],
  );
  assert.equal(retried.status, "sent");
  assert.deepEqual(client.calls, [
    { kind: "add", key: { note: "maito — 2 l" }, quantity: null },
    { kind: "remove", key: { note: "maito — 1 l" } },
    { kind: "sync" },
  ]);
  assert.equal((await sentNotes(fake.db, 1)).get("1"), "maito — 2 l");
});

test("a failed final phone push is a warning after a complete send", async () => {
  const fake = database();
  const client = new FakeClient();
  const failure = new Error("phone push failed");
  client.fail = (call) => call.kind === "sync" ? failure : null;

  const outcome = await sendToSOstoslista(
    fake.db,
    1,
    client,
    [item("1", "suola", "1 tl")],
  );

  assert.equal(outcome.status, "sent");
  if (outcome.status === "sent") {
    assert.equal(outcome.sent, 1);
    assert.equal(outcome.synced, false);
    if (!outcome.synced) assert.equal(outcome.syncError, failure);
  }
  assert.equal((await sentNotes(fake.db, 1)).get("1"), "suola — 1 tl");
});

/** No wall-clock in a unit test: the backoff is asserted on, not waited out. */
function recordingWait(): { waits: number[]; wait: (ms: number) => Promise<void> } {
  const waits: number[] = [];
  return {
    waits,
    wait: async (ms) => {
      waits.push(ms);
    },
  };
}

/** A list the size of the one #308 reported: 24 products and 8 written rows. */
function bigList(): SOstoslistaSendItem[] {
  const rows: SOstoslistaSendItem[] = [];
  for (let index = 0; index < 24; index += 1) {
    rows.push(
      item(`p${index}`, `tuote ${index}`, "400 g", [
        { product: product(`641000000${String(index).padStart(4, "0")}`), count: 1 },
      ]),
    );
  }
  for (let index = 0; index < 8; index += 1) {
    rows.push(item(`n${index}`, `aines ${index}`, `${index + 1} dl`));
  }
  return rows;
}

test("a 24-product, 8-text list goes in one send (#308)", async () => {
  const fake = database();
  const client = new FakeClient();

  const outcome = await sendToSOstoslista(fake.db, 1, client, bigList());

  assert.equal(outcome.status, "sent");
  assert.equal(outcome.sent, 32);
  assert.equal(outcome.total, 32);
  assert.deepEqual(outcome.failures, []);
  // One add per row and one push at the end, and nothing else: the send has no
  // per-row overhead left to blow a budget on.
  assert.equal(client.calls.filter((call) => call.kind === "add").length, 32);
  assert.equal(client.calls.filter((call) => call.kind === "sync").length, 1);
  assert.equal((await sentNotes(fake.db, 1)).size, 8);
});

test("a transient failure mid-send is retried and the send still completes (#308)", async () => {
  const fake = database();
  const client = new FakeClient();
  const timing = recordingWait();

  let refusals = 2;
  client.fail = (call) => {
    if (call.kind !== "add" || !("note" in call.key) || call.key.note !== "suola — 1 tl") {
      return null;
    }
    if (refusals === 0) return null;
    refusals -= 1;
    return new SOstoslistaError("service busy", 429);
  };

  const outcome = await sendToSOstoslista(
    fake.db,
    1,
    client,
    [
      item("1", "maito", "1 l"),
      item("2", "suola", "1 tl"),
      item("3", "sokeri", "2 dl"),
    ],
    { wait: timing.wait },
  );

  assert.equal(outcome.status, "sent");
  assert.equal(outcome.sent, 3);
  assert.deepEqual(timing.waits, [200, 600]);
  assert.equal(client.calls.at(-1)?.kind, "sync");
  assert.equal((await sentNotes(fake.db, 1)).size, 3);
});

test("a permanent refusal is recorded and the rows after it still go (#308)", async () => {
  const fake = database();
  const client = new FakeClient();
  const timing = recordingWait();
  const bad = product("6415712506032", "Maito 400 g");

  client.fail = (call) =>
    call.kind === "add" && "ean" in call.key && call.key.ean === bad.ean
      ? new SOstoslistaError("unknown product", 400)
      : null;

  const outcome = await sendToSOstoslista(
    fake.db,
    1,
    client,
    [
      item("1", "maito", "1 l", [{ product: bad, count: 1 }]),
      item("2", "suola", "1 tl"),
      item("3", "sokeri", "2 dl"),
    ],
    { wait: timing.wait },
  );

  assert.equal(outcome.status, "partial");
  assert.equal(outcome.sent, 2);
  assert.equal(outcome.total, 3);
  assert.deepEqual(outcome.status === "partial" ? outcome.failures : [], [
    {
      key: "1",
      name: "maito",
      note: false,
      permanent: true,
      status: 400,
      message: "unknown product",
    },
  ]);
  // Not retried, and not waited on: the service has already given its answer.
  assert.deepEqual(timing.waits, []);
  assert.equal(
    client.calls.filter((call) => call.kind === "add" && "ean" in call.key).length,
    1,
  );
  // The rows after the refusal are on the list, and the phone is not told the
  // list is ready while one row is still missing.
  assert.deepEqual([...(await sentNotes(fake.db, 1)).keys()].sort(), ["2", "3"]);
  assert.equal(client.calls.some((call) => call.kind === "sync"), false);
});

test("pressing send again after a partial adds nothing twice (#308)", async () => {
  const fake = database();
  const client = new FakeClient();
  const milk = product("6415712506032", "Maito 400 g");
  const rows = [
    item("1", "maito", "800 g", [{ product: milk, count: 2 }]),
    item("2", "suola", "1 tl"),
    item("3", "sokeri", "2 dl"),
  ];

  let refuse = true;
  client.fail = (call) =>
    refuse && call.kind === "add" && "note" in call.key && call.key.note === "sokeri — 2 dl"
      ? new SOstoslistaError("unknown row", 400)
      : null;

  const first = await sendToSOstoslista(fake.db, 1, client, rows, {
    wait: async () => {},
  });
  assert.equal(first.status, "partial");
  assert.equal(first.sent, 2);

  refuse = false;
  client.calls.length = 0;
  const second = await sendToSOstoslista(fake.db, 1, client, rows, {
    wait: async () => {},
  });

  assert.equal(second.status, "sent");
  assert.equal(second.sent, 3);
  // The retry re-asserts each row exactly once — the external add is keyed, so
  // the two that already went are the same rows again and not new ones — and it
  // deletes nothing, because no row's words changed between the two sends.
  assert.deepEqual(client.calls, [
    { kind: "add", key: { ean: "6415712506032" }, quantity: 2 },
    { kind: "add", key: { note: "suola — 1 tl" }, quantity: null },
    { kind: "add", key: { note: "sokeri — 2 dl" }, quantity: null },
    { kind: "sync" },
  ]);
  assert.deepEqual([...(await sentNotes(fake.db, 1)).keys()].sort(), ["2", "3"]);
});

test("the retry budget bounds what one outage costs (#308)", async () => {
  const fake = database();
  const client = new FakeClient();
  const timing = recordingWait();
  client.fail = (call) =>
    call.kind === "add" ? new SOstoslistaError("gateway down", 502) : null;

  const outcome = await sendToSOstoslista(fake.db, 1, client, bigList(), {
    wait: timing.wait,
  });

  assert.equal(outcome.status, "partial");
  assert.equal(outcome.sent, 0);
  assert.equal(outcome.total, 32);
  assert.equal(
    outcome.status === "partial" ? outcome.failures.length : 0,
    32,
    "every row is still attempted and still reported once the budget is gone",
  );
  assert.equal(timing.waits.length, 8, "the whole send retries at most eight times");
  assert.equal(client.calls.length, 40, "32 rows, 8 retries, and no phone push");
  assert.equal(
    outcome.status === "partial" && outcome.failures.every((one) => !one.permanent),
    true,
  );
});
