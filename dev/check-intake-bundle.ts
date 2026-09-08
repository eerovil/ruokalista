import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";

import intakeClient from "../src/generated/intake.ts";
import { intakeScreen } from "../src/intake-screens.ts";
import { MAX_IMAGES, MAX_PAGE_BASE64_BYTES, MAX_PAGES_BASE64_BYTES } from "../src/intake.ts";
import type { RouteContext } from "../src/router.ts";

// Test the actual emitted program, not another hand-written browser copy.
test("intake is an ES5 bundle with no runtime Worker imports", async () => {
  const result = await build({
    entryPoints: ["src/client/intake.ts"], bundle: true, format: "iife",
    target: "es5", platform: "browser", minify: true, legalComments: "none",
    write: false, metafile: true, tsconfig: "tsconfig.client.json",
  });
  assert.equal(result.outputFiles[0]!.text, intakeClient);
  assert.deepEqual(Object.keys(result.metafile.inputs), ["src/client/intake.ts"]);
  assert.doesNotMatch(intakeClient, /<\/script/i);
});

test("the rendered form supplies numeric server limits without interpolating script code", async () => {
  const db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) };
  const response = await intakeScreen({ env: { DB: db }, url: new URL("https://example.test/intake") } as unknown as RouteContext,
    { id: 1, householdId: 1, displayName: "Test", email: null, isAdmin: false });
  const body = await response.text();
  assert.ok(body.includes(intakeClient));
  assert.match(body, new RegExp(`data-max-pages="${MAX_IMAGES}"`));
  assert.match(body, new RegExp(`data-max-page-bytes="${MAX_PAGE_BASE64_BYTES}"`));
  assert.match(body, new RegExp(`data-max-pages-bytes="${MAX_PAGES_BASE64_BYTES}"`));
  assert.doesNotMatch(readFileSync("src/intake-screens.ts", "utf8"), /STREAMING_ISLAND/);
});

test("the fixed-entry build detects missing and stale output and regenerates deterministically", () => {
  // Work only in a disposable copy; parallel checks never see an altered bundle.
  const root = mkdtempSync(join(tmpdir(), "intake-build-"));
  try {
    mkdirSync(join(root, "scripts"));
    cpSync("scripts/build-client.mjs", join(root, "scripts/build-client.mjs"));
    cpSync("src", join(root, "src"), { recursive: true });
    cpSync("tsconfig.client.json", join(root, "tsconfig.client.json"));
    symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
    const run = (...args: string[]) => spawnSync(process.execPath, ["scripts/build-client.mjs", ...args],
      { cwd: root, encoding: "utf8", timeout: 20_000 });
    const path = join(root, "src/generated/intake.ts");
    const expected = readFileSync(path, "utf8");
    const splitter = readFileSync(join(root, "src/generated/recipe-image-split.ts"), "utf8");
    assert.equal(run("--check").status, 0);
    rmSync(path);
    let checked = run("--check");
    assert.notEqual(checked.status, 0);
    assert.match(checked.stderr, /intake\.ts is missing/);
    writeFileSync(path, "stale");
    checked = run("--check");
    assert.notEqual(checked.status, 0);
    assert.match(checked.stderr, /intake\.ts is stale/);
    assert.equal(run().status, 0);
    assert.equal(readFileSync(path, "utf8"), expected);
    assert.equal(readFileSync(join(root, "src/generated/recipe-image-split.ts"), "utf8"), splitter);
    assert.equal(run("--check").status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
