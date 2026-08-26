export const THEME_COLOR = "#1f5d3c";
export const BACKGROUND_COLOR = "#ffffff";

export const MANIFEST = JSON.stringify({
  name: "Ruokalista",
  short_name: "Ruokalista",
  description: "Kotitalouden reseptit ja ruokalista.",
  lang: "fi",
  id: "./ruokalista-pwa",
  start_url: "./",
  scope: "./",
  display: "standalone",
  theme_color: THEME_COLOR,
  background_color: BACKGROUND_COLOR,
  categories: ["food"],
  icons: [
    {
      src: "./icon-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "./icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "./icon-maskable-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
  ],
});

export const OFFLINE_PAGE = `<!doctype html>
<html lang="fi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="${THEME_COLOR}">
<title>Ei verkkoyhteyttä · Ruokalista</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    padding: calc(1.5rem + env(safe-area-inset-top)) 1.5rem calc(1.5rem + env(safe-area-inset-bottom));
    color: light-dark(#16181d, #ecedf1); background: light-dark(#ffffff, #15171c);
    font: 1rem/1.55 system-ui, sans-serif; text-align: center; }
  main { max-width: 24rem; }
  img { width: 5rem; height: 5rem; border-radius: 1.25rem; }
  h1 { margin: 1rem 0 .5rem; font-size: 1.5rem; }
  p { margin: 0 0 1.25rem; color: light-dark(#5c6270, #a3a9b6); }
  button { min-height: 2.75rem; padding: .5rem 1rem; color: #ffffff;
    background: ${THEME_COLOR}; border: 0; border-radius: .5rem; font: inherit;
    font-weight: 600; cursor: pointer; }
</style>
</head>
<body>
<main>
  <img src="/icon-192.png" alt="">
  <h1>Ruokalista odottaa verkkoyhteyttä</h1>
  <p>Ajantasaiset reseptit ja viikon ruokalista eivät ole käytettävissä ilman verkkoyhteyttä.</p>
  <button type="button" onclick="location.reload()">Yritä uudelleen</button>
</main>
<script>
  window.addEventListener("online", function () { location.reload(); });
</script>
</body>
</html>`;

// This script is deliberately ES5-shaped. It is progressive enhancement in the
// shared server-rendered shell and must remain harmless on older iPads.
export const PWA_CLIENT_SCRIPT = `
(function () {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;

  var fieldSelector = "input, textarea, select, [contenteditable='true']";
  var settled = new WeakMap();
  var registration = null;
  var updatePending = false;
  var reloading = false;
  var retryTimer = null;
  var inactiveAt = 0;
  var controlled = navigator.serviceWorker.controller !== null;
  var resumeAfter = 60000;

  function fieldValue(field) {
    if (field.matches("input[type='checkbox'], input[type='radio']")) {
      return field.checked ? "checked" : "unchecked";
    }
    if (field.matches("input[type='file']")) {
      var files = field.files || [];
      var names = [];
      for (var i = 0; i < files.length; i += 1) {
        names.push(files[i].name + ":" + files[i].size);
      }
      return names.join("|");
    }
    if (field.isContentEditable) return field.textContent || "";
    return field.value;
  }

  function snapshotFields() {
    var fields = document.querySelectorAll(fieldSelector);
    for (var i = 0; i < fields.length; i += 1) {
      if (!settled.has(fields[i])) settled.set(fields[i], fieldValue(fields[i]));
    }
  }

  function hasChangedField() {
    var fields = document.querySelectorAll(fieldSelector);
    for (var i = 0; i < fields.length; i += 1) {
      if (settled.has(fields[i]) && fieldValue(fields[i]) !== settled.get(fields[i])) return true;
    }
    return false;
  }

  function activelyEditing() {
    var active = document.activeElement;
    var focusedField = active && active.matches && active.matches(fieldSelector);
    return Boolean(focusedField || hasChangedField() || document.querySelector("details[open]"));
  }

  function reloadWhenIdle() {
    if (reloading || !updatePending || activelyEditing()) return;
    reloading = true;
    if (retryTimer !== null) clearInterval(retryTimer);
    location.reload();
  }

  function markInactive() {
    if (!inactiveAt) inactiveAt = Date.now();
  }

  function resume() {
    if (registration) registration.update().catch(function () {});
    if (!inactiveAt) return;
    var elapsed = Date.now() - inactiveAt;
    inactiveAt = 0;
    if (elapsed >= resumeAfter && !activelyEditing()) {
      reloading = true;
      location.reload();
    }
  }

  snapshotFields();
  new MutationObserver(snapshotFields).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
  window.addEventListener("pageshow", snapshotFields);
  window.addEventListener("blur", markInactive);
  window.addEventListener("focus", resume);
  window.addEventListener("pagehide", markInactive);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") markInactive();
    if (document.visibilityState === "visible") resume();
  });

  navigator.serviceWorker.addEventListener("controllerchange", function () {
    if (reloading) return;
    var wasControlled = controlled;
    controlled = navigator.serviceWorker.controller !== null;
    if (!wasControlled) return;
    updatePending = true;
    reloadWhenIdle();
    if (!reloading && retryTimer === null) retryTimer = setInterval(reloadWhenIdle, 3000);
  });

  window.addEventListener("load", function () {
    navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none"
    }).then(function (value) {
      registration = value;
      return registration.update();
    }).catch(function () {});
  });
}());`;

export const PUBLIC_PWA_PATHS = [
  "/manifest.webmanifest",
  "/offline",
  "/favicon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
] as const;

export async function contentGeneration(
  contents: readonly (string | ArrayBuffer)[],
): Promise<string> {
  const encoder = new TextEncoder();
  const chunks = contents.map((content) =>
    typeof content === "string" ? encoder.encode(content) : new Uint8Array(content)
  );
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength + 1, 0);
  const joined = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength + 1;
  }

  const digest = await crypto.subtle.digest("SHA-256", joined);
  return Array.from(new Uint8Array(digest).slice(0, 6))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function serviceWorkerSource(generation: string): string {
  return `"use strict";
var CACHE = "ruokalista-static-${generation}";
var PREFIX = "ruokalista-static-";
var ASSETS = ${JSON.stringify(PUBLIC_PWA_PATHS)};
var OFFLINE = "/offline";
var GATEWAY_DOWN = [502, 503, 504];

self.addEventListener("install", function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) {
    return Promise.all(ASSETS.map(function (url) {
      return fetch(url, { cache: "reload" }).then(function (response) {
        if (!response.ok) throw new Error(url + ": " + response.status);
        return cache.put(url, response);
      });
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (key) {
      return key.indexOf(PREFIX) === 0 && key !== CACHE;
    }).map(function (key) { return caches.delete(key); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then(function (response) {
      if (GATEWAY_DOWN.indexOf(response.status) !== -1) {
        return caches.match(OFFLINE).then(function (fallback) { return fallback || response; });
      }
      return response;
    }).catch(function () {
      return caches.match(OFFLINE).then(function (fallback) { return fallback || Response.error(); });
    }));
    return;
  }

  if (ASSETS.indexOf(url.pathname) === -1) return;
  event.respondWith(caches.open(CACHE).then(function (cache) {
    return fetch(request).then(function (response) {
      if (response.ok) {
        return cache.put(url.pathname, response.clone()).then(function () { return response; });
      }
      return response;
    }).catch(function () { return cache.match(url.pathname); });
  }));
});`;
}
