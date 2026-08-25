import assert from "node:assert/strict";
import test from "node:test";

import { isLocalOrigin } from "../src/public-origin.ts";

/**
 * The gate on the sample draft. It is the only thing standing between a
 * development shortcut and a shipped one, so it is checked directly rather than
 * only through a browser test that always runs on 127.0.0.1 and would therefore
 * agree with any implementation that returns true.
 */

test("a development server is local", () => {
  for (const origin of [
    "http://127.0.0.1:8787/intake",
    "http://localhost:8787/intake",
    "http://[::1]:8787/intake",
    // A phone on the same wifi, pointed at wrangler dev.
    "http://192.168.1.42:8787/intake",
    "http://10.0.0.7:8787/intake",
    "http://172.16.5.4:8787/intake",
    "http://172.31.255.1:8787/intake",
  ]) {
    assert.equal(isLocalOrigin(new URL(origin)), true, origin);
  }
});

test("the deployment is not, by either of its hostnames", () => {
  assert.equal(
    isLocalOrigin(new URL("https://ruokalista.vilpponen.fi/intake")),
    false,
  );
  assert.equal(
    isLocalOrigin(new URL("https://ruokalista.eerovil.workers.dev/intake")),
    false,
  );
});

test("a public address that merely looks private is not local", () => {
  for (const origin of [
    // 172.15 and 172.32 sit outside the private range; both are real public
    // space, and an off-by-one here is a shipped shortcut.
    "https://172.15.0.1/intake",
    "https://172.32.0.1/intake",
    "https://11.0.0.1/intake",
    "https://192.169.0.1/intake",
    // Hostnames that end in the right letters but are somebody else's.
    "https://127.0.0.1.example.com/intake",
    "https://localhost.example.com/intake",
    "https://notlocalhost/intake",
    "https://ruokalista.vilpponen.fi.example.com/intake",
  ]) {
    assert.equal(isLocalOrigin(new URL(origin)), false, origin);
  }
});
