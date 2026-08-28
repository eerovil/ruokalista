import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../tests/screenshots.spec.ts", import.meta.url),
  "utf8",
);

test("screenshot review artifacts stay behind the opt-in capture helper", () => {
  const directCalls = source.match(/page\.screenshot\s*\(/g) ?? [];
  assert.equal(
    directCalls.length,
    1,
    "Use capture(page, ...) so ordinary browser runs keep the behavioural assertions without writing PNGs.",
  );
});
