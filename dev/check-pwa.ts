import assert from "node:assert/strict";
import test from "node:test";

import {
  MANIFEST,
  PUBLIC_PWA_PATHS,
  contentGeneration,
  serviceWorkerSource,
} from "../src/pwa-content.ts";

test("the manifest identity and assets stay bound to its exact origin", () => {
  const manifest = JSON.parse(MANIFEST) as {
    id: string;
    start_url: string;
    scope: string;
    name: string;
    lang: string;
    display: string;
    icons: { src: string; sizes: string; purpose: string }[];
  };
  const base = "https://example.test:9187/manifest.webmanifest";

  assert.equal(manifest.name, "Ruokalista");
  assert.equal(manifest.lang, "fi");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.id, "./ruokalista-pwa");
  assert.equal(new URL(manifest.id, base).href, "https://example.test:9187/ruokalista-pwa");
  assert.equal(new URL(manifest.start_url, base).href, "https://example.test:9187/");
  assert.equal(new URL(manifest.scope, base).href, "https://example.test:9187/");
  assert.deepEqual(
    new Set(manifest.icons.map((icon) => `${icon.sizes}:${icon.purpose}`)),
    new Set(["192x192:any", "512x512:any", "512x512:maskable"]),
  );
  assert.ok(
    manifest.icons.every(
      (icon) => new URL(icon.src, base).origin === "https://example.test:9187",
    ),
  );
});

test("the cache generation changes with managed PWA content", async () => {
  assert.notEqual(
    await contentGeneration(["same", "asset A"]),
    await contentGeneration(["same", "asset B"]),
  );
});

test("the service worker caches only the explicit public allowlist", () => {
  const source = serviceWorkerSource("123456789abc");

  assert.match(source, /ruokalista-static-123456789abc/);
  assert.match(source, /request\.method !== "GET"/);
  assert.match(source, /request\.mode === "navigate"/);
  assert.match(source, /ASSETS\.indexOf\(url\.pathname\) === -1/);
  assert.deepEqual(PUBLIC_PWA_PATHS, [
    "/manifest.webmanifest",
    "/offline",
    "/favicon.svg",
    "/icon-192.png",
    "/icon-512.png",
    "/icon-maskable-512.png",
    "/apple-touch-icon.png",
  ]);
});
