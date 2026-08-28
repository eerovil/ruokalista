import { expect, test } from "@playwright/test";

import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * A recipe opened from a planned batch shows the amounts that cooking actually
 * needs. Since #165 the number that decides them is a multiplier, not a portion
 * count: the recipe as written is 1×, so a dish whose source never stated a
 * yield scales exactly like one that did. The source line underneath still says
 * what the page said, so nothing is lost.
 */

test.beforeAll(reseed);

test.beforeEach(async ({ context }) => {
  await context.addCookies([sessionCookie(1)]);
});

test("from the recipe list, a recipe reads exactly as written", async ({
  page,
}) => {
  await page.goto("/recipes/1");

  await expect(page.locator(".yield")).toContainText("1× · resepti sellaisenaan");
  const lines = page.locator(".lines li");
  await expect(lines.nth(0)).toContainText("½ dl");
  await expect(lines.nth(1)).toContainText("1–1½ l");
  await expect(lines.nth(2)).toContainText("½ kpl (500 g)");
});

test("what the source said it makes is metadata, not a control", async ({
  page,
}) => {
  await page.goto("/recipes/1");
  await expect(page.locator(".source-yield")).toHaveText("Lähteessä 4 annosta");

  // A recipe whose source never said simply has no such line.
  await page.goto("/recipes/2");
  await expect(page.locator(".source-yield")).toHaveCount(0);
});

test("at 1,5× the amounts follow", async ({ page }) => {
  await page.goto("/recipes/1?multiplier=1.5");

  await expect(page.locator(".yield")).toHaveText("1,5×");

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

test("half a recipe halves every amount", async ({ page }) => {
  await page.goto("/recipes/1?multiplier=0.5");

  await expect(page.locator(".yield")).toHaveText("0,5×");
  await expect(page.locator(".lines li").first()).toContainText("¼ dl");
});

test("twice the recipe doubles every amount", async ({ page }) => {
  await page.goto("/recipes/1?multiplier=2");

  await expect(page.locator(".yield")).toHaveText("2×");
  await expect(page.locator(".lines li").first()).toContainText("1 dl");
});

test("a scaled amount says what the page said", async ({ page }) => {
  await page.goto("/recipes/1?multiplier=1.5");
  await expect(page.locator(".lines li").first().locator(".source")).toHaveText(
    "½ dl öljyä",
  );
});

test("unscaled, the amounts are the page’s and say nothing twice", async ({
  page,
}) => {
  await page.goto("/recipes/1");
  await expect(page.locator(".lines li").first().locator(".source")).toHaveCount(
    0,
  );
});

test("which amounts you are looking at is obvious from the top", async ({
  page,
}) => {
  await page.goto("/recipes/1");
  await expect(page.locator(".yield.is-scaled")).toHaveCount(0);

  await page.goto("/recipes/1?multiplier=1.5");
  await expect(page.locator(".yield.is-scaled")).toBeVisible();
  await expect(page.locator(".yield.is-scaled")).toHaveText("1,5×");
});

test("1× is the recipe as written", async ({ page }) => {
  await page.goto("/recipes/1?multiplier=1");
  await expect(page.locator(".yield")).toContainText("resepti sellaisenaan");
  await expect(page.locator(".lines li").first()).toContainText("½ dl");
});

test("a recipe with no stated yield scales like any other (#165)", async ({
  page,
}) => {
  // Öljykastike: the source never said what it makes. Before #165 this screen
  // could only apologise; now the recipe as written is 1× and 2× is 2×.
  await page.goto("/recipes/2");
  await expect(page.locator(".yield")).toContainText("resepti sellaisenaan");
  await expect(page.locator(".lines li").nth(1)).toContainText("2 dl");

  await page.goto("/recipes/2?multiplier=2");
  await expect(page.locator(".yield")).toHaveText("2×");
  await expect(page.locator(".lines li").nth(1)).toContainText("4 dl");
  // The line the source gave no amount for is still left alone.
  await expect(page.locator(".lines li").nth(0)).toContainText("öljy");
});

test("a nonsense multiplier is ignored rather than obeyed", async ({ page }) => {
  for (const bad of ["0", "-3", "puoltatoista", "", "Infinity"]) {
    await page.goto(`/recipes/1?multiplier=${bad}`);
    await expect(page.locator(".yield")).toContainText("resepti sellaisenaan");
    await expect(page.locator(".lines li").first()).toContainText("½ dl");
  }
});

test("a dish's multiplier reaches into its parts", async ({ page }) => {
  // Lasagne at 4/3 — the awkward multiplier the rounding exists for.
  await page.goto("/recipes/3?multiplier=1.33");

  const parts = page.locator(".part");
  // 400 g -> 532, which a scale shows as 530.
  await expect(parts.nth(0)).toContainText("530 g");
  // 5 dl -> 6.65, which nobody pours. And 2 dl -> 2.66, small enough to keep
  // a quarter.
  await expect(parts.nth(1)).toContainText("6½ dl");
  await expect(parts.nth(1)).toContainText("2¾ dl");
});

test("a multipart dish doubles in every part at once", async ({ page }) => {
  await page.goto("/recipes/3?multiplier=2");

  const parts = page.locator(".part");
  await expect(parts.nth(0)).toContainText("800 g");
  await expect(parts.nth(1)).toContainText("10 dl");
  await expect(parts.nth(1)).toContainText("4 dl");
});

test("opening a part on its own does not inherit a multiplier", async ({
  page,
}) => {
  await page.goto("/recipes/4");
  await expect(page.locator(".lines li").first()).toContainText("400 g");
});

test("the week carries the batch's multiplier into the recipe", async ({
  page,
}) => {
  await page.goto("/picker?date=2026-12-01&slot=dinner");
  const row = page.locator(".pick li", { hasText: "Kaalilaatikko" });
  await row.locator("input[name=multiplier]").fill("1,5");
  await row.getByRole("button", { name: "Lisää" }).click();

  await page.locator(".entry a").first().click();
  await page.getByRole("link", { name: "Avaa resepti" }).click();

  await expect(page).toHaveURL(/\/recipes\/1\?multiplier=1\.5$/);
  await expect(page.locator(".yield")).toHaveText("1,5×");
  await expect(page.locator(".lines li").first()).toContainText("¾ dl");
});

test("changing a batch's multiplier changes what the recipe opens at", async ({
  page,
}) => {
  await page.goto("/picker?date=2026-12-02&slot=lunch");
  await page
    .locator(".pick li", { hasText: "Kaalilaatikko" })
    .getByRole("button", { name: "Lisää" })
    .click();

  await page.locator(".day", { hasText: "2.12." }).locator(".entry a").click();
  await page.locator(".multiplier-choice").getByRole("button", { name: "0,5×" }).click();

  await page.locator(".day", { hasText: "2.12." }).locator(".entry a").click();
  await page.getByRole("link", { name: "Avaa resepti" }).click();
  await expect(page).toHaveURL(/multiplier=0\.5$/);
  // Half of ½ dl is ¼ dl.
  await expect(page.locator(".lines li").first()).toContainText("¼ dl");
});

test("a multiplier the chips do not offer can still be typed", async ({
  page,
}) => {
  await page.goto("/picker?date=2026-12-03&slot=dinner");
  await page
    .locator(".pick li", { hasText: "Kaalilaatikko" })
    .getByRole("button", { name: "Lisää" })
    .click();

  await page.locator(".day", { hasText: "3.12." }).locator(".entry a").click();
  // The Finnish comma, the way every other number field in the app takes it.
  await page.locator(".multiplier-choice input").fill("2,5");
  await page.locator(".multiplier-choice").getByRole("button", { name: "Tallenna" }).click();

  await page.locator(".day", { hasText: "3.12." }).locator(".entry a").click();
  await page.getByRole("link", { name: "Avaa resepti" }).click();
  await expect(page.locator(".yield")).toHaveText("2,5×");
});
