import assert from "node:assert/strict";
import test from "node:test";

import { rememberSentNote } from "../src/s-ostoslista-notes.ts";
import {
  rememberSentItemStatement,
  removeAppRows,
  type RemoveAppRowsClient,
} from "../src/s-ostoslista-sent-items.ts";
import { SOstoslistaError, type SOstoslistaItem } from "../src/s-ostoslista.ts";
import { SubrequestBudget } from "../src/subrequests.ts";
import { migratedDatabase, type FakeD1 } from "./support/d1.ts";

/**
 * "Remove Ruokalista's rows" (#358): which rows it takes, which it leaves, and
 * what it does when one request's allowance runs out.
 */

function database(): FakeD1 {
  const fake = migratedDatabase();
  fake.sql.exec(`
    INSERT INTO household (id, name) VALUES (1, 'Koti'), (2, 'Toinen');
    INSERT INTO member (id, household_id, google_sub, email, display_name, is_admin)
      VALUES (1, 1, 'sub-1', 'eero@example.com', 'Eero', 1);
    INSERT INTO ingredient (id, name, created_by) VALUES (1, 'maito', 1);
    INSERT INTO ingredient_product (id, ingredient_id, ean, name)
      VALUES (1, 1, '6410000000001', 'Maito 1 l');
  `);
  return fake;
}

function row(id: string, name: string, ean: string | null, collected = false): SOstoslistaItem {
  return { id, name, ean, collected, collectedStated: true, quantity: null };
}

class FakeClient implements RemoveAppRowsClient {
  readonly removed: string[] = [];
  synced = false;
  missing = new Set<string>();
  failOn: string | null = null;
  /** When set, every delete spends one call of it, as the metered client does. */
  budget: SubrequestBudget | null = null;
  // Longhand, not a parameter property: `npm run check` strips types only.
  held: SOstoslistaItem[];
  constructor(held: SOstoslistaItem[]) {
    this.held = held;
  }

  async list(): Promise<SOstoslistaItem[]> {
    return this.held;
  }

  async removeById(id: string): Promise<void> {
    this.budget?.spend();
    if (id === this.failOn) throw new SOstoslistaError("down", 503);
    if (this.missing.has(id)) throw new SOstoslistaError("item not found", 404);
    this.removed.push(id);
  }

  async sync(): Promise<void> {
    this.synced = true;
  }
}

async function record(fake: FakeD1, household: number, id: string): Promise<void> {
  await rememberSentItemStatement(fake.db, household, id).run();
}

function recorded(fake: FakeD1): string[] {
  return fake.sql
    .prepare("SELECT item_id FROM s_ostoslista_sent_item ORDER BY item_id")
    .all()
    .map((one) => String(one["item_id"]));
}

test("takes recorded rows and guessed old ones, never the household's own", async () => {
  const fake = database();
  await record(fake, 1, "sent-note");
  await record(fake, 1, "sent-gone");
  await rememberSentNote(fake.db, 1, "7", "kaneli — 1 tl");
  const client = new FakeClient([
    row("sent-note", "sipuli — 2 kpl", null, true),
    // Sent before the record existed: a product this household has chosen,
    // and words this app remembers sending.
    row("old-milk", "Maito 1 l", "6410000000001"),
    row("old-note", "kaneli — 1 tl", null),
    // Typed on the phone.
    row("phone-coffee", "kahvi", null),
    row("phone-bread", "Leipä", "6410000000099"),
  ]);

  const outcome = await removeAppRows(fake.db, 1, client, new SubrequestBudget(49));

  assert.deepEqual(client.removed, ["sent-note", "old-milk", "old-note"]);
  assert.deepEqual(outcome, { removed: 3, total: 3, synced: true });
  // Both recorded ids are forgotten: one removed, one already gone.
  assert.deepEqual(recorded(fake), []);
  const notes = fake.sql.prepare("SELECT * FROM s_ostoslista_sent_note").all();
  assert.deepEqual(notes, []);
});

test("another household's record is not this household's to use", async () => {
  const fake = database();
  await record(fake, 2, "theirs");
  const client = new FakeClient([row("theirs", "sipuli — 2 kpl", null)]);

  const outcome = await removeAppRows(fake.db, 1, client, new SubrequestBudget(49));

  assert.deepEqual(client.removed, []);
  assert.deepEqual(outcome, { removed: 0, total: 0, synced: false });
  assert.deepEqual(recorded(fake), ["theirs"]);
});

test("a row somebody already removed counts as removed", async () => {
  const fake = database();
  await record(fake, 1, "sent-1");
  const client = new FakeClient([row("sent-1", "sipuli — 2 kpl", null)]);
  client.missing.add("sent-1");

  const outcome = await removeAppRows(fake.db, 1, client, new SubrequestBudget(49));

  assert.deepEqual(outcome, { removed: 1, total: 1, synced: true });
  assert.deepEqual(recorded(fake), []);
});

test("stops at the allowance and says how far it got", async () => {
  const fake = database();
  const held: SOstoslistaItem[] = [];
  for (let index = 0; index < 5; index += 1) {
    await record(fake, 1, `sent-${index}`);
    held.push(row(`sent-${index}`, `rivi ${index}`, null));
  }
  const client = new FakeClient(held);

  // Room for two deletes plus the batch and the push after them. The plain
  // database here is not metered, so only the deletes are counted.
  const budget = new SubrequestBudget(4);
  client.budget = budget;
  const outcome = await removeAppRows(fake.db, 1, client, budget);

  assert.equal(outcome.removed, 2);
  assert.equal(outcome.total, 5);
  assert.deepEqual(recorded(fake), ["sent-2", "sent-3", "sent-4"]);
});

test("a failure before anything went is a failure, not a count", async () => {
  const fake = database();
  await record(fake, 1, "sent-1");
  const client = new FakeClient([row("sent-1", "sipuli — 2 kpl", null)]);
  client.failOn = "sent-1";

  await assert.rejects(
    removeAppRows(fake.db, 1, client, new SubrequestBudget(49)),
    SOstoslistaError,
  );
  assert.deepEqual(recorded(fake), ["sent-1"]);
});
