import assert from "node:assert/strict";
import test from "node:test";

import { CLIENT_FAILURE_STEPS, clientFailureLog } from "../src/intake.ts";

/**
 * The log line an import that gave way in the browser leaves behind (#222).
 *
 * It is shaped from a body a page sent, so every field is narrowed rather than
 * trusted, and the checks below are about that narrowing. The route itself is
 * exercised in `tests/intake.spec.ts`, which is where a real browser can be
 * made to fail on purpose.
 */

test("a report keeps the step, the route and the counts", () => {
  const line = clientFailureLog(
    {
      step: "send",
      route: "photographed",
      status: 0,
      pages: 4,
      bytes: 2659060,
      detail: "Failed to fetch",
    },
    7,
  );

  assert.deepEqual(line, {
    event: "intake.client_failed",
    step: "send",
    route: "photographed",
    status: 0,
    pages: 4,
    bytes: 2659060,
    detail: "Failed to fetch",
    household_id: 7,
  });
});

test("the event name is not the server's, so one line tells them apart", () => {
  // `importFailureMessage` logs `intake.failed` for a refusal that reached the
  // Worker. Reading the name alone has to be enough to tell "the browser gave
  // up" from "the server refused" — that is the whole point of #222.
  assert.equal(
    clientFailureLog({}, 1).event,
    "intake.client_failed",
  );
});

test("every step the island reports is a step the log accepts", () => {
  for (const step of CLIENT_FAILURE_STEPS) {
    assert.equal(clientFailureLog({ step }, 1).step, step);
  }
});

test("a step or route the browser invented is recorded as unknown", () => {
  assert.equal(clientFailureLog({ step: "failed" }, 1).step, "unknown");
  assert.equal(clientFailureLog({ step: 12 }, 1).step, "unknown");
  assert.equal(clientFailureLog({ route: "smuggled" }, 1).route, "unknown");
  assert.equal(clientFailureLog({}, 1).route, "unknown");
});

test("a number that is not one becomes zero rather than reaching the log", () => {
  for (const bytes of [-1, Number.NaN, Number.POSITIVE_INFINITY, "40", null]) {
    assert.equal(clientFailureLog({ bytes }, 1).bytes, 0, String(bytes));
  }
  assert.equal(clientFailureLog({ pages: 3.7 }, 1).pages, 3);
  assert.equal(clientFailureLog({ status: 503 }, 1).status, 503);
});

test("a long detail is cut, and a detail that is not text is dropped", () => {
  const line = clientFailureLog({ detail: "x".repeat(5000) }, 1);
  assert.equal(line.detail.length, 300);
  assert.equal(clientFailureLog({ detail: { stack: "…" } }, 1).detail, "");
});

test("an unreadable body still leaves a line naming the household", () => {
  // The route hands `null` through when the request had no JSON in it at all.
  // A report that cannot be read is still worth recording: something failed.
  assert.deepEqual(clientFailureLog(null, 3), {
    event: "intake.client_failed",
    step: "unknown",
    route: "unknown",
    status: 0,
    pages: 0,
    bytes: 0,
    detail: "",
    household_id: 3,
  });
});
