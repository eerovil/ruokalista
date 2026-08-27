/**
 * Checks the one thing this app is allowed to assume about a Google `sub`, and
 * the tombstone that assumption has to keep clear of. Run it with:
 *
 *   ./scripts/node.sh npm run check
 *
 * The whole point of the file is the last group. #127 first parked a removed
 * member's `google_sub` on `removed:<id>`, which is only safe if a real `sub`
 * can never look like that — and Google's contract says otherwise. So the
 * tombstone moved outside the contract, and these prove it stayed there.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { isGoogleSub } from "../src/google.ts";
import { removedSub } from "../src/households.ts";

test("accepts the ASCII strings Google's contract allows", () => {
  // What subs look like today...
  assert.equal(isGoogleSub("110169484474386276334"), true);
  // ...and everything else the documented contract permits, none of which this
  // app may refuse just because it has not seen one yet.
  assert.equal(isGoogleSub("a"), true);
  assert.equal(isGoogleSub("removed:2"), true);
  assert.equal(isGoogleSub("Case-Sensitive_ASCII.id~"), true);
  assert.equal(isGoogleSub("x".repeat(255)), true);
});

test("refuses what the contract does not cover", () => {
  assert.equal(isGoogleSub(""), false);
  assert.equal(isGoogleSub("x".repeat(256)), false);
  assert.equal(isGoogleSub("ääkkösiä"), false);
  assert.equal(isGoogleSub("—"), false);
});

test("the tombstone is not a sub Google could ever issue", () => {
  // The regression. Every member id, not one sample: the tombstone is derived
  // from the id, so a shape that only fails the contract for small ids would be
  // no guarantee at all.
  for (const id of [1, 2, 9, 42, 1000, 2_147_483_647]) {
    assert.equal(
      isGoogleSub(removedSub(id)),
      false,
      `removedSub(${id}) must not be an acceptable Google sub`,
    );
  }
});

test("the tombstone is a different value for every member", () => {
  // What the UNIQUE `google_sub` column needs while several rows are parked.
  const parked = [1, 2, 9, 42].map(removedSub);
  assert.equal(new Set(parked).size, parked.length);
});

test("the sub the old scheme reserved is an ordinary Google sub again", () => {
  // The bug this file exists for: `removed:2` is a legal account id, so a real
  // person with it must be addable, and must not be mistaken for a parked row.
  assert.equal(isGoogleSub("removed:2"), true);
  assert.notEqual("removed:2", removedSub(2));
});
