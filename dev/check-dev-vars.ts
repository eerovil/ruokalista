import assert from "node:assert/strict";
import test from "node:test";

import { fillDevVars } from "../tests/support/dev-vars.ts";

/**
 * What the browser suite writes into `.dev.vars` before it starts. The suite
 * itself only ever sees the file afterwards, so it would be just as happy with
 * an implementation that overwrote somebody's real Google client id — which is
 * exactly the thing that must not happen. Hence a direct check.
 */

function read(text: string, key: string): string | null {
  for (const line of text.split("\n")) {
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    if (line.slice(0, separator).trim() !== key) continue;
    return line
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return null;
}

function count(text: string, key: string): number {
  return text
    .split("\n")
    .filter((line) => line.slice(0, line.indexOf("=")).trim() === key).length;
}

test("an empty file gets everything the suite needs", () => {
  const filled = fillDevVars("");

  assert.notEqual(read(filled, "SESSION_SECRET"), null);
  assert.notEqual(read(filled, "SESSION_SECRET"), "");
  assert.equal(read(filled, "GOOGLE_CLIENT_ID"), "dev.apps.googleusercontent.com");
  assert.equal(read(filled, "GOOGLE_CLIENT_SECRET"), "dev-not-a-real-secret");
});

test("the blank values of .dev.vars.example are filled in place", () => {
  const example = [
    'SESSION_SECRET="a-long-random-string"',
    'GOOGLE_CLIENT_ID=""',
    'GOOGLE_CLIENT_SECRET=""',
    'ANTHROPIC_API_KEY=""',
    "",
  ].join("\n");

  const filled = fillDevVars(example);

  assert.equal(read(filled, "GOOGLE_CLIENT_ID"), "dev.apps.googleusercontent.com");
  // In place, not appended. A second line for the same key is a coin toss over
  // which one wrangler and tests/support/session.ts each pick up.
  assert.equal(count(filled, "GOOGLE_CLIENT_ID"), 1);
  assert.equal(count(filled, "SESSION_SECRET"), 1);
});

test("a real value is left exactly as it was", () => {
  const mine = [
    'SESSION_SECRET="mine-and-already-signing-cookies"',
    'GOOGLE_CLIENT_ID="983.apps.googleusercontent.com"',
    'GOOGLE_CLIENT_SECRET="a-real-one"',
    'ANTHROPIC_API_KEY="sk-ant-real"',
    "",
  ].join("\n");

  assert.equal(fillDevVars(mine), mine);
});

test("the Anthropic key is never written", () => {
  // A browser test that reached Anthropic would be a test that should not
  // exist, so nothing here may quietly supply the key that lets one.
  assert.equal(read(fillDevVars(""), "ANTHROPIC_API_KEY"), null);
  assert.equal(
    read(fillDevVars('ANTHROPIC_API_KEY=""\n'), "ANTHROPIC_API_KEY"),
    "",
  );
});

test("the session secret is not a constant", () => {
  assert.notEqual(
    read(fillDevVars(""), "SESSION_SECRET"),
    read(fillDevVars(""), "SESSION_SECRET"),
  );
});
