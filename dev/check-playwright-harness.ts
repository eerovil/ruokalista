import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { browserMaxFailures } from "../tests/support/playwright-policy.ts";
import { runLocalWrangler } from "../tests/support/seed.ts";

const configSource = readFileSync(
  new URL("../playwright.config.ts", import.meta.url),
  "utf8",
);

test("a local browser run stops after its first actionable failure", () => {
  assert.equal(browserMaxFailures({ CI: "1" }), 1);
});

test("GitHub Actions keeps the complete failure surface", () => {
  assert.equal(browserMaxFailures({ CI: "1", GITHUB_ACTIONS: "true" }), 0);
});

test("the Playwright config applies the local failure policy", () => {
  assert.match(
    configSource,
    /maxFailures:\s*browserMaxFailures\(process\.env\)/,
  );
});

test("local Wrangler fixture commands capture both output streams", () => {
  let stdio: unknown;
  runLocalWrangler([], "Preparing a fixture", (_command, _args, options) => {
    stdio = options.stdio;
  });
  assert.deepEqual(stdio, ["ignore", "pipe", "pipe"]);
});

test("a failed local Wrangler command keeps the reason it printed", () => {
  assert.throws(
    () => runLocalWrangler(
      ["d1", "execute", "ruokalista", "--local"],
      "Resetting local D1 before a browser test",
      () => {
        throw { stderr: "database is locked\n" };
      },
    ),
    (error: unknown) => {
      assert.match(String((error as Error).message), /Resetting local D1/);
      assert.match(String((error as Error).message), /database is locked/);
      return true;
    },
  );
});

test("Wrangler stdout remains evidence when stderr is empty", () => {
  assert.throws(
    () => runLocalWrangler([], "Preparing a fixture", () => {
      throw {
        stderr: Buffer.alloc(0),
        stdout: Buffer.from("structured refusal\n"),
      };
    }),
    /structured refusal/,
  );
});
