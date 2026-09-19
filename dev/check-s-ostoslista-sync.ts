import assert from "node:assert/strict";
import test from "node:test";

import type { ProductChoice } from "../src/ingredient-products.ts";
import {
  sendToSOstoslista,
  type SOstoslistaSendItem,
  type SOstoslistaSyncClient,
} from "../src/s-ostoslista-sync.ts";
import { rememberSentNote, sentNotes } from "../src/s-ostoslista-notes.ts";
import {
  SOstoslistaError,
  type SOstoslistaItem,
  type SOstoslistaKey,
} from "../src/s-ostoslista.ts";
import { migratedDatabase, type FakeD1 } from "./support/d1.ts";

type Call =
  | { kind: "list" }
  | { kind: "add"; key: SOstoslistaKey; quantity: number | null }
  | { kind: "correct"; id: string; quantity: number | null }
  | { kind: "remove"; key: SOstoslistaKey }
  | { kind: "sync" };

class FakeClient implements SOstoslistaSyncClient {
  readonly calls: Call[] = [];
  fail: ((call: Call) => unknown | null) | null = null;
  /** What the service is already holding when a send opens. */
  held: SOstoslistaItem[] = [];

  async list(): Promise<SOstoslistaItem[]> {
    const call: Call = { kind: "list" };
    this.calls.push(call);
    this.maybeFail(call);
    return this.held;
  }

  async add(key: SOstoslistaKey, quantity: number | null = null): Promise<void> {
    const call: Call = { kind: "add", key, quantity };
    this.calls.push(call);
    this.maybeFail(call);
  }

  async correct(id: string, quantity: number | null = null): Promise<void> {
    const call: Call = { kind: "correct", id, quantity };
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
    { kind: "list" },
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
    { kind: "list" },
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
    { kind: "list" },
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
    assert.equal(first.failures[0]?.kind, "local");
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
    { kind: "list" },
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
    // The row reached the service; it is this app's note of it that was lost.
    // `sent` says how much got there, so it counts (#308 review).
    assert.equal(first.sent, 1);
    assert.equal(first.failures.length, 1);
    assert.equal(first.failures[0]?.kind, "local");
    assert.match(String(first.failures[0]?.message), /receipt write failed/);
  }
  assert.equal((await sentNotes(fake.db, 1)).get("1"), "maito — 1 l");
  assert.deepEqual(client.calls, [
    { kind: "list" },
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
    { kind: "list" },
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
  // One reconciliation call per row, one list read, one push — and no second
  // call for any row. This counts *this module's* calls, which is not the same
  // as counting subrequests: `SOstoslistaClient.add` can be two of those.
  // `dev/check-s-ostoslista-budget.ts` is where the real budget is asserted,
  // through the real client and a counting `fetch`; reading a number off this
  // fake and calling it a subrequest count is the mistake #308's review caught.
  assert.equal(client.calls.length, 34);
  assert.equal(client.calls.filter((call) => call.kind === "add").length, 32);
  assert.equal(client.calls.filter((call) => call.kind === "sync").length, 1);
  assert.equal((await sentNotes(fake.db, 1)).size, 8);
});

test("a second press only sends what is not on the list yet (#308)", async () => {
  // This is what makes "press it again" an honest thing to tell a member after
  // a send ran out of subrequests: the next press is not the same send over
  // again, it is the remainder. Here the service is already holding all but the
  // last two rows.
  const fake = database();
  const client = new FakeClient();
  const rows = bigList();
  client.held = rows.slice(0, 30).map((row, index) => ({
    id: `item-${index}`,
    name: row.chosen.length === 0 ? `${row.name} — ${row.total}` : row.name,
    ean: row.chosen[0]?.product.ean ?? null,
    collected: false,
    collectedStated: true,
    quantity: row.chosen.length === 0 ? null : 1,
  }));

  const outcome = await sendToSOstoslista(fake.db, 1, client, rows);

  assert.equal(outcome.status, "sent");
  assert.equal(outcome.sent, 32);
  assert.deepEqual(
    client.calls.filter((call) => call.kind === "add").length,
    2,
    "only the two rows the service was not already holding",
  );
});

test("a row the service holds but has ticked off is sent again (#236)", async () => {
  // The skip is not "is it there" but "is it there and still to be bought".
  // A row last week's trip ticked is exactly the bug #236 fixed, so it must
  // survive the shortcut that #308 added on top of it.
  const fake = database();
  const client = new FakeClient();
  const milk = product("6415712506032", "Maito 400 g");
  client.held = [
    {
      id: "item-1",
      name: "Maito 400 g",
      ean: milk.ean,
      collected: true,
      collectedStated: true,
      quantity: 2,
    },
    {
      id: "item-2",
      name: "suola — 1 tl",
      ean: null,
      // The service said nothing about this one, which is not evidence that
      // nobody has ticked it.
      collected: false,
      collectedStated: false,
      quantity: null,
    },
  ];

  await sendToSOstoslista(fake.db, 1, client, [
    item("1", "maito", "800 g", [{ product: milk, count: 2 }]),
    item("2", "suola", "1 tl"),
  ]);

  // One call each, straight at the id the list already gave us — not a keyed
  // POST asking to be told an id we were looking at, and then the same PATCH.
  assert.deepEqual(
    client.calls.filter((call) => call.kind !== "list" && call.kind !== "sync"),
    [
      { kind: "correct", id: "item-1", quantity: 2 },
      { kind: "correct", id: "item-2", quantity: null },
    ],
  );
});

test("a row the service holds at the wrong count is sent again (#240)", async () => {
  const fake = database();
  const client = new FakeClient();
  const milk = product("6415712506032", "Maito 400 g");
  client.held = [
    {
      id: "item-1",
      name: "Maito 400 g",
      ean: milk.ean,
      collected: false,
      collectedStated: true,
      quantity: 1,
    },
  ];

  await sendToSOstoslista(fake.db, 1, client, [
    item("1", "maito", "800 g", [{ product: milk, count: 2 }]),
  ]);

  assert.deepEqual(
    client.calls.filter((call) => call.kind !== "list" && call.kind !== "sync"),
    [{ kind: "correct", id: "item-1", quantity: 2 }],
  );
});

test("a list read that fails costs the send nothing but the shortcut (#308)", async () => {
  const fake = database();
  const client = new FakeClient();
  client.fail = (call) =>
    call.kind === "list" ? new SOstoslistaError("list unavailable", 500) : null;

  const outcome = await sendToSOstoslista(fake.db, 1, client, [
    item("1", "maito", "1 l"),
  ]);

  assert.equal(outcome.status, "sent");
  assert.equal(outcome.sent, 1);
  assert.deepEqual(client.calls, [
    { kind: "list" },
    { kind: "add", key: { note: "maito — 1 l" }, quantity: null },
    { kind: "sync" },
  ]);
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
      operation: { kind: "product", ean: bad.ean },
      kind: "refused",
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
    { kind: "list" },
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
  assert.equal(
    client.calls.length,
    41,
    "one list read, 32 rows, 8 retries, and no phone push",
  );
  assert.equal(
    outcome.status === "partial" &&
      outcome.failures.every((one) => one.kind === "unreachable"),
    true,
  );
});

test("the last retry in the budget is the last one taken (#308 review)", async () => {
  const fake = database();
  const client = new FakeClient();
  const timing = recordingWait();

  // Three rows that never come good spend two retries each, and the fourth
  // comes good on its first retry: seven. The fifth would ask for two, and
  // there is one left. Deciding a row's allowance up front instead of checking
  // the budget before each retry let that row take both, for nine.
  const alwaysBad = new Set(["1", "2", "3", "5"]);
  const onceBad = new Map([["4", 1]]);
  client.fail = (call) => {
    if (call.kind !== "add" || !("note" in call.key)) return null;
    const key = call.key.note.slice(0, 1);
    if (alwaysBad.has(key)) return new SOstoslistaError("busy", 429);
    const left = onceBad.get(key) ?? 0;
    if (left === 0) return null;
    onceBad.set(key, left - 1);
    return new SOstoslistaError("busy", 429);
  };

  const outcome = await sendToSOstoslista(
    fake.db,
    1,
    client,
    ["1", "2", "3", "4", "5", "6"].map((key) => item(key, key, "1 l")),
    { wait: timing.wait },
  );

  assert.equal(outcome.status, "partial");
  assert.equal(timing.waits.length, 8, "eight retries, and not a ninth");
  // Rows 1–3 took three attempts each, row 4 took two, row 5 got the one retry
  // the budget had left rather than the two its own allowance would have been,
  // and row 6 arrives with nothing to spend.
  const attempts = (key: string) =>
    client.calls.filter(
      (call) => call.kind === "add" && "note" in call.key && call.key.note.startsWith(key),
    ).length;
  assert.deepEqual(
    ["1", "2", "3", "4", "5", "6"].map(attempts),
    [3, 3, 3, 2, 2, 1],
  );
  assert.equal(outcome.sent, 2, "only rows 4 and 6 came good");
});

test("the subrequest ceiling is never retried or waited on (#308 review)", async () => {
  // It arrives status-less, which is what a dropped connection looks like, so
  // without the check at the top of the catch it took a row's whole allowance:
  // three attempts and 800 ms of backoff, all of it against a budget that had
  // already run out and does not come back by waiting.
  const fake = database();
  const client = new FakeClient();
  const timing = recordingWait();
  const ceiling = new SOstoslistaError(
    "S-ostoslista request failed: Too many subrequests by single Worker invocation.",
  );

  client.fail = (call) => (call.kind === "add" ? ceiling : null);

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

  assert.equal(outcome.status, "partial");
  assert.equal(outcome.status === "partial" && outcome.ceiling, true);
  assert.equal(outcome.sent, 0);
  assert.equal(outcome.total, 3);
  // The rows after it were never attempted, so they are not anybody's fault.
  assert.deepEqual(outcome.status === "partial" ? outcome.failures : null, []);
  assert.deepEqual(timing.waits, [], "nothing is waited on");
  assert.deepEqual(client.calls, [
    { kind: "list" },
    { kind: "add", key: { note: "maito — 1 l" }, quantity: null },
  ], "one attempt at the row that hit it, and nothing after it");
});

test("a ceiling is terminal, and keeps the progress it really made (#308 review)", async () => {
  // Two text rows go through, each queueing a receipt, and the third hits the
  // ceiling. What used to happen next: the receipt batch ran anyway into a
  // budget that was gone, failed, and its failure was charged back against
  // `sent` — so a send that had put two rows on the list could tell the member
  // "Mitään ei lähetetty".
  const fake = database();
  const client = new FakeClient();
  const timing = recordingWait();
  const ceiling = new SOstoslistaError(
    "S-ostoslista request failed: Too many subrequests by single Worker invocation.",
    null,
    "transport",
  );

  client.fail = (call) =>
    call.kind === "add" && "note" in call.key && call.key.note.startsWith("sokeri")
      ? ceiling
      : null;

  const rows = [
    item("1", "maito", "1 l"),
    item("2", "suola", "1 tl"),
    item("3", "sokeri", "2 dl"),
  ];

  const spentBefore = fake.subrequests();
  const outcome = await sendToSOstoslista(fake.db, 1, client, rows, {
    wait: timing.wait,
  });

  assert.equal(outcome.status, "partial");
  assert.equal(outcome.status === "partial" && outcome.ceiling, true);
  // The number the member is shown is the number of rows that got there.
  assert.equal(outcome.sent, 2);
  assert.equal(outcome.total, 3);
  assert.deepEqual(outcome.status === "partial" ? outcome.failures : null, []);
  assert.deepEqual(timing.waits, []);

  // Nothing at all after the ceiling: no receipt batch, no push.
  assert.equal(
    fake.subrequests() - spentBefore,
    1,
    "only the read of this household's sent notes, made before the ceiling",
  );
  assert.equal(client.calls.some((call) => call.kind === "sync"), false);
  assert.equal(
    client.calls.at(-1)?.kind,
    "add",
    "the send stops on the call that ran out",
  );

  // The receipts for the two rows that went are not written — deliberately.
  assert.equal((await sentNotes(fake.db, 1)).size, 0);

  // And that is safe, because the next press re-earns them. The service is now
  // holding the two rows, so they cost no external call at all, and this time
  // the batch runs.
  client.fail = null;
  client.held = [
    { id: "a", name: "maito — 1 l", ean: null, collected: false, collectedStated: true, quantity: null },
    { id: "b", name: "suola — 1 tl", ean: null, collected: false, collectedStated: true, quantity: null },
  ];
  client.calls.length = 0;

  const second = await sendToSOstoslista(fake.db, 1, client, rows);
  assert.equal(second.status, "sent");
  assert.equal(second.sent, 3);
  assert.deepEqual(
    client.calls.filter((call) => call.kind === "add"),
    [{ kind: "add", key: { note: "sokeri — 2 dl" }, quantity: null }],
    "only the row the first press never reached",
  );
  assert.deepEqual([...(await sentNotes(fake.db, 1)).keys()].sort(), ["1", "2", "3"]);
});

test("a refused old-note delete does not blame the product (#308 review)", async () => {
  // The product went on the list without complaint. What the service refused
  // was the DELETE of the text reminder that used to stand in for it. Reading
  // the row's shape to attribute that called it a refused product, and the
  // member was sent to check a product choice nothing was wrong with.
  const fake = database();
  const client = new FakeClient();
  const milk = product("6415712506032", "Maito 400 g");
  await rememberSentNote(fake.db, 1, "1", "maito — 800 g");

  client.fail = (call) =>
    call.kind === "remove"
      ? new SOstoslistaError("cannot delete", 400)
      : null;

  const outcome = await sendToSOstoslista(fake.db, 1, client, [
    item("1", "maito", "800 g", [{ product: milk, count: 2 }]),
  ]);

  assert.equal(outcome.status, "partial");
  const failure = outcome.status === "partial" ? outcome.failures[0] : null;
  assert.deepEqual(failure?.operation, { kind: "old-note", note: "maito — 800 g" });
  assert.equal(failure?.kind, "refused");
  assert.equal(failure?.status, 400);
  // The product really did go out, which is the whole reason blaming it was wrong.
  assert.deepEqual(
    client.calls.filter((call) => call.kind === "add"),
    [{ kind: "add", key: { ean: milk.ean }, quantity: 2 }],
  );
  // And the receipt is untouched, so the next send tries the deletion again.
  assert.equal((await sentNotes(fake.db, 1)).get("1"), "maito — 800 g");
});

test("a refused old-note delete on a changed text row is the same (#308 review)", async () => {
  const fake = database();
  const client = new FakeClient();
  await rememberSentNote(fake.db, 1, "1", "maito — 1 l");

  client.fail = (call) =>
    call.kind === "remove" ? new SOstoslistaError("no", 422) : null;

  const outcome = await sendToSOstoslista(fake.db, 1, client, [
    item("1", "maito", "2 l"),
  ]);

  assert.equal(outcome.status, "partial");
  const failure = outcome.status === "partial" ? outcome.failures[0] : null;
  assert.deepEqual(failure?.operation, { kind: "old-note", note: "maito — 1 l" });
  assert.equal(failure?.status, 422);
  // The new words were accepted before the old ones were refused, so this is
  // not "the row was not taken".
  assert.deepEqual(
    client.calls.filter((call) => call.kind === "add"),
    [{ kind: "add", key: { note: "maito — 2 l" }, quantity: null }],
  );
});

test("a row the service itself refuses is still attributed to the row (#308 review)", async () => {
  const fake = database();
  const client = new FakeClient();
  const milk = product("6415712506032", "Maito 400 g");
  client.fail = (call) =>
    call.kind === "add" ? new SOstoslistaError("unknown product", 400) : null;

  const outcome = await sendToSOstoslista(fake.db, 1, client, [
    item("1", "maito", "800 g", [{ product: milk, count: 2 }]),
    item("2", "suola", "1 tl"),
  ]);

  assert.equal(outcome.status, "partial");
  assert.deepEqual(
    outcome.status === "partial"
      ? outcome.failures.map((one) => one.operation)
      : null,
    [
      { kind: "product", ean: milk.ean },
      { kind: "note", note: "suola — 1 tl" },
    ],
  );
});

test("a malformed answer is not a connection error, and is not retried (#308 review)", async () => {
  // The service answered, with 200, and the body is not one this client can
  // act on. Every one of those used to arrive as a status-less error, which
  // read as a dropped connection: retried twice, two backoffs, the send's
  // retry budget spent, and the member told the network was at fault.
  const fake = database();
  const timing = recordingWait();
  const malformed = new SOstoslistaError(
    "Malformed S-ostoslista response: add response is missing id or name.",
    null,
    "response",
  );

  const client = new FakeClient();
  client.fail = (call) => (call.kind === "add" ? malformed : null);

  const outcome = await sendToSOstoslista(
    fake.db,
    1,
    client,
    [item("1", "maito", "1 l"), item("2", "suola", "1 tl")],
    { wait: timing.wait },
  );

  assert.equal(outcome.status, "partial");
  assert.deepEqual(timing.waits, [], "nothing is waited on");
  assert.equal(
    client.calls.filter((call) => call.kind === "add").length,
    2,
    "one attempt per row, not three",
  );
  const kinds = outcome.status === "partial"
    ? outcome.failures.map((one) => one.kind)
    : [];
  assert.deepEqual(kinds, ["malformed", "malformed"]);
});

test("an unreadable answer from a failing gateway is still transient (#308 review)", async () => {
  // The body being unreadable does not make a 502 something other than a 502.
  // Whether to try again is a question about the status, when there is one.
  const fake = database();
  const timing = recordingWait();
  let refusals = 1;
  const client = new FakeClient();
  client.fail = (call) => {
    if (call.kind !== "add" || refusals === 0) return null;
    refusals -= 1;
    return new SOstoslistaError(
      "S-ostoslista returned invalid JSON (502).",
      502,
      "response",
    );
  };

  const outcome = await sendToSOstoslista(
    fake.db,
    1,
    client,
    [item("1", "maito", "1 l")],
    { wait: timing.wait },
  );

  assert.equal(outcome.status, "sent");
  assert.deepEqual(timing.waits, [200]);
});

test("this app's own validation is local, and is never retried (#308 review)", async () => {
  const fake = database();
  const timing = recordingWait();
  const client = new FakeClient();
  client.fail = (call) =>
    call.kind === "add"
      ? new SOstoslistaError("quantity must be a whole number of at least 1, not 0.")
      : null;

  const outcome = await sendToSOstoslista(
    fake.db,
    1,
    client,
    [item("1", "maito", "1 l")],
    { wait: timing.wait },
  );

  assert.equal(outcome.status, "partial");
  assert.deepEqual(timing.waits, []);
  assert.equal(
    outcome.status === "partial" ? outcome.failures[0]?.kind : null,
    "local",
  );
});

test("a ceiling on the opening list read sends no row calls (#308 review)", async () => {
  // The list read used to be allowed to fail for any reason at all, on the
  // grounds that losing it only costs the shortcut. Running out of subrequests
  // is not that: there is no shortcut *and* no calls left, so every row would
  // spend one proving it.
  const fake = database();
  const client = new FakeClient();
  const timing = recordingWait();
  client.fail = (call) =>
    call.kind === "list"
      ? new SOstoslistaError(
          "S-ostoslista request failed: Too many subrequests by single Worker invocation.",
          null,
          "transport",
        )
      : null;

  const spentBefore = fake.subrequests();
  const outcome = await sendToSOstoslista(
    fake.db,
    1,
    client,
    [item("1", "maito", "1 l"), item("2", "suola", "1 tl")],
    { wait: timing.wait },
  );

  assert.equal(outcome.status, "partial");
  assert.equal(outcome.status === "partial" && outcome.ceiling, true);
  assert.equal(outcome.sent, 0);
  assert.equal(outcome.total, 2);
  assert.deepEqual(outcome.status === "partial" ? outcome.failures : null, []);
  assert.deepEqual(client.calls, [{ kind: "list" }]);
  assert.equal(fake.subrequests() - spentBefore, 1, "the sent-notes read, and nothing after");
  assert.deepEqual(timing.waits, []);
});

test("a ceiling on the receipt batch itself is the same answer (#308 review)", async () => {
  // Every row went out, and the call that ran out is the batch. The rows are
  // on the list, so `sent` says so, and the receipts wait for the next press
  // rather than being reported as rows that failed.
  const fake = database();
  const client = new FakeClient();
  const ceiling = new Error(
    "D1_ERROR: Too many subrequests by single Worker invocation.",
  );
  const realBatch = fake.db.batch.bind(fake.db);
  let batches = 0;
  fake.db.batch = (async (statements: D1PreparedStatement[]) => {
    batches += 1;
    throw ceiling;
    return realBatch(statements);
  }) as D1Database["batch"];

  const outcome = await sendToSOstoslista(fake.db, 1, client, [
    item("1", "maito", "1 l"),
    item("2", "suola", "1 tl"),
  ]);

  assert.equal(batches, 1);
  assert.equal(outcome.status, "partial");
  assert.equal(outcome.status === "partial" && outcome.ceiling, true);
  assert.equal(outcome.sent, 2, "both rows reached the service");
  assert.deepEqual(outcome.status === "partial" ? outcome.failures : null, []);
  assert.equal(client.calls.some((call) => call.kind === "sync"), false);
});
