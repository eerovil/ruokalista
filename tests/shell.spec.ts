import { expect, test } from "@playwright/test";

import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * The mobile shell: bottom navigation for the main destinations, a small
 * account affordance at the top, and nothing at all for a browser that is not
 * signed in yet.
 */

test.beforeAll(reseed);

test("a signed-out screen has no app navigation", async ({ page }) => {
  await page.goto("/signin");
  await expect(page.locator("nav.tabs")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Tili" })).toHaveCount(0);
});

test.describe("signed in", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([sessionCookie(1)]);
  });

  test("every main destination is one thumb away", async ({ page }) => {
    await page.goto("/");

    const tabs = page.locator("nav.tabs a");
    await expect(tabs).toHaveCount(4);

    for (const [label, heading] of [
      ["Reseptit", "Reseptit"],
      ["Lisää", "Lisää resepti"],
      ["Ainekset", "Ainekset"],
      ["Viikko", "Viikko"],
    ] as const) {
      await page.locator("nav.tabs").getByRole("link", { name: label }).click();
      await expect(
        page.getByRole("heading", { level: 1, name: heading, exact: true }),
      ).toBeVisible();
    }
  });

  test("the current destination is marked", async ({ page }) => {
    await page.goto("/recipes");
    const current = page.locator("nav.tabs a[aria-current=page]");
    await expect(current).toHaveCount(1);
    await expect(current).toContainText("Reseptit");
  });

  // A recipe is not its own destination — it belongs to Reseptit, and the
  // shell should say so rather than going blank on every inner screen.
  test("an inner screen keeps its section marked", async ({ page }) => {
    await page.goto("/recipes/1");
    await expect(page.locator("nav.tabs a[aria-current=page]")).toContainText(
      "Reseptit",
    );
  });

  test("the tabs are a phone-sized target", async ({ page }) => {
    await page.goto("/");
    const box = await page.locator("nav.tabs a").first().boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  });

  // A fixed bar at the bottom of the screen is a good way to hide the last
  // thing on a page. The body reserves room for it.
  test("the tabs do not cover the end of a page", async ({ page }) => {
    await page.goto("/recipes/1");
    await page.keyboard.press("End");

    const last = page.locator("main :last-child").last();
    await expect(last).toBeInViewport();
  });

  test("signing out is reachable from the UI", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Tili" }).click();
    await page.getByRole("button", { name: "Kirjaudu ulos" }).click();

    await expect(page).toHaveURL(/\/signin$/);
    await page.goto("/recipes");
    await expect(page).toHaveURL(/\/signin$/);
  });
});
