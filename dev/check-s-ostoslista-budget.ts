import assert from "node:assert/strict";
import test from "node:test";

import type { ProductChoice } from "../src/ingredient-products.ts";
import {
  sendToSOstoslista,
  type SOstoslistaSendItem,
} from "../src/s-ostoslista-sync.ts";
import { SOstoslistaClient } from "../src/s-ostoslista.ts";
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
 * The ceiling this has to stay under, and the headroom left for the request's
 * own work before the send begins.
 *
 * `POST /ostoslista/laheta` has already spent six D1 statements before
 * `sendToSOstoslista` is called at all: the member behind the session cookie
 * (`members.ts`), the fortnight's batches (`menu.ts::menuBetween`), the
 * ingredient lines and then the two product queries that follow them
 * (`shopping.ts::shoppingLinesFor`), and the cupboard
 * (`pantry.ts::pantryIngredientIds`). They come out of the same budget, so
 * this check pays for them rather than pretending the send starts from
 * nothing.
 *
 * *Around*, not merely before: a form post with no JavaScript is answered with
 * the whole screen re-rendered, and that used to re-derive the same list for
 * five more statements — on the ceiling path, after the budget had gone. It is
 * six rather than eleven because the re-render now draws from the state the
 * send already had. `dev/check-s-ostoslista-route.ts` is where that is proved
 * over the real route, end to end.
 */
const SUBREQUEST_CEILING = 50;
const SCREEN_QUERIES_AROUND_THE_SEND = 6;

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
  const client = new SOstoslistaClient(BASE, TOKEN, fetcher);

  const outcome = await sendToSOstoslista(fake.db, 1, client, items);

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

  await sendToSOstoslista(fake.db, 1, new SOstoslistaClient(BASE, TOKEN, fetcher), items);

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

test("a fresh list is the worst case, and it fits too (#308)", async () => {
  // Nothing on the service at all: every external row needs its creating POST,
  // which is the one call that cannot be avoided. This is the ceiling case.
  const fake = database();
  const { items } = reportedList();
  const { fetch: fetcher, calls } = service([]);

  const outcome = await sendToSOstoslista(
    fake.db,
    1,
    new SOstoslistaClient(BASE, TOKEN, fetcher),
    items,
  );

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
  await sendToSOstoslista(fake.db, 1, new SOstoslistaClient(BASE, TOKEN, first.fetch), items);

  const second = service(rows);
  const before = fake.subrequests();
  const outcome = await sendToSOstoslista(
    fake.db,
    1,
    new SOstoslistaClient(BASE, TOKEN, second.fetch),
    items,
  );

  assert.equal(outcome.status, "sent");
  assert.deepEqual(second.calls, ["GET items", "POST sync"]);
  assert.equal(
    fake.subrequests() - before,
    1,
    "only the read of what this household has out on the list",
  );
});
