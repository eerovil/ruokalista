import { expect, test } from "@playwright/test";

import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * A recipe opened from a day shows the amounts that day actually needs. The
 * source line underneath still says what the page said, so nothing is lost.
 */

test.beforeAll(reseed);

test.beforeEach(async ({ context }) => {
  await context.addCookies([sessionCookie(1)]);
});

test("from the recipe list, a recipe reads exactly as written", async ({
  page,
}) => {
  await page.goto("/recipes/1");

  await expect(page.locator(".yield")).toContainText("4 annosta");
  const lines = page.locator(".lines li");
  await expect(lines.nth(0)).toContainText("½ dl");
  await expect(lines.nth(1)).toContainText("1–1½ l");
  await expect(lines.nth(2)).toContainText("½ kpl (500 g)");
});

test("planned for six from a yield of four, the amounts follow", async ({
  page,
}) => {
  await page.goto("/recipes/1?portions=6");

  await expect(page.locator(".yield")).toContainText("6 annokselle");
  await expect(page.locator(".yield")).toContainText("reseptissä 4");

  const lines = page.locator(".lines li");
  await expect(lines.nth(0)).toContainText("¾ dl");
  // Both ends of the range move.
  await expect(lines.nth(1)).toContainText("1½–2¼ l");
  // A second measurement scales with the first.
  await expect(lines.nth(2)).toContainText("¾ kpl (750 g)");
  // A line the page gave no amount for is left alone.
  await expect(lines.nth(3)).toContainText("sitruunaruoho");
  await expect(lines.nth(3)).not.toContainText("0");
});

test("the original stays readable underneath", async ({ page }) => {
  await page.goto("/recipes/1?portions=6");
  await expect(page.locator(".lines li").first().locator(".source")).toHaveText(
    "½ dl öljyä",
  );
});

test("cooking exactly what it yields changes nothing", async ({ page }) => {
  await page.goto("/recipes/1?portions=4");
  await expect(page.locator(".yield")).toContainText("4 annosta");
  await expect(page.locator(".lines li").first()).toContainText("½ dl");
});

test("a recipe with no yield still says it cannot be scaled", async ({
  page,
}) => {
  await page.goto("/recipes/2?portions=12");
  await expect(page.locator(".yield")).toContainText("ei voi skaalata");
});

test("a nonsense portion count is ignored", async ({ page }) => {
  for (const bad of ["0", "-3", "puoltatoista", ""]) {
    await page.goto(`/recipes/1?portions=${bad}`);
    await expect(page.locator(".yield")).toContainText("4 annosta");
  }
});

test("a dish's factor reaches into its parts", async ({ page }) => {
  // Lasagne yields 6; cooking for 8 is x1.333.
  await page.goto("/recipes/3?portions=8");

  const parts = page.locator(".part");
  // 400 g -> 533.3, which a scale shows as 530.
  await expect(parts.nth(0)).toContainText("530 g");
  // 5 dl -> 6.666, which nobody pours. And 2 dl -> 2.666, small enough to keep
  // a quarter.
  await expect(parts.nth(1)).toContainText("6½ dl");
  await expect(parts.nth(1)).toContainText("2¾ dl");
});

test("opening a part on its own does not inherit a factor", async ({ page }) => {
  await page.goto("/recipes/4");
  await expect(page.locator(".lines li").first()).toContainText("400 g");
});

test("the week carries the day's portions into the recipe", async ({ page }) => {
  await page.goto("/picker?date=2026-12-01&slot=dinner");
  const row = page.locator(".pick li", { hasText: "Kaalilaatikko" });
  await row.locator("input[name=portions]").fill("6");
  await row.getByRole("button", { name: "Lisää" }).click();

  await page.locator(".entry a").first().click();

  await expect(page).toHaveURL(/\/recipes\/1\?portions=6$/);
  await expect(page.locator(".yield")).toContainText("6 annokselle");
  await expect(page.locator(".lines li").first()).toContainText("¾ dl");
});

test("re-portioning a day changes what the recipe opens at", async ({ page }) => {
  await page.goto("/picker?date=2026-12-02&slot=lunch");
  await page
    .locator(".pick li", { hasText: "Kaalilaatikko" })
    .getByRole("button", { name: "Lisää" })
    .click();

  const tuesday = page.locator(".day", { hasText: "2.12." });
  await tuesday.locator(".entry input[name=portions]").fill("2");
  await tuesday.getByRole("button", { name: "Päivitä" }).click();

  await page.locator(".day", { hasText: "2.12." }).locator(".entry a").click();
  await expect(page).toHaveURL(/portions=2$/);
  // Half of ½ dl is ¼ dl.
  await expect(page.locator(".lines li").first()).toContainText("¼ dl");
});
