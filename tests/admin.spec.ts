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

test("the account menu offers the panel to an admin and not to a member", async ({
  context,
  page,
}) => {
  await context.addCookies([sessionCookie(1)]);
  await page.goto("/");
  await page.getByRole("button", { name: "Tili" }).click();
  await expect(page.getByRole("button", { name: "Kirjaudu ulos" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Ylläpito" })).toHaveCount(0);

  await context.clearCookies();
  await context.addCookies([sessionCookie(3)]);
  await page.goto("/");
  await page.getByRole("button", { name: "Tili" }).click();
  await page.getByRole("link", { name: "Ylläpito" }).click();
  await expect(page.getByRole("heading", { name: "Ylläpito" })).toBeVisible();
});

test("the same entry is on every screen, not only the week", async ({
  context,
  page,
}) => {
  // The link moved into the shell in #106, so a screen deep in the app offers
  // it too. Recipes, because it is the furthest from the week's own code.
  await context.addCookies([sessionCookie(3)]);
  await page.goto("/recipes");
  await page.getByRole("button", { name: "Tili" }).click();
  await expect(page.getByRole("link", { name: "Ylläpito" })).toBeVisible();
});

test("the week no longer carries an admin link of its own", async ({
  context,
  page,
}) => {
  await context.addCookies([sessionCookie(3)]);
  await page.goto("/");
  await expect(page.locator("main").getByRole("link", { name: "Ylläpito" })).toHaveCount(0);
});

test("the panel lists both admin tools", async ({ context, page }) => {
  await context.addCookies([sessionCookie(3)]);
  await page.goto("/admin");

  await expect(page.getByRole("link", { name: /Reseptikuvat/ })).toHaveAttribute(
    "href",
    "/admin/recipe-images",
  );
  await expect(page.getByRole("link", { name: /Reseptikuvat/ })).toContainText(
    "hallitse niiden kuvia",
  );
  await expect(
    page.getByRole("link", { name: /Tuo AgentDeck-reseptejä/ }),
  ).toHaveAttribute("href", "/intake/batch");
});

test("the AgentDeck import is gone from the member's own intake screen", async ({
  context,
  page,
}) => {
  await context.addCookies([sessionCookie(1)]);
  await page.goto("/intake");

  await expect(page.getByRole("heading", { name: "Lisää resepti" })).toBeVisible();
  await expect(page.locator('a[href="/intake/batch"]')).toHaveCount(0);
});

test("an admin walks from the panel into the AgentDeck import", async ({
  context,
  page,
}) => {
  await context.addCookies([sessionCookie(3)]);
  await page.goto("/admin");
  await page.getByRole("link", { name: /Tuo AgentDeck-reseptejä/ }).click();

  await expect(
    page.getByRole("heading", { name: "Tuo AgentDeck-reseptejä" }),
  ).toBeVisible();
});

test("an ordinary member is refused every AgentDeck import route", async ({
  request,
}) => {
  // The link being gone is tidiness. These are the routes, asked directly, in
  // the three ways a browser can reach them.
  const screen = await request.get("/intake/batch", {
    headers: { Cookie: cookieHeader(1) },
  });
  expect(screen.status()).toBe(404);
  expect(await screen.text()).toContain("Tätä sivua ei ole.");

  for (const path of ["/intake/batch/review", "/intake/batch/import"]) {
    const posted = await request.post(path, {
      headers: { Cookie: cookieHeader(1) },
      form: { bundle: "{}" },
    });
    expect(posted.status(), path).toBe(404);
    expect(await posted.text(), path).not.toContain("Tarkista reseptinippu");
  }
});

test("a signed-out browser is sent to sign in, not to the import", async ({
  request,
}) => {
  const screen = await request.get("/intake/batch", { maxRedirects: 0 });
  expect(screen.status()).toBe(302);
  expect(screen.headers()["location"]).toBe("/signin");

  const posted = await request.post("/intake/batch/import", {
    maxRedirects: 0,
    form: { bundle: "{}" },
  });
  expect(posted.status()).toBe(302);
  expect(posted.headers()["location"]).toBe("/signin");
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
