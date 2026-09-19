import assert from "node:assert/strict";
import test from "node:test";

import { today } from "../src/dates.ts";
import type { Env } from "../src/env.ts";
import type { Member } from "../src/members.ts";
import type { RouteContext } from "../src/router.ts";
import { sendShoppingListForm } from "../src/shopping-screens.ts";
import { migratedDatabase, type FakeD1 } from "./support/d1.ts";

/**
 * `POST /ostoslista/laheta` as a browser with no JavaScript reaches it.
 *
 * That path matters on its own because it answers with a whole re-rendered
 * screen rather than a line of JSON, and drawing the screen costs D1 — out of
 * the same per-invocation subrequest budget the send has just been spending.
 * The case this is written for is the worst one: the send runs out of
 * subrequests, and the answer that has to explain that is itself a page the
 * Worker still has to build. If building it asks for one more statement, the
 * member gets a crash instead of the sentence telling them to press the button
 * again (#308 review).
 *
 * The form works without JavaScript by standing requirement (#65), so this is
 * checked at the route rather than at the send.
 */

/**
 * The base `product-picker.ts::externalClient` uses for a *bound* service, and
 * it has to be the bound path: setting `SOSTOSLISTA_SERVICE_URL` instead makes
 * the client ignore the binding and reach for the global `fetch`, which in a
 * check means a real network call to a host that is not there.
 */
const BASE = "https://s-ostoslista-worker.invalid/";

/** What the runtime says when an invocation has spent its budget. */
const CEILING = "Too many subrequests by single Worker invocation.";

function seeded(): FakeD1 {
  const fake = migratedDatabase();
  const day = today();
  fake.sql.exec(`
    INSERT INTO household (id, name) VALUES (1, 'Koti');
    INSERT INTO member (id, household_id, google_sub, display_name)
      VALUES (1, 1, 'sub-1', 'Eero');
    INSERT INTO recipe (id, household_id, title, source_text, created_by, updated_by)
      VALUES (1, 1, 'Kaalilaatikko', 'lähde', 1, 1);
    INSERT INTO ingredient (id, name, created_by) VALUES
      (1, 'maito', 1), (2, 'suola', 1), (3, 'riisi', 1);
    INSERT INTO ingredient_line
      (recipe_id, position, quantity, unit, ingredient_id, source_line) VALUES
      (1, 1, 5, 'dl', 1, '5 dl maitoa'),
      (1, 2, 1, 'tl', 2, '1 tl suolaa'),
      (1, 3, 2, 'dl', 3, '2 dl riisiä');
    INSERT INTO planned_batch (id, household_id, recipe_id, created_by, instance_key)
      VALUES (1, 1, 1, 1, 'batch-1');
    INSERT INTO batch_occurrence (batch_id, date, slot)
      VALUES (1, '${day}', 'dinner');
  `);
  return fake;
}

const member: Member = {
  id: 1,
  householdId: 1,
  displayName: "Eero",
  isAdmin: false,
} as Member;

/**
 * A service that answers every call with the runtime's own out-of-subrequests
 * failure, the way a `fetch` does once the budget is gone: a rejected promise,
 * with no status and no response to read.
 */
function exhausted(after: number): { fetch: typeof fetch; calls: number } {
  const state = { calls: 0 };
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    state.calls += 1;
    if (state.calls > after) throw new Error(CEILING);
    const url = new URL(String(input));
    const path = url.pathname.slice(new URL(BASE).pathname.length);
    if ((init?.method ?? "GET") === "GET" && path === "items") {
      return Response.json({ items: [] });
    }
    return Response.json(
      { id: `item-${state.calls}`, name: "x", ean: null, collected: false },
      { status: 201 },
    );
  };
  return {
    fetch: fetcher as unknown as typeof fetch,
    get calls() {
      return state.calls;
    },
  };
}

/**
 * A database that stops answering once the invocation's budget is gone.
 *
 * `migratedDatabase()` keeps working however many statements it is given,
 * which is right for every other check and wrong for this one: the whole
 * question here is what happens to code that asks for one more statement after
 * the runtime has stopped granting them. Without this the re-render would
 * quietly succeed in the check and crash in production.
 */
function refusingAfterCeiling(db: D1Database, exhausted: () => boolean): D1Database {
  const guard = <T>(run: () => T): T => {
    if (exhausted()) throw new Error(CEILING);
    return run();
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const real = statement as unknown as Record<string, (...args: unknown[]) => unknown>;
    return new Proxy(statement, {
      get(_target, key: string) {
        if (key === "bind") {
          return (...args: unknown[]) =>
            wrap(real["bind"]!(...args) as D1PreparedStatement);
        }
        if (key === "first" || key === "all" || key === "run" || key === "raw") {
          return (...args: unknown[]) => guard(() => real[key]!(...args));
        }
        return real[key];
      },
    });
  };

  const real = db as unknown as Record<string, (...args: unknown[]) => unknown>;
  return new Proxy(db, {
    get(_target, key: string) {
      if (key === "prepare") {
        return (text: string) => wrap(real["prepare"]!(text) as D1PreparedStatement);
      }
      if (key === "batch") {
        return (...args: unknown[]) => guard(() => real["batch"]!(...args));
      }
      return real[key];
    },
  }) as D1Database;
}

function context(fake: FakeD1, fetcher: typeof fetch, db = fake.db): RouteContext {
  const env = {
    DB: db,
    SOSTOSLISTA_API_TOKEN: "token",
    SOSTOSLISTA_HOUSEHOLD_ID: "1",
    SOSTOSLISTA_SERVICE: { fetch: fetcher },
  } as unknown as Env;

  return {
    request: new Request("https://ruokalista.example/ostoslista/laheta", {
      method: "POST",
      body: new URLSearchParams({ ateria: "1" }),
    }),
    env,
    url: new URL("https://ruokalista.example/ostoslista/laheta"),
    params: {},
  };
}

test("the ceiling advice still reaches a browser with no JavaScript (#308)", async () => {
  const fake = seeded();
  // One list read and one add get through; the budget goes on the next call —
  // and once it has, D1 stops answering too, because there is one budget and
  // both come out of it. That is what makes this a regression rather than a
  // description: with the screen re-deriving its own state, the page carrying
  // this message is built out of statements that can no longer be made.
  const service = exhausted(2);
  const db = refusingAfterCeiling(fake.db, () => service.calls > 2);
  const ctx = context(fake, service.fetch, db);

  const response = await sendShoppingListForm(ctx, member);

  assert.equal(response.status, 502);
  assert.match(
    response.headers.get("content-type") ?? "",
    /text\/html/,
    "a form post gets a screen back, not JSON",
  );

  const body = await response.text();
  assert.match(body, /Lista oli liian pitkä yhteen lähetykseen/);
  assert.match(body, /Paina Lähetä uudelleen/);
  assert.match(body, /jo lähetetyt rivit ohitetaan/);
  // Nothing was blamed on a row, because no row did anything wrong.
  assert.doesNotMatch(body, /tuotevalinta/);
  // And it really is the shopping screen, with the list still on it.
  assert.match(body, /Lähetä S-ostoslistaan/);
});

test("nothing is asked of D1 once the budget has gone (#308)", async () => {
  // The heart of it. Whatever the page needs to draw itself, it has to have
  // already: re-deriving the shopping list here is five more statements out of
  // a budget the send just proved is empty.
  const fake = seeded();
  const service = exhausted(2);

  let spentWhenTheCeilingHit: number | null = null;
  const watched = new Proxy(service.fetch, {
    apply(target, thisArg, args: Parameters<typeof fetch>) {
      if (spentWhenTheCeilingHit === null && service.calls >= 2) {
        spentWhenTheCeilingHit = fake.subrequests();
      }
      return Reflect.apply(target, thisArg, args);
    },
  });

  const response = await sendShoppingListForm(context(fake, watched), member);
  assert.equal(response.status, 502);
  await response.text();

  assert.notEqual(spentWhenTheCeilingHit, null);
  const after = fake.subrequests();
  assert.equal(
    after - spentWhenTheCeilingHit!,
    0,
    "the ceiling is terminal: no re-render, and no receipt batch either",
  );
});

test("a send that works answers the no-JS form without re-deriving the list (#308)", async () => {
  const fake = seeded();
  const service = exhausted(Number.MAX_SAFE_INTEGER);
  const ctx = context(fake, service.fetch);

  const before = fake.subrequests();
  const response = await sendShoppingListForm(ctx, member);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /ainesta lähetettiin S-ostoslistaan/);

  // Six for the screen's own state, one to read this household's sent notes,
  // one batch to write them back. The re-render adds none.
  assert.equal(
    fake.subrequests() - before,
    7,
    "the answer is drawn from the state the send already had",
  );
});

/**
 * A chosen product from before #147's mapping had a package-size column.
 *
 * `shopping.ts::shoppingLinesFor` writes the size down when it meets one, in a
 * `db.batch` that nothing predicted: this is a statement the request makes
 * only sometimes, which is why counting the pre-send cost as a constant could
 * not be right (#308 review).
 */
function withLegacyProduct(fake: FakeD1): void {
  fake.sql.exec(`
    INSERT INTO ingredient_product
      (ingredient_id, ean, name, image_url, package_quantity, package_unit)
      VALUES (1, '6415712506032', 'Kotimaista rasvaton maito 1 l', NULL, NULL, NULL);
  `);
}

test("a legacy product's package-size backfill is on the ledger too (#308 review)", async () => {
  // Same send twice: once without the legacy row, once with it. The second
  // really does make an extra D1 call, and it is inside the allowance because
  // the database is metered rather than estimated.
  const plain = seeded();
  const plainService = exhausted(Number.MAX_SAFE_INTEGER);
  const before = plain.subrequests();
  const plainAnswer = await sendShoppingListForm(context(plain, plainService.fetch), member);
  assert.equal(plainAnswer.status, 200);
  await plainAnswer.text();
  const plainCost = plain.subrequests() - before;

  const legacy = seeded();
  withLegacyProduct(legacy);
  const legacyService = exhausted(Number.MAX_SAFE_INTEGER);
  const legacyBefore = legacy.subrequests();
  const answer = await sendShoppingListForm(context(legacy, legacyService.fetch), member);
  assert.equal(answer.status, 200);
  await answer.text();
  const legacyCost = legacy.subrequests() - legacyBefore;

  assert.equal(
    legacyCost,
    plainCost + 1,
    "the backfill batch is one more statement than the same send without it",
  );

  // It really did write the size down, so this is the backfill and not some
  // other statement.
  const row = legacy.sql
    .prepare("SELECT package_quantity, package_unit FROM ingredient_product WHERE ean = ?")
    .get("6415712506032") as { package_quantity: number | null; package_unit: string | null };
  assert.equal(row.package_quantity, 1);
  assert.equal(row.package_unit, "l");

  // And the whole request still fits, session lookup included.
  assert.ok(
    legacyCost + legacyService.calls + 1 <= 50,
    `${legacyCost} D1 + ${legacyService.calls} fetch + 1 session must fit in 50`,
  );
});
