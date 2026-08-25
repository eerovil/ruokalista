/**
 * Week arithmetic. Off-by-one here shows up as a meal on the wrong day, which
 * is the kind of bug nobody notices until dinner.
 *
 *   ./scripts/node.sh npm run check
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  addDays,
  dayName,
  isDate,
  mondayOf,
  shortDate,
  weekFrom,
} from "../src/dates.ts";

test("weeks start on Monday", () => {
  // 2026-08-24 is a Monday.
  assert.equal(mondayOf("2026-08-24"), "2026-08-24");
  assert.equal(mondayOf("2026-08-25"), "2026-08-24");
  // Sunday belongs to the week that started six days earlier, not the next one.
  assert.equal(mondayOf("2026-08-30"), "2026-08-24");
  assert.equal(mondayOf("2026-08-31"), "2026-08-31");
});

test("a week is seven days ending on Sunday", () => {
  const week = weekFrom("2026-08-24");
  assert.equal(week.length, 7);
  assert.equal(week[0], "2026-08-24");
  assert.equal(week[6], "2026-08-30");
  assert.equal(dayName(week[0]!), "maanantai");
  assert.equal(dayName(week[6]!), "sunnuntai");
});

test("adding days crosses months and years", () => {
  assert.equal(addDays("2026-08-31", 1), "2026-09-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2027-01-01", -1), "2026-12-31");
  // 2028 is a leap year.
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2027-02-28", 1), "2027-03-01");
});

test("a week that spans a month still holds seven real days", () => {
  const week = weekFrom(mondayOf("2026-09-02"));
  assert.deepEqual(week, [
    "2026-08-31",
    "2026-09-01",
    "2026-09-02",
    "2026-09-03",
    "2026-09-04",
    "2026-09-05",
    "2026-09-06",
  ]);
});

test("a date that only looks like one is refused", () => {
  assert.equal(isDate("2026-02-31"), false);
  assert.equal(isDate("2026-13-01"), false);
  assert.equal(isDate("2026-8-1"), false);
  assert.equal(isDate("eilen"), false);
  assert.equal(isDate(""), false);

  assert.equal(isDate("2026-02-28"), true);
  assert.equal(isDate("2028-02-29"), true);
});

test("dates read the way Finnish writes them", () => {
  assert.equal(shortDate("2026-08-25"), "25.8.");
  assert.equal(shortDate("2026-12-01"), "1.12.");
});
