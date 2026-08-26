import { expect, test } from "@playwright/test";

import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * The one capability boundary: ordinary member or admin, and nothing in
 * between. These tests go at the routes directly rather than through the link,
 * because the link is tidiness and the route is the boundary.
 */

test.beforeAll(reseed);

test("an admin reaches the admin screen", async ({ context, page }) => {
  await context.addCookies([sessionCookie(3)]);
  await page.goto("/admin");

  await expect(page.getByRole("heading", { name: "Ylläpito" })).toBeVisible();
});

test("an ordinary member is told the admin screen is not there", async ({
  context,
  page,
}) => {
  await context.addCookies([sessionCookie(1)]);
  const response = await page.goto("/admin");

  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Ei löytynyt" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ylläpito" })).toHaveCount(0);
});

test("an ordinary member cannot reach the admin API either", async ({
  request,
}) => {
  const response = await request.get("/api/admin/status", {
    headers: { Cookie: cookieHeader(1) },
  });

  expect(response.status()).toBe(404);
  expect(await response.json()).toHaveProperty("error");
});

test("an admin's own cookie is what answers the admin API", async ({
  request,
}) => {
  const response = await request.get("/api/admin/status", {
    headers: { Cookie: cookieHeader(3) },
  });

  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ admin: true, memberId: 3 });
});

test("a signed-out caller gets nothing from either admin route", async ({
  request,
}) => {
  const screen = await request.get("/admin", { maxRedirects: 0 });
  expect(screen.status()).toBe(302);
  expect(screen.headers()["location"]).toBe("/signin");

  const api = await request.get("/api/admin/status");
  expect(api.status()).toBe(401);
});

test("the way in is hidden from an ordinary member and shown to an admin", async ({
  context,
  page,
}) => {
  await context.addCookies([sessionCookie(1)]);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Ylläpito" })).toHaveCount(0);

  await context.clearCookies();
  await context.addCookies([sessionCookie(3)]);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Ylläpito" })).toBeVisible();
});

test("nothing the caller says can make them an admin", async ({ request }) => {
  // Admin comes from the member row. A header, a query string or a form field
  // claiming otherwise is just more of the request, and the request is not
  // asked. This is the check that fails if somebody ever reads one of these.
  const claims = [
    "/api/admin/status?admin=1",
    "/api/admin/status?isAdmin=true",
    "/api/admin/status?memberId=3",
  ];

  for (const url of claims) {
    const response = await request.get(url, {
      headers: {
        Cookie: cookieHeader(1),
        "X-Admin": "true",
        "X-Forwarded-Host": "127.0.0.1",
      },
    });

    expect(response.status(), url).toBe(404);
  }
});

function cookieHeader(memberId: number): string {
  const cookie = sessionCookie(memberId);
  return `${cookie.name}=${cookie.value}`;
}
