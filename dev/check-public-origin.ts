import assert from "node:assert/strict";
import test from "node:test";

import { googleCallbackUrl } from "../src/public-origin.ts";

const worker = new URL("https://ruokalista.eerovil.workers.dev/auth/google");

test("the known VPS proxy makes Google use the canonical production callback", () => {
  const headers = new Headers({
    "X-Forwarded-Host": "ruokalista.vilpponen.fi",
    "X-Forwarded-Proto": "https",
  });

  assert.equal(
    googleCallbackUrl(worker, headers),
    "https://ruokalista.vilpponen.fi/auth/google/callback",
  );
});

test("an arbitrary forwarded host cannot choose the OAuth callback", () => {
  const headers = new Headers({
    "X-Forwarded-Host": "attacker.example",
    "X-Forwarded-Proto": "https",
  });

  assert.equal(
    googleCallbackUrl(worker, headers),
    "https://ruokalista.eerovil.workers.dev/auth/google/callback",
  );
});

test("forwarded headers are ignored outside the known Worker origin", () => {
  const local = new URL("http://127.0.0.1:8787/auth/google");
  const headers = new Headers({
    "X-Forwarded-Host": "ruokalista.vilpponen.fi",
    "X-Forwarded-Proto": "https",
  });

  assert.equal(
    googleCallbackUrl(local, headers),
    "http://127.0.0.1:8787/auth/google/callback",
  );
});
