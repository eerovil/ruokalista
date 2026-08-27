import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

test.use({ serviceWorkers: "allow" });

const PUBLIC_ASSETS = [
  "/manifest.webmanifest",
  "/offline",
  "/favicon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
].sort();

test.beforeAll(reseed);

async function warmPwa(page: Page): Promise<void> {
  await page.goto("/signin");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect.poll(
    () => page.evaluate(() => navigator.serviceWorker.controller !== null),
  ).toBe(true);
}

async function cachedPaths(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const paths: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        paths.push(new URL(request.url).pathname);
      }
    }
    return paths.sort();
  });
}

async function setVisibility(page: Page, state: "hidden" | "visible") {
  await page.evaluate((next) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: next,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

test("Chromium sees Ruokalista's origin-bound install identity", async ({
  context,
  page,
  request,
}) => {
  await page.addInitScript(() => {
    window.addEventListener("pageshow", () => {
      const count = Number(sessionStorage.getItem("pwa-pageshows") ?? "0");
      sessionStorage.setItem("pwa-pageshows", String(count + 1));
    });
  });
  await page.goto("/signin");

  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  );
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    "href",
    "/apple-touch-icon.png",
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#1f5d3c",
  );
  expect(await page.locator("style").textContent()).toContain(
    "env(safe-area-inset-top)",
  );

  const response = await request.get("/manifest.webmanifest");
  expect(response.headers()["content-type"]).toContain(
    "application/manifest+json",
  );
  const manifest = await response.json();
  expect(manifest).toMatchObject({
    name: "Ruokalista",
    lang: "fi",
    id: "./ruokalista-pwa",
    start_url: "./",
    scope: "./",
    display: "standalone",
  });

  const cdp = await context.newCDPSession(page);
  const processed = await cdp.send("Page.getAppManifest");
  const origin = new URL(page.url()).origin;
  expect(processed.errors ?? []).toEqual([]);
  expect(processed.url).toBe(`${origin}/manifest.webmanifest`);
  expect(processed.manifest.id).toBe(`${origin}/ruokalista-pwa`);
  expect(processed.manifest.startUrl).toBe(`${origin}/`);
  expect(processed.manifest.scope).toBe(`${origin}/`);

  await expect.poll(
    () => context.serviceWorkers().map((worker) => worker.url()),
  ).toContain(`${origin}/sw.js`);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect.poll(
    () => page.evaluate(() => navigator.serviceWorker.controller !== null),
  ).toBe(true);
  // The first worker claiming a newly installed page is not an update and must
  // not reload that page.
  expect(await page.evaluate(() => sessionStorage.getItem("pwa-pageshows"))).toBe(
    "1",
  );
});

test("the worker headers and cached contents keep household state out", async ({
  context,
  page,
  request,
}) => {
  const worker = await request.get("/sw.js");
  expect(worker.headers()["content-type"]).toContain("text/javascript");
  expect(worker.headers()["cache-control"]).toBe("no-cache");
  expect(worker.headers()["service-worker-allowed"]).toBe("/");

  await context.addCookies([sessionCookie(1)]);
  await warmPwa(page);
  await page.goto("/recipes/1");
  await page.evaluate(async () => {
    await fetch("/api/ingredients");
    await fetch("/api/recipes/1/image");
  });
  await page.goto("/ingredients");

  expect(await cachedPaths(page)).toEqual(PUBLIC_ASSETS);
  for (const privatePath of [
    "/recipes/1",
    "/ingredients",
    "/api/ingredients",
    "/api/recipes/1/image",
    "/signin",
  ]) {
    expect(await cachesPath(page, privatePath)).toBe(false);
  }
});

async function cachesPath(page: Page, path: string): Promise<boolean> {
  return page.evaluate(async (candidate) => {
    for (const name of await caches.keys()) {
      if (await (await caches.open(name)).match(candidate)) return true;
    }
    return false;
  }, path);
}

test("offline navigation is honest and returns to the requested live page", async ({
  context,
  page,
}) => {
  await context.addCookies([sessionCookie(1)]);
  await warmPwa(page);
  await page.goto("/recipes/1");

  await context.setOffline(true);
  await page.goto("/recipes/1", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "Ruokalista odottaa verkkoyhteyttä" }),
  ).toBeVisible();
  await expect(page.getByText("Kaalilaatikko")).toHaveCount(0);
  const requestedUrl = page.url();
  expect(new URL(requestedUrl).pathname).toBe("/recipes/1");

  await context.setOffline(false);
  await page.getByRole("button", { name: "Yritä uudelleen" }).click();
  await expect(page.getByRole("heading", { name: "Kaalilaatikko" })).toBeVisible();
  expect(page.url()).toBe(requestedUrl);
});

test("a worker update cannot reload a dirty or focused editor", async ({
  context,
  page,
}) => {
  await context.addCookies([sessionCookie(1)]);
  await warmPwa(page);
  await page.goto("/recipes/1/edit");
  await page.locator("#title").fill("Kesken oleva nimi");
  await page.locator("#title").focus();

  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(new Event("controllerchange"));
  });

  await expect(page.locator("#title")).toHaveValue("Kesken oleva nimi");
  await expect(page.locator("#title")).toBeFocused();
  await expect(page).toHaveURL(/\/recipes\/1\/edit$/);
});

test("a meaningful resume refreshes reading but preserves editing", async ({
  context,
  page,
}) => {
  // Member 3 rather than 1: this case needs a rename to land mid-test so the
  // resume has something to refresh to, and renaming a global ingredient is an
  // admin operation since #143. They are in the same household, so everything
  // else on screen is unchanged.
  await context.addCookies([sessionCookie(3)]);
  await page.addInitScript(() => {
    const clock = { now: Date.now() };
    Object.defineProperty(window, "pwaTestClock", { value: clock });
    Date.now = () => clock.now;
  });
  await warmPwa(page);
  await page.goto("/ingredients");

  const renamed = await context.request.patch("/api/ingredients/1", {
    data: { name: "Seesamiöljy" },
  });
  expect(renamed.status()).toBe(204);
  await setVisibility(page, "hidden");
  await page.evaluate(() => {
    const clock = (window as typeof window & { pwaTestClock: { now: number } })
      .pwaTestClock;
    clock.now += 60_001;
  });
  await setVisibility(page, "visible");
  await expect(page.getByText("Seesamiöljy", { exact: true })).toBeVisible();

  await page.goto("/recipes/1/edit");
  await page.locator("#title").fill("Tätä ei saa hukata");
  await page.locator("#title").focus();
  await setVisibility(page, "hidden");
  await page.evaluate(() => {
    const clock = (window as typeof window & { pwaTestClock: { now: number } })
      .pwaTestClock;
    clock.now += 60_001;
  });
  await setVisibility(page, "visible");
  await expect(page.locator("#title")).toHaveValue("Tätä ei saa hukata");
  await expect(page.locator("#title")).toBeFocused();
});
