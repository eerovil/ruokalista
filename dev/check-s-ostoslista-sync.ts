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
    assert.match(String(first.error), /service unavailable/);
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
    assert.match(String(first.error), /receipt write failed/);
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
