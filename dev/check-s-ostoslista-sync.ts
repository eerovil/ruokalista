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
    assert.equal(first.sent, 0);
    assert.equal(first.failures.length, 1);
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
  // The budget this list used to break. Every call a Worker invocation makes
  // counts against one per-invocation ceiling — these and every D1 query alike
  // — and on this account's plan that ceiling is fifty. One list read, one add
  // per row and one push is 34, where two calls per row was 64 before a single
  // D1 query was counted, which is why it ran out in the twenties.
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

  assert.deepEqual(
    client.calls.filter((call) => call.kind === "add"),
    [
      { kind: "add", key: { ean: milk.ean }, quantity: 2 },
      { kind: "add", key: { note: "suola — 1 tl" }, quantity: null },
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

  assert.deepEqual(client.calls.filter((call) => call.kind === "add"), [
    { kind: "add", key: { ean: milk.ean }, quantity: 2 },
  ]);
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
      note: false,
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

test("a ceiling partway through keeps what already went (#308 review)", async () => {
  const fake = database();
  const client = new FakeClient();
  const timing = recordingWait();
  const ceiling = new SOstoslistaError(
    "S-ostoslista request failed: Too many subrequests by single Worker invocation.",
  );

  client.fail = (call) =>
    call.kind === "add" && "note" in call.key && call.key.note.startsWith("sokeri")
      ? ceiling
      : null;

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
  assert.equal(outcome.sent, 2);
  assert.deepEqual(timing.waits, []);
  // The two rows that did go are written down, so the next press skips them
  // rather than spending the same budget on them again.
  assert.deepEqual([...(await sentNotes(fake.db, 1)).keys()].sort(), ["1", "2"]);
  assert.equal(client.calls.some((call) => call.kind === "sync"), false);
});
