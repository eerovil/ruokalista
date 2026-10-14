import { expect, test } from "@playwright/test";

import { sessionCookie } from "./support/session";

/**
 * A hand-walk of the whole product, kept out of `npm run check` and CI — this
 * file is run on demand to look at the app, not to assert about it.
 *
 *   ./scripts/playwright.sh env PLAYWRIGHT_WALKTHROUGH=1 \
 *     npx playwright test walkthrough
 *
 * It deliberately does not reseed: it is meant to be pointed at whatever the
 * development database currently holds.
 */

const SHOTS = "walkthrough";

test.beforeEach(async ({ context }) => {
  await context.addCookies([sessionCookie(1)]);
});

test("import the sample and cook what it made", async ({ page }) => {
  await page.goto("/intake");
  await page.getByRole("button", { name: "Avaa esimerkkiluonnos" }).click();

  await expect(page.locator(".review-title")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/1-review.png`, fullPage: true });

  await page.getByRole("button", { name: "Tallenna resepti" }).click();
  await expect(page).toHaveURL(/\/recipes\/\d+$/);
  await page.screenshot({ path: `${SHOTS}/2-saved.png`, fullPage: true });

  // Put it on the to-do list at 2×, then open it from there and check it
  // scaled.
  await page.locator(".cook-add").getByRole("button", { name: "2×", exact: true }).click();

  await expect(page).toHaveURL(/\/$/);
  await page.screenshot({ path: `${SHOTS}/3-list.png`, fullPage: true });

  await page.locator(".cook-edit").first().click();
  await page.screenshot({ path: `${SHOTS}/4-dish.png`, fullPage: true });

  await page.getByRole("link", { name: "Avaa resepti" }).click();
  await expect(page.locator(".yield.is-scaled")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/5-cooking.png`, fullPage: true });
});
