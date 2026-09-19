import assert from "node:assert/strict";
import test from "node:test";

import type { SOstoslistaRowFailure } from "../src/s-ostoslista-sync.ts";
import { partialSendMessage } from "../src/shopping-screens.ts";

/**
 * What a partial send tells the member to do next.
 *
 * The bug this guards is a wording one with real consequences: every failure
 * the per-row retry declined to repeat used to read as the service refusing
 * the row, so a member whose note bookkeeping failed locally was sent to check
 * a product choice that was never involved (#308 review).
 */

function failure(
  overrides: Partial<SOstoslistaRowFailure> = {},
): SOstoslistaRowFailure {
  return {
    key: "1",
    name: "maito",
    operation: { kind: "product", ean: "6415712506032" },
    kind: "refused",
    status: 400,
    message: "unknown product",
    ...overrides,
  };
}

function message(failures: SOstoslistaRowFailure[], sent = 2, total = 3): string {
  return partialSendMessage({ sent, total, failures, ceiling: false });
}

test("a product the service refused is the one case that points at the product", () => {
  const text = message([failure()]);
  assert.match(text, /ei ottanut vastaan riviä maito \(400\)/);
  assert.match(text, /tarkista niiden tuotevalinta/);
});

test("a refused free-text row is never blamed on a product choice", () => {
  // There is no product on this row to go and look at, so the advice that
  // names one would send the member somewhere that does not exist.
  const text = message([
    failure({
      operation: { kind: "note", note: "kaneli — 1 tl" },
      name: "kaneli",
      status: 422,
    }),
  ]);
  assert.doesNotMatch(text, /tuotevalinta/);
  assert.match(text, /ei hyväksynyt niitä/);
});

test("this app's own bookkeeping failing is a retry, not a refusal", () => {
  const text = message([
    failure({
      operation: { kind: "receipt" },
      name: "suola",
      kind: "local",
      status: null,
      message: "receipt write failed",
    }),
  ]);
  assert.doesNotMatch(text, /tuotevalinta/);
  assert.doesNotMatch(text, /ei ottanut vastaan/);
  assert.match(text, /kirjaaminen epäonnistui täällä päässä/);
  assert.match(text, /Yritä uudelleen/);
  assert.match(text, /ei tee tuplarivejä/);
});

test("a dropped connection is a retry too", () => {
  const text = message([failure({ kind: "unreachable", status: null })]);
  assert.match(text, /yhteysvirheen takia/);
  assert.match(text, /Yritä uudelleen/);
});

test("one refused row beside one local failure still asks for a retry", () => {
  // Mixed causes: the refusal is real, but so is the row that only needs
  // another press, and the advice has to serve the member who can still act.
  const text = message([failure(), failure({ key: "2", name: "suola", kind: "local" })]);
  assert.match(text, /Yritä uudelleen/);
  assert.doesNotMatch(text, /tuotevalinta/);
});

test("beyond three named rows the rest are counted, not listed", () => {
  const many = ["a", "b", "c", "d", "e"].map((name, index) =>
    failure({ key: String(index), name }),
  );
  const text = message(many, 27, 32);
  assert.match(text, /27\/32 ainesta lähti perille/);
  assert.match(text, /Lisäksi 2 muuta riviä ei mennyt läpi/);
  assert.doesNotMatch(text, /vastaan riviä e/);
});

test("running out of subrequests blames no row and promises a working retry", () => {
  const text = partialSendMessage({ sent: 28, total: 32, failures: [], ceiling: true });
  assert.match(text, /liian pitkä yhteen lähetykseen/);
  assert.match(text, /28\/32 ainesta lähti perille/);
  assert.match(text, /jo lähetetyt rivit ohitetaan/);
  assert.doesNotMatch(text, /tuotevalinta/);
});

test("a refused old-note delete never points at the product (#308 review)", () => {
  // The product was accepted and the row is on the list. What failed was
  // removing the text reminder the last send left behind, and the member's
  // move is to lift that off the phone — not to go and re-pick a product the
  // service took without complaint.
  const text = message([
    failure({
      operation: { kind: "old-note", note: "maito — 800 g" },
      status: 400,
    }),
  ]);
  assert.doesNotMatch(text, /tuotevalinta/);
  assert.doesNotMatch(text, /ei ottanut vastaan riviä/);
  assert.match(text, /vanhaa tekstiriviä ei saatu poistettua/);
  assert.match(text, /poista ne S-ostoslistalta itse/);
});

test("a refused product beside a refused old-note stops naming the product", () => {
  const text = message([
    failure(),
    failure({
      key: "2",
      name: "juusto",
      operation: { kind: "old-note", note: "juusto — 200 g" },
    }),
  ]);
  assert.doesNotMatch(text, /tuotevalinta/);
  assert.match(text, /ei hyväksynyt niitä/);
});

test("an unreadable answer is not reported as a connection error (#308 review)", () => {
  const text = message([
    failure({
      kind: "malformed",
      status: null,
      message: "Malformed S-ostoslista response: add response is missing id or name.",
    }),
  ]);
  assert.doesNotMatch(text, /yhteysvirhe/);
  assert.doesNotMatch(text, /tuotevalinta/);
  assert.match(text, /vastasi riviin maito jotain odottamatonta/);
  // The member cannot fix this one, so what is left is to try it again.
  assert.match(text, /Yritä uudelleen/);
});
