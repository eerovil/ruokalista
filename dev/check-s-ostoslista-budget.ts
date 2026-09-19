import assert from "node:assert/strict";
import test from "node:test";

import type { ProductChoice } from "../src/ingredient-products.ts";
import {
  sendToSOstoslista,
  type SOstoslistaSendItem,
} from "../src/s-ostoslista-sync.ts";
import { SOstoslistaClient } from "../src/s-ostoslista.ts";
import {
  SUBREQUEST_CEILING,
  SubrequestBudget,
  meteredFetch,
} from "../src/subrequests.ts";
import { rememberSentNote, sentNotes } from "../src/s-ostoslista-notes.ts";
import { migratedDatabase, type FakeD1 } from "./support/d1.ts";

/**
 * What one send of a normal shopping list actually costs a Worker invocation.
 *
 * This is the check #308 turned out to be about. Every outgoing call an
 * invocation makes comes out of one budget — each `fetch` and each D1
 * statement alike — and on this deployment's plan that budget is 50, which
 * `wrangler.jsonc` cannot raise. Production said so in as many words:
 *
 *   Too many subrequests by single Worker invocation.
 *
 * So this counts the two things the runtime counts, and nothing else. The
 * point is worth stating because the first attempt at this check did not: it
 * counted calls to a hand-written fake whose `add` was one call, while the
 * real `SOstoslistaClient.add` is a keyed POST *and* a PATCH whenever the row
 * came back ticked or holding last week's count — which is the ordinary state
 * of a list that gets re-sent every week, not an edge case. A fake cannot be
 * asked about that, so the real client is driven here through a counting
 * `fetch`, against a service double that behaves like the real one.
 *
 * For the same reason the list below is built out of external rows rather than
 * shopping rows. "24 tuotetta" counts rows on a screen, and one row can carry
 * two packet sizes — 700 g plus 400 g — which is two EANs and two calls.
 */

const BASE = "https://private.example/api/";
const TOKEN = "test-token";

/**
 * What the rest of the request costs, so these checks measure a whole
 * invocation rather than the send in isolation.
 *
 * Six D1 statements on the usual path: the member behind the session cookie,
 * the fortnight's batches, the ingredient lines and the two product queries
 * after them, and the cupboard. The route itself no longer counts them — it
 * meters the database instead, because the real number moves (a legacy
 * product's package-size backfill adds one, and `boundedInChunks` adds one per
 * chunk). This constant is the usual case, stated here so the arithmetic below
 * is a whole-request arithmetic; `dev/check-s-ostoslista-route.ts` is where the
 * moving part is proved.
 */
const SCREEN_QUERIES_AROUND_THE_SEND = 6;

/** Held back for the receipt batch, as `sendShoppingListForm` holds it back. */
const COMPLETION_TAIL = 1;

/** The send's own share, the way `sendShoppingListForm` works it out. */
function budget(): SubrequestBudget {
  return new SubrequestBudget(
    SUBREQUEST_CEILING - SCREEN_QUERIES_AROUND_THE_SEND,
    COMPLETION_TAIL,
  );
}

/**
 * The client as the route builds it: every request it makes spends the ledger
 * as it is made, which is the only accounting that cannot drift from the
 * runtime's (#308 review).
 */
function metered(fetcher: typeof fetch, ledger: SubrequestBudget): SOstoslistaClient {
  return new SOstoslistaClient(BASE, TOKEN, meteredFetch(ledger, fetcher));
}

interface Row {
  id: string;
  name: string;
  ean: string | null;
  collected: boolean;
  quantity: number | null;
}

/** Enough of the private service to answer the calls a send makes. */
function service(rows: Row[]): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  let next = rows.length + 1;

  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.slice(new URL(BASE).pathname.length);
    calls.push(`${method} ${path}`);
    const body = init?.body === undefined
      ? {}
      : (JSON.parse(String(init.body)) as Record<string, unknown>);

    if (method === "GET" && path === "items") {
      return Response.json({ items: rows });
    }
    if (method === "POST" && path === "sync") return new Response(null, { status: 204 });
    if (method === "POST" && path === "items") {
      const ean = typeof body["ean"] === "string" ? body["ean"] : null;
      const note = typeof body["note"] === "string" ? body["note"] : null;
      const quantity = typeof body["quantity"] === "number" ? body["quantity"] : null;
      // Keyed, exactly like the real service: a row that is already there
      // comes back as it stands, count and tick included. That is what makes
      // the POST+PATCH pair necessary whenever this path is taken at all.
      const existing = rows.find((row) =>
        ean !== null ? row.ean === ean : row.ean === null && row.name === note,
      );
      if (existing) return Response.json(existing);
      const created: Row = {
        id: `item-${next++}`,
        name: note ?? `Tuote ${ean}`,
        ean,
        collected: false,
        quantity,
      };
      rows.push(created);
      return Response.json(created, { status: 201 });
    }
    if (method === "PATCH" && path.startsWith("items/")) {
      const id = decodeURIComponent(path.slice("items/".length));
      const found = rows.find((row) => row.id === id);
      if (!found) return Response.json({ error: "not found" }, { status: 404 });
      if (typeof body["collected"] === "boolean") found.collected = body["collected"];
      if (typeof body["quantity"] === "number") found.quantity = body["quantity"];
      return Response.json(found);
    }
    if (method === "DELETE" && path === "items") {
      return Response.json({ deleted: [] });
    }
    return Response.json({ error: "unexpected" }, { status: 400 });
  };

  return { fetch: fetcher as unknown as typeof fetch, calls };
}

function database(): FakeD1 {
  const fake = migratedDatabase();
  fake.sql.exec("INSERT INTO household (id, name) VALUES (1, 'Koti')");
  return fake;
}

function product(ean: string, quantity: number, unit: string): ProductChoice {
  return {
    ean,
    name: `Tuote ${ean}`,
    imageUrl: null,
    packageQuantity: quantity,
    packageUnit: unit,
  };
}

function ean(index: number): string {
  return `641000000${String(index).padStart(4, "0")}`;
}

/**
 * The list #308 reported: 24 product rows and 8 written reminders.
 *
 * One product row carries two packet sizes, because `planPackages` really does
 * cover 1100 g with a 700 g and a 400 g packet, and that is two external rows
 * out of one row on the screen. Counting shopping rows would have hidden it.
 */
function reportedList(): { items: SOstoslistaSendItem[]; eans: string[] } {
  const items: SOstoslistaSendItem[] = [];
  const eans: string[] = [];

  items.push({
    key: "p0",
    name: "jauheliha",
    total: "1100 g",
    chosen: [
      { product: product(ean(0), 700, "g"), count: 1 },
      { product: product(ean(100), 400, "g"), count: 1 },
    ],
  });
  eans.push(ean(0), ean(100));

  for (let index = 1; index < 24; index += 1) {
    items.push({
      key: `p${index}`,
      name: `tuote ${index}`,
      total: "400 g",
      chosen: [{ product: product(ean(index), 400, "g"), count: 2 }],
    });
    eans.push(ean(index));
  }
  for (let index = 0; index < 8; index += 1) {
    items.push({
      key: `n${index}`,
      name: `aines ${index}`,
      total: `${index + 1} dl`,
      chosen: [],
    });
  }
  return { items, eans };
}

function wanted(item: SOstoslistaSendItem): { key: string; quantity: number | null } {
  return item.chosen.length === 0
    ? { key: `${item.name} — ${item.total}`, quantity: null }
    : { key: item.chosen[0]!.product.ean, quantity: item.chosen[0]!.count };
}

test("a re-used 24+8 list stays inside one invocation's subrequest budget (#308)", async () => {
  const fake = database();
  const { items, eans } = reportedList();

  // The state a household is actually in: last week's trip is still on the
  // list, and ten of those rows are either ticked off or holding the count
  // that trip needed. Each of those used to be a POST purely to be handed back
  // a row we could already see, and then the PATCH that did the work.
  const rows: Row[] = [];
  for (let index = 0; index < 6; index += 1) {
    rows.push({
      id: `old-${index}`,
      name: `Tuote ${eans[index]}`,
      ean: eans[index]!,
      collected: true,
      quantity: 1,
    });
  }
  for (let index = 6; index < 10; index += 1) {
    rows.push({
      id: `old-${index}`,
      name: `Tuote ${eans[index]}`,
      ean: eans[index]!,
      collected: false,
      // Right row, last week's count.
      quantity: 1,
    });
  }

  const { fetch: fetcher, calls } = service(rows);
  const ledger = budget();

  const outcome = await sendToSOstoslista(fake.db, 1, metered(fetcher, ledger), items, {
    budget: ledger,
  });

  assert.equal(outcome.status, "sent");
  assert.equal(outcome.sent, 32);

  const http = calls.length;
  const d1 = fake.subrequests();
  const total = http + d1 + SCREEN_QUERIES_AROUND_THE_SEND;

  assert.ok(
    total <= SUBREQUEST_CEILING,
    `a normal list must fit: ${http} fetch + ${d1} D1 + ` +
      `${SCREEN_QUERIES_AROUND_THE_SEND} for the screen = ${total}, ceiling ${SUBREQUEST_CEILING}`,
  );
  // Written down rather than merely bounded, so a change that eats the
  // headroom has to say so here instead of drifting quietly up to 50. Before
  // an already-held row could be corrected in place this same list cost 53.
  assert.equal(total, 43, "one list read, 33 rows, one push, two D1 trips");

  // Where those calls went: one list read, one call per external row that
  // needed one, one push. Ten already-held rows cost ten PATCHes and no POSTs
  // at all — that is the halving the review asked for, and it is the reason
  // the number above fits.
  assert.equal(calls.filter((call) => call === "GET items").length, 1);
  assert.equal(calls.filter((call) => call === "POST sync").length, 1);
  // 25 product rows and 8 notes is 33 external rows; ten of them were already
  // there, so 23 need creating.
  assert.equal(calls.filter((call) => call === "POST items").length, 23);
  assert.equal(
    calls.filter((call) => call.startsWith("PATCH items/")).length,
    10,
    "the ten rows the service already held, corrected in place",
  );
  // 24 rows on the screen, 25 external product rows: the multi-packet row is
  // two EANs. Counting rows would have missed one call.
  assert.equal(new Set(eans).size, 25);
});

test("every row really is buyable at this trip's count afterwards (#236, #240)", async () => {
  // The budget must not have been bought with a weaker guarantee: whatever
  // route a row took — untouched, corrected, or created — it ends up the same.
  const fake = database();
  const { items, eans } = reportedList();
  const rows: Row[] = [
    { id: "old-0", name: `Tuote ${eans[0]}`, ean: eans[0]!, collected: true, quantity: 9 },
    { id: "old-1", name: `Tuote ${eans[1]}`, ean: eans[1]!, collected: false, quantity: 9 },
    {
      id: "old-2",
      name: "aines 0 — 1 dl",
      ean: null,
      collected: true,
      quantity: null,
    },
  ];
  const { fetch: fetcher } = service(rows);

  const ledger = budget();
  await sendToSOstoslista(fake.db, 1, metered(fetcher, ledger), items, {
    budget: ledger,
  });

  for (const item of items) {
    const want = wanted(item);
    const held = rows.filter((row) =>
      item.chosen.length === 0
        ? row.ean === null && row.name === want.key
        : row.ean === want.key,
    );
    assert.equal(held.length, 1, `${item.key} is on the list exactly once`);
    assert.equal(held[0]?.collected, false, `${item.key} is still to be bought`);
    if (want.quantity !== null) {
      assert.equal(held[0]?.quantity, want.quantity, `${item.key} holds this trip's count`);
    }
  }
});

test("a fresh list fits, though it is not the worst case (#308)", async () => {
  // Nothing on the service at all: every external row needs its creating POST.
  // This was once described here as the worst case, which was wrong — a fresh
  // list has no old text rows to delete, and it is the recurring list, with a
  // DELETE per changed reminder, that costs the most. The test below is that
  // one.
  const fake = database();
  const { items } = reportedList();
  const { fetch: fetcher, calls } = service([]);

  const ledger = budget();
  const outcome = await sendToSOstoslista(fake.db, 1, metered(fetcher, ledger), items, {
    budget: ledger,
  });

  assert.equal(outcome.status, "sent");
  const total = calls.length + fake.subrequests() + SCREEN_QUERIES_AROUND_THE_SEND;
  assert.ok(
    total <= SUBREQUEST_CEILING,
    `a fresh list must fit: ${calls.length} fetch + ${fake.subrequests()} D1 + ` +
      `${SCREEN_QUERIES_AROUND_THE_SEND} for the screen = ${total}`,
  );
  // A row the service creates comes back exactly as asked for, so no PATCH
  // follows it. That is what makes the worst case one call per row.
  assert.equal(calls.filter((call) => call.startsWith("PATCH")).length, 0);
});

test("a second press after a full send costs almost nothing (#308)", async () => {
  // What makes "press it again" honest after the ceiling stops a send: the
  // next press pays for the list read and the push, and nothing else.
  const fake = database();
  const { items } = reportedList();
  const rows: Row[] = [];
  const first = service(rows);
  const firstLedger = budget();
  await sendToSOstoslista(fake.db, 1, metered(first.fetch, firstLedger), items, {
    budget: firstLedger,
  });

  const second = service(rows);
  const before = fake.subrequests();
  const secondLedger = budget();
  const outcome = await sendToSOstoslista(fake.db, 1, metered(second.fetch, secondLedger), items, {
    budget: secondLedger,
  });

  assert.equal(outcome.status, "sent");
  assert.deepEqual(second.calls, ["GET items", "POST sync"]);
  assert.equal(
    fake.subrequests() - before,
    1,
    "only the read of what this household has out on the list",
  );
});

/**
 * The state a household is actually in on an ordinary Tuesday.
 *
 * Last week's send is still on the phone, and this week the amounts moved. A
 * text row whose amount changed needs the new words put on the list *and* last
 * week's words taken off, so each of the eight is two calls, not one — and a
 * product row that used to go as text has a DELETE of its own on top of the
 * product. None of that exists on a fresh list, which is why calling the fresh
 * list the worst case was wrong.
 *
 * Arithmetic the reviewer did, and this reproduces: 6 for the screen, 1 for
 * the sent notes, 1 for the list read, 33 external rows, 8 old-note deletes
 * and the receipt batch is 50 exactly — leaving the phone push as the 51st
 * call. Add one transient retry, or one product row with an old text receipt,
 * and the wall arrives while rows are still unsent.
 */
function lastWeeksNotes(items: SOstoslistaSendItem[]): Array<[string, string]> {
  return items
    .filter((item) => item.chosen.length === 0)
    .map((item) => [item.key, `${item.name} — viime viikon määrä`]);
}

test("a recurring list with eight changed reminders fits in one press (#308 review)", async () => {
  const fake = database();
  const { items } = reportedList();

  // Every text row carries last week's exact wording, and it is not this
  // week's, so every one owes a DELETE as well as an add.
  for (const [key, note] of lastWeeksNotes(items)) {
    await rememberSentNote(fake.db, 1, key, note);
  }

  const spentBefore = fake.subrequests();
  const { fetch: fetcher, calls } = service([]);
  const ledger = budget();
  const outcome = await sendToSOstoslista(fake.db, 1, metered(fetcher, ledger), items, {
    budget: ledger,
  });

  const http = calls.length;
  const d1 = fake.subrequests() - spentBefore;
  const total = http + d1 + SCREEN_QUERIES_AROUND_THE_SEND;

  // Exactly the reviewer's arithmetic: 6 + 1 + 1 + 33 + 8 + 1. The push would
  // have been the 51st call, so it is the one thing given up — every row is on
  // the list and every receipt is written.
  assert.equal(total, SUBREQUEST_CEILING);
  assert.equal(outcome.status, "sent");
  assert.equal(outcome.sent, 32);
  assert.equal(outcome.status === "sent" && outcome.synced, false);
  assert.equal(calls.filter((call) => call === "POST sync").length, 0);
  assert.equal(
    calls.filter((call) => call.startsWith("DELETE items")).length,
    8,
    "last week's wording really is taken off, not just overwritten",
  );
  assert.equal((await sentNotes(fake.db, 1)).size, 8, "the reserved tail still runs");
});

test("one deletion more than fits stops at a row, and the next press finishes it (#308 review)", async () => {
  // The extra cost the reviewer named: a product row that used to go as text
  // and still owes a DELETE. That is the 51st call, so it does not fit — and
  // the answer is to stop cleanly at a row boundary, not to start an operation
  // that cannot land.
  const fake = database();
  const { items } = reportedList();
  for (const [key, note] of lastWeeksNotes(items)) {
    await rememberSentNote(fake.db, 1, key, note);
  }
  await rememberSentNote(fake.db, 1, "p3", "tuote 3 — viime viikon määrä");

  const rows: Row[] = [];
  const first = service(rows);
  const spentBefore = fake.subrequests();
  const firstLedger = budget();
  const outcome = await sendToSOstoslista(fake.db, 1, metered(first.fetch, firstLedger), items, {
    budget: firstLedger,
  });

  const total = first.calls.length + (fake.subrequests() - spentBefore) +
    SCREEN_QUERIES_AROUND_THE_SEND;
  assert.ok(
    total <= SUBREQUEST_CEILING,
    `the stopping case must not overspend: ${total} > ${SUBREQUEST_CEILING}`,
  );
  assert.equal(outcome.status, "partial");
  assert.equal(outcome.status === "partial" && outcome.ceiling, true);
  assert.equal(outcome.sent, 31, "one row short, and it is a whole row");
  assert.deepEqual(
    outcome.status === "partial" ? outcome.failures : null,
    [],
    "nothing failed; there was simply no room left",
  );
  // The rows that went are written down, because the tail was reserved.
  assert.ok((await sentNotes(fake.db, 1)).size > 0);

  // The second press. The service is holding everything the first sent, so
  // those rows cost nothing and the rest goes.
  const second = service(rows);
  const secondLedger = budget();
  const resumed = await sendToSOstoslista(fake.db, 1, metered(second.fetch, secondLedger), items, {
    budget: secondLedger,
  });

  assert.equal(resumed.status, "sent");
  assert.equal(resumed.sent, 32);
  const keys = rows.map((row) => row.ean ?? row.name);
  assert.equal(new Set(keys).size, keys.length, "no row on the list twice");
  assert.equal(
    rows.every((row) => row.collected === false),
    true,
    "and every one of them still to be bought",
  );
});

test("a transient retry is priced before it is taken (#308 review)", async () => {
  // A retry is another call out of the same allowance. It is re-planned and
  // re-claimed, so it cannot quietly borrow against the reserved tail — the
  // send either affords it or stops at a row.
  const fake = database();
  const { items } = reportedList();
  for (const [key, note] of lastWeeksNotes(items)) {
    await rememberSentNote(fake.db, 1, key, note);
  }

  const rows: Row[] = [];
  const inner = service(rows);
  let stumbled = false;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (!stumbled && method === "POST" && String(input).endsWith("/items")) {
      stumbled = true;
      return Response.json({ error: "busy" }, { status: 429 });
    }
    return inner.fetch(input, init);
  }) as typeof fetch;

  const spentBefore = fake.subrequests();
  const ledger = budget();
  const outcome = await sendToSOstoslista(fake.db, 1, metered(fetcher, ledger), items, {
    budget: ledger,
    wait: async () => {},
  });

  const total = inner.calls.length + (fake.subrequests() - spentBefore) +
    SCREEN_QUERIES_AROUND_THE_SEND;
  assert.ok(
    total <= SUBREQUEST_CEILING,
    `the retry must be inside the budget too: ${total} > ${SUBREQUEST_CEILING}`,
  );
  // The retry itself happened — the 429 was ridden out, not reported.
  assert.equal(stumbled, true);
  assert.equal(
    outcome.status === "partial" ? outcome.failures.length : 0,
    0,
    "a transient stumble is not a failed row",
  );
});

/**
 * The service answering the list read with a transient 5xx, once.
 *
 * This is the shape that broke the ledger's unit. The send carries on without
 * the shortcut, so `held` is empty — but the service is still holding last
 * week's rows, so the next keyed `POST` lands on one of them and
 * `SOstoslistaClient.add` needs its `PATCH` as well. Two real subrequests for
 * something the planner had called one.
 */
function refusingTheListRead(rows: Row[]): { fetch: typeof fetch; calls: string[] } {
  const inner = service(rows);
  let refused = false;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (!refused && method === "GET" && String(input).endsWith("/items")) {
      refused = true;
      inner.calls.push("GET items");
      return Response.json({ error: "busy" }, { status: 503 });
    }
    return inner.fetch(input, init);
  }) as typeof fetch;
  return { fetch: fetcher, calls: inner.calls };
}

/** Last week's trip, still on the service: ticked, and at last week's count. */
function staleRows(eans: string[]): Row[] {
  return eans.map((code, index) => ({
    id: `old-${index}`,
    name: `Tuote ${code}`,
    ean: code,
    collected: true,
    quantity: 1,
  }));
}

test("a failed list read cannot make the send overspend (#308 review)", async () => {
  // The repro, with the real client. Every POST that finds a stale row costs a
  // PATCH too, and the ledger has to see both — otherwise the planner waves
  // rows through and the runtime stops the send mid-call.
  const fake = database();
  const { items, eans } = reportedList();
  const rows = staleRows(eans);
  const { fetch: fetcher, calls } = refusingTheListRead(rows);

  const ledger = budget();
  const spentBefore = fake.subrequests();
  const outcome = await sendToSOstoslista(fake.db, 1, metered(fetcher, ledger), items, {
    budget: ledger,
    wait: async () => {},
  });

  const http = calls.length;
  const d1 = fake.subrequests() - spentBefore;
  const total = http + d1 + SCREEN_QUERIES_AROUND_THE_SEND;

  assert.ok(
    total <= SUBREQUEST_CEILING,
    `a guessed list must not overspend: ${http} fetch + ${d1} D1 + ` +
      `${SCREEN_QUERIES_AROUND_THE_SEND} for the screen = ${total}, ceiling ${SUBREQUEST_CEILING}`,
  );

  // The pairs really did happen — this is not passing because the situation
  // failed to arise.
  const posts = calls.filter((call) => call === "POST items").length;
  const patches = calls.filter((call) => call.startsWith("PATCH items/")).length;
  assert.ok(patches > 0, "stale rows really did need their PATCH");
  assert.ok(posts > 0);

  // It stops short rather than over-spending, and says so honestly.
  assert.equal(outcome.status, "partial");
  assert.equal(outcome.status === "partial" && outcome.ceiling, true);
  assert.deepEqual(
    outcome.status === "partial" ? outcome.failures : null,
    [],
    "nothing failed; there was simply not enough allowance",
  );
  assert.ok(outcome.sent > 0, "and it does send what it can afford");

  // Every row it did send is on the list, still to be bought, at this week's
  // count — the budget was not bought by weakening #236/#240.
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const { product, count } of item.chosen) {
      counts.set(product.ean, (counts.get(product.ean) ?? 0) + count);
    }
  }
  const touched = rows.filter((row) => !row.collected);
  assert.ok(touched.length > 0, "some stale rows really were put right");
  for (const row of touched) {
    assert.equal(row.quantity, counts.get(row.ean ?? ""), `${row.ean} holds this week's count`);
  }
});

test("the next press, with the list read working, finishes it (#308 review)", async () => {
  const fake = database();
  const { items, eans } = reportedList();
  const rows = staleRows(eans);

  const blind = refusingTheListRead(rows);
  const blindLedger = budget();
  const first = await sendToSOstoslista(fake.db, 1, metered(blind.fetch, blindLedger), items, {
    budget: blindLedger,
    wait: async () => {},
  });
  assert.equal(first.status, "partial");

  // Second press: the read works, so every row is priced at what it really
  // costs and the rest goes.
  let presses = 1;
  let outcome = first;
  while (outcome.status === "partial" && presses < 5) {
    presses += 1;
    const again = service(rows);
    const ledger = budget();
    const spentBefore = fake.subrequests();
    outcome = await sendToSOstoslista(fake.db, 1, metered(again.fetch, ledger), items, {
      budget: ledger,
      wait: async () => {},
    });
    const total = again.calls.length + (fake.subrequests() - spentBefore) +
      SCREEN_QUERIES_AROUND_THE_SEND;
    assert.ok(total <= SUBREQUEST_CEILING, `press ${presses} spent ${total}`);
  }

  assert.equal(outcome.status, "sent");
  assert.equal(outcome.sent, 32);
  // Idempotent across every press: one row per key, all still to be bought.
  const keys = rows.map((row) => row.ean ?? row.name);
  assert.equal(new Set(keys).size, keys.length, "no row on the list twice");
  assert.equal(rows.every((row) => row.collected === false), true);
});

/**
 * A service that creates the row it is asked for but will not say whether it
 * is ticked.
 *
 * `dev/check-s-ostoslista.ts` covers this as a supported answer, and it is the
 * case that makes a create two subrequests even when the list read was
 * trustworthy and said the row was absent: the POST lands, the answer states
 * nothing, and #236's unconditional clear goes out after it.
 */
function silentAboutCollected(): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  let next = 1;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(String(input)).pathname.slice(new URL(BASE).pathname.length);
    calls.push(`${method} ${path}`);
    if (method === "GET" && path === "items") return Response.json({ items: [] });
    if (method === "POST" && path === "items") {
      // Created, but saying nothing about `collected` or `quantity`.
      return Response.json({ id: `item-${next++}`, name: "x", ean: null }, { status: 201 });
    }
    if (method === "PATCH") {
      return Response.json({ id: "item-1", name: "x", ean: null, collected: false });
    }
    return Response.json({ error: "unexpected" }, { status: 400 });
  }) as typeof fetch;
  return { fetch: fetcher, calls };
}

/** One text row, and a ledger sized so the send has `slots` ordinary calls. */
async function sendWithSlots(slots: number): Promise<{
  outcome: Awaited<ReturnType<typeof sendToSOstoslista>>;
  calls: string[];
}> {
  const fake = database();
  // One for the sent-notes read, one for the list read, one held back for the
  // receipt batch, and `slots` left for the row itself.
  const ledger = new SubrequestBudget(slots + 3, 1);
  const { fetch: fetcher, calls } = silentAboutCollected();
  const outcome = await sendToSOstoslista(
    fake.db,
    1,
    metered(fetcher, ledger),
    [{ key: "1", name: "maito", total: "1 l", chosen: [] }],
    { budget: ledger, wait: async () => {} },
  );
  return { outcome, calls };
}

test("a create is not begun on one slot when it may need two (#308 review)", async () => {
  // The row the GET says is absent still costs two: this service does not say
  // whether what it created is ticked, so #236's clear follows the POST. With
  // one slot the row must not start at all — starting it would put the row on
  // the list and then be refused the call that makes it buyable, which is the
  // half-done state #236 exists to prevent.
  const { outcome, calls } = await sendWithSlots(1);

  assert.equal(calls.filter((call) => call === "POST items").length, 0, "never begun");
  assert.deepEqual(calls, ["GET items"]);
  assert.equal(outcome.status, "partial");
  assert.equal(outcome.status === "partial" && outcome.ceiling, true);
  assert.equal(outcome.sent, 0);
  assert.deepEqual(outcome.status === "partial" ? outcome.failures : null, []);
});

test("the same row goes when both of its calls fit (#308 review)", async () => {
  const { outcome, calls } = await sendWithSlots(2);

  assert.equal(outcome.status, "sent");
  assert.equal(outcome.sent, 1);
  assert.equal(calls.filter((call) => call === "POST items").length, 1);
  assert.equal(
    calls.filter((call) => call.startsWith("PATCH")).length,
    1,
    "the pair this service really needs",
  );
});
