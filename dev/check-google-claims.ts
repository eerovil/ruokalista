/**
 * Checks readIdentity's claim validation, which decides whose Google account
 * the Worker will act on. Run it with:
 *
 *   ./scripts/node.sh npm run check
 *
 * Not a test framework — node's own runner, so there is no dependency to add.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { readIdentity } from "../src/google.ts";

const CLIENT_ID = "our-client-id.apps.googleusercontent.com";
const NOW = 1_800_000_000;

function idToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode(claims)}.signature`;
}

const valid = {
  iss: "https://accounts.google.com",
  aud: CLIENT_ID,
  exp: NOW + 3600,
  sub: "1234567890",
  name: "Eero",
  email: "eero@example.com",
  email_verified: true,
};

test("accepts a token issued to this application", () => {
  const identity = readIdentity(idToken(valid), CLIENT_ID, NOW);
  assert.deepEqual(identity, {
    sub: "1234567890",
    name: "Eero",
    email: "eero@example.com",
    emailVerified: true,
  });
});

test("refuses a token meant for another application", () => {
  const token = idToken({ ...valid, aud: "someone-elses-client-id" });
  assert.equal(readIdentity(token, CLIENT_ID, NOW), null);
});

test("refuses a token from another issuer", () => {
  const token = idToken({ ...valid, iss: "https://evil.example" });
  assert.equal(readIdentity(token, CLIENT_ID, NOW), null);
});

test("refuses an expired token", () => {
  const token = idToken({ ...valid, exp: NOW - 1 });
  assert.equal(readIdentity(token, CLIENT_ID, NOW), null);
});

test("refuses a token with no subject", () => {
  const token = idToken({ ...valid, sub: "" });
  assert.equal(readIdentity(token, CLIENT_ID, NOW), null);
});

test("refuses a subject outside Google's own contract for one", () => {
  // Not pedantry: this is what makes "accepted sub" a bounded set, which is
  // what lets #127 park a removed member on a value none of them can equal.
  // See `isGoogleSub` and `dev/check-google-sub.ts`.
  for (const sub of ["x".repeat(256), "ääkkösiä", "—removed:2"]) {
    assert.equal(readIdentity(idToken({ ...valid, sub }), CLIENT_ID, NOW), null);
  }
});

test("refuses malformed tokens", () => {
  assert.equal(readIdentity("not-a-jwt", CLIENT_ID, NOW), null);
  assert.equal(readIdentity("a.b.c", CLIENT_ID, NOW), null);
});

test("falls back to a placeholder name, but never invents a subject", () => {
  const token = idToken({ ...valid, name: undefined, email: undefined });
  assert.deepEqual(readIdentity(token, CLIENT_ID, NOW), {
    sub: "1234567890",
    name: "Tuntematon",
    email: null,
    emailVerified: true,
  });
});

test("carries Google's email verification separately from token validity", () => {
  assert.equal(
    readIdentity(idToken({ ...valid, email_verified: false }), CLIENT_ID, NOW)
      ?.emailVerified,
    false,
  );
  assert.equal(
    readIdentity(idToken({ ...valid, email_verified: undefined }), CLIENT_ID, NOW)
      ?.emailVerified,
    false,
  );
});
