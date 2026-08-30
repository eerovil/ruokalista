import assert from "node:assert/strict";
import test from "node:test";

import {
  CLIENT_FAILURE_STEPS,
  clientFailureLog,
  clientReportEvent,
  SERVER_ANSWERED_STEPS,
} from "../src/intake.ts";

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

test("only a step with no response behind it is a browser give-up", () => {
  // `intake.client_failed` is a promise about *where* the import died:
  // nothing left the device, so no server-side record of it can exist.
  for (const step of CLIENT_FAILURE_STEPS) {
    assert.equal(clientReportEvent(step), "intake.client_failed", step);
    assert.equal(clientFailureLog({ step }, 1).event, "intake.client_failed");
  }
});

test("a step the Worker already answered never earns that name", () => {
  // The island does not report these at all — the request arrived, so the
  // Worker's own logging represents it. This is the second half of that, and
  // the half a report the island did not send cannot get past.
  for (const step of SERVER_ANSWERED_STEPS) {
    assert.equal(clientReportEvent(step), "intake.client_report", step);

    const line = clientFailureLog({ step, status: 503 }, 1);
    assert.equal(line.event, "intake.client_report");
    // The step itself is still recorded, so the line is readable — it just
    // does not claim the browser gave up.
    assert.equal(line.step, step);
    assert.equal(line.status, 503);
  }
});

test("every step the island reports is a step the log accepts", () => {
  for (const step of [...CLIENT_FAILURE_STEPS, ...SERVER_ANSWERED_STEPS]) {
    assert.equal(clientFailureLog({ step }, 1).step, step);
  }
});

test("a step or route the browser invented is recorded as unknown", () => {
  assert.equal(clientFailureLog({ step: "failed" }, 1).step, "unknown");
  assert.equal(clientFailureLog({ step: 12 }, 1).step, "unknown");
  assert.equal(clientFailureLog({ route: "smuggled" }, 1).route, "unknown");
  assert.equal(clientFailureLog({}, 1).route, "unknown");
});

test("an unknown step claims nothing either", () => {
  // Neither "the browser gave up" nor "the server refused" is known here, so
  // the line says neither. Guessing would be the same mistake in a new place.
  assert.equal(clientReportEvent("unknown"), "intake.client_report");
  assert.equal(clientFailureLog({ step: "smuggled" }, 1).event, "intake.client_report");
  assert.equal(clientFailureLog({}, 1).event, "intake.client_report");
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
    event: "intake.client_report",
    step: "unknown",
    route: "unknown",
    status: 0,
    pages: 0,
    bytes: 0,
    detail: "",
    household_id: 3,
  });
});
