import { expect, test } from "@playwright/test";

import { sessionCookie } from "./support/session";

/**
 * A hand-walk of the whole product, kept out of `npm run check` and CI — this
 * file is run on demand to look at the app, not to assert about it.
 *
 *   ./scripts/playwright.sh npx playwright test walkthrough
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

  // Plan it, then open it from the day and check it scaled.
  await page.goto("/picker?date=2026-09-07&slot=dinner");
  await page
    .locator(".pick li", { hasText: "Uunikaali" })
    .first()
    .locator("input[name=portions]")
    .fill("8");
  await page
    .locator(".pick li", { hasText: "Uunikaali" })
    .first()
    .getByRole("button", { name: "Lisää" })
    .click();

  await expect(page).toHaveURL(/\/\?week=/);
  await page.screenshot({ path: `${SHOTS}/3-week.png`, fullPage: true });

  await page.locator(".day .entry a").first().click();
  await page.screenshot({ path: `${SHOTS}/4-meal.png`, fullPage: true });

  await page.getByRole("link", { name: "Avaa resepti" }).click();
  await expect(page.locator(".yield.is-scaled")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/5-cooking.png`, fullPage: true });
});
