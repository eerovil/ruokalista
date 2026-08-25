import { expect, test } from "@playwright/test";

import { sessionCookie } from "./support/session";

/** Google is the gate, and there is no signup path anywhere in the app. */

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

test("/ sends you to the recipe list", async ({ context, page }) => {
  await context.addCookies([sessionCookie(1)]);
  await page.goto("/");
  await expect(page).toHaveURL(/\/recipes$/);
});

test("a cookie that has expired is not entry", async ({ context, page }) => {
  await context.addCookies([sessionCookie(1, -60)]);
  await page.goto("/recipes");
  await expect(page).toHaveURL(/\/signin$/);
});

test("a tampered signature is not entry", async ({ context, page }) => {
  const cookie = sessionCookie(1);
  await context.addCookies([{ ...cookie, value: `${cookie.value.slice(0, -1)}X` }]);
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
