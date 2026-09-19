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
    note: false,
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
  const text = message([failure({ note: true, name: "kaneli", status: 422 })]);
  assert.doesNotMatch(text, /tuotevalinta/);
  assert.match(text, /ei hyväksynyt niitä/);
});

test("this app's own bookkeeping failing is a retry, not a refusal", () => {
  const text = message([
    failure({
      note: true,
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
