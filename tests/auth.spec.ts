import { expect, test } from "@playwright/test";

import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/** Google is the gate, and there is no signup path anywhere in the app. */

// This file used to be the only spec without a reseed, so it quietly depended
// on rows an earlier run had left behind. It passed locally and failed on a
// fresh database — which is what "flaky" turned out to mean.
test.beforeAll(reseed);

test("a signed-out screen goes to sign-in", async ({ page }) => {
  await page.goto("/recipes");
  await expect(page).toHaveURL(/\/signin$/);
  await expect(page.getByRole("link", { name: /Kirjaudu Google/ })).toBeVisible();
});

test("a signed-out API call answers JSON, not a redirect", async ({ request }) => {
  const response = await request.get("/api/recipes");
  expect(response.status()).toBe(401);
  expect(await response.json()).toHaveProperty("error");
});

test("/ is the week, which is the point of the app", async ({ context, page }) => {
  await context.addCookies([sessionCookie(1)]);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Viikko", exact: true })).toBeVisible();
  await expect(page.locator(".day")).toHaveCount(7);
});

test("a cookie that has expired is not entry", async ({ context, page }) => {
  await context.addCookies([sessionCookie(1, -60)]);
  await page.goto("/recipes");
  await expect(page).toHaveURL(/\/signin$/);
});

test("a tampered signature is not entry", async ({ context, page }) => {
  const cookie = sessionCookie(1);
  const [memberId, expiresAt, signature] = cookie.value.split(".") as [
    string,
    string,
    string,
  ];

  // The FIRST character of the signature, not the last. A base64url string's
  // final character carries spare bits, so several different characters decode
  // to the same bytes — changing it left the signature valid about one run in
  // sixteen, which is what this test's flakiness turned out to be.
  const flipped = (signature[0] === "A" ? "B" : "A") + signature.slice(1);

  await context.addCookies([
    { ...cookie, value: `${memberId}.${expiresAt}.${flipped}` },
  ]);

  await page.goto("/recipes");
  await expect(page).toHaveURL(/\/signin$/);
});

test("signing out clears the session", async ({ context, page }) => {
  await context.addCookies([sessionCookie(1)]);
  await page.goto("/recipes");
  await expect(page.getByRole("heading", { name: "Reseptit" })).toBeVisible();

  await page.request.post("/auth/signout");
  await context.clearCookies();

  await page.goto("/recipes");
  await expect(page).toHaveURL(/\/signin$/);
});

test("starting sign-in hands you to Google with a signed state", async ({
  page,
}) => {
  const response = await page.request.get("/auth/google", {
    maxRedirects: 0,
  });
  expect(response.status()).toBe(302);

  const location = response.headers()["location"] ?? "";
  expect(location).toContain("accounts.google.com");
  expect(location).toContain("redirect_uri=");
  expect(location).toContain("state=");
});
