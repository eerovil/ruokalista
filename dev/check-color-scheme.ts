import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

/**
 * The device's own light or dark setting picks the colours (#355), and that has
 * to hold on the older iPads #65 keeps supported. Safari only reads CSS
 * light-dark() from 17.5; an older one drops every declaration that uses it, so
 * a single token written that way loses its colour there in both modes. The
 * colours switch under prefers-color-scheme instead.
 */
test("no shipped stylesheet uses light-dark()", () => {
  const dir = new URL("../src/", import.meta.url);
  const offenders = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => /light-dark\(\s*[#a-z]/i.test(readFileSync(new URL(file, dir), "utf8")));
  assert.deepEqual(offenders, [], "Use a prefers-color-scheme: dark block instead.");
});

test("the shell switches its colours on the device's setting", () => {
  const html = readFileSync(new URL("../src/html.ts", import.meta.url), "utf8");
  assert.match(html, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{/);
  assert.match(html, /<meta name="theme-color" media="\(prefers-color-scheme: dark\)"/);
});
