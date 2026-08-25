import { expect, test } from "@playwright/test";

import { stubStructuring } from "./support/draft";
import { openDraftEditor } from "./support/lines";
import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * Review artifacts: one picture per screen, committed under docs/screenshots so
 * a pull request can be looked at without running anything.
 *
 * These are not golden images — nothing compares them, so a font rendering a
 * pixel differently cannot fail a build.
 *
 * The bottom navigation is `position: fixed`, and a full-page screenshot paints
 * a fixed element where the viewport left it — so on a long page the tabs show
 * up partway down the picture. That is the screenshot, not the app.
 *
 * Regenerate with:
 *
 *   ./scripts/playwright.sh npx playwright test screenshots
 */

const SHOTS = "docs/screenshots";

test.beforeAll(reseed);

test("sign-in", async ({ page }) => {
  await page.goto("/signin");
  await page.screenshot({ path: `${SHOTS}/01-signin.png`, fullPage: true });
});

test.describe("signed in", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([sessionCookie(1)]);
  });

  test("the week", async ({ page }) => {
    await page.goto("/?week=2026-10-05");
    await page
      .locator(".day")
      .first()
      .locator(".empty-slot")
      .first()
      .click();
    await page
      .locator(".pick li", { hasText: "Kaalilaatikko" })
      .getByRole("button", { name: "Lisää" })
      .click();
    await expect(page.locator(".entry").first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/02-week.png`, fullPage: true });
  });

  test("what you can do to a planned meal", async ({ page }) => {
    await page.goto("/picker?date=2026-10-13&slot=dinner");
    await page
      .locator(".pick li", { hasText: "Kaalilaatikko" })
      .getByRole("button", { name: "Lisää" })
      .click();
    await page.locator(".day .entry a").first().click();
    await expect(page.getByRole("link", { name: "Avaa resepti" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/15-meal-actions.png`, fullPage: true });
  });

  test("the recipe picker", async ({ page }) => {
    await page.goto("/picker?date=2026-10-06&slot=dinner");
    await expect(page.locator(".pick li").first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/03-picker.png`, fullPage: true });
  });

  test("recipe list", async ({ page }) => {
    await page.goto("/recipes");
    await expect(page.locator(".recipes li").first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/04-recipes.png`, fullPage: true });
  });

  test("one recipe", async ({ page }) => {
    await page.goto("/recipes/1");
    await expect(page.locator(".lines li").first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/05-recipe.png`, fullPage: true });
  });

  test("older iPad keep-awake confirmation", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "wakeLock", {
        configurable: true,
        value: undefined,
      });
      HTMLMediaElement.prototype.play = function () {
        return Promise.resolve();
      };
    });
    await page.goto("/recipes/1");
    await page.getByRole("button", { name: "Pidä näyttö hereillä" }).click();
    await expect(page.locator("#keep-awake-status")).toHaveText(
      "Näyttö pysyy hereillä.",
    );
    await page.screenshot({
      path: `${SHOTS}/18-keep-awake-fallback.png`,
      fullPage: true,
    });
  });

  test("a recipe that cannot be scaled", async ({ page }) => {
    await page.goto("/recipes/2");
    await expect(page.locator(".yield")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/06-recipe-no-yield.png`, fullPage: true });
  });

  test("intake", async ({ page }) => {
    await page.goto("/intake");
    await expect(
      page.getByLabel("…tai ota tai valitse kuva painetusta sivusta"),
    ).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/07-intake.png`, fullPage: true });
  });

  test("check and correct", async ({ page }) => {
    await stubStructuring(page);
    await page.goto("/intake");
    await page.getByLabel("Liitä reseptin teksti").fill("Uunikaali");
    await page.getByRole("button", { name: "Jäsennä" }).click();
    await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/08-correct.png`, fullPage: true });
  });

  test("the approval gate refusing", async ({ page }) => {
    await stubStructuring(page);
    await page.goto("/intake");
    await page.getByLabel("Liitä reseptin teksti").fill("Uunikaali");
    await page.getByRole("button", { name: "Jäsennä" }).click();
    await openDraftEditor(page);
    await page.locator(".line.is-new select").selectOption("");
    await page.getByRole("button", { name: "Tallenna resepti" }).click();
    await expect(page.locator(".refused")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/09-gate-refused.png`, fullPage: true });
  });

  test("a dish written in parts", async ({ page }) => {
    await page.goto("/recipes/3");
    await expect(page.locator(".part").first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/13-dish-in-parts.png`, fullPage: true });
  });

  test("a dish scaled to a planned day", async ({ page }) => {
    await page.goto("/recipes/3?portions=8");
    await expect(page.locator(".part").first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/14-scaled.png`, fullPage: true });
  });

  test("the recipe editor", async ({ page }) => {
    await page.goto("/recipes/1/edit");
    await expect(page.locator(".line").first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/11-editor.png`, fullPage: true });
  });

  test("confirming a deletion", async ({ page }) => {
    await page.goto("/recipes/3/delete");
    await expect(
      page.getByRole("button", { name: "Poista lopullisesti" }),
    ).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/16-confirm-delete.png`, fullPage: true });
  });

  test("a search that finds nothing", async ({ page }) => {
    await page.goto("/recipes?q=pizza");
    await expect(page.locator(".nothing")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/17-nothing-found.png`, fullPage: true });
  });

  test("the ingredient list", async ({ page }) => {
    await page.goto("/ingredients");
    await expect(page.locator(".ingredients li").first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/12-ingredients.png`, fullPage: true });
  });

  test("search results", async ({ page }) => {
    await page.goto("/recipes?q=kaali");
    await expect(page.locator(".recipes li")).toHaveCount(1);
    await page.screenshot({ path: `${SHOTS}/10-recipes-search.png`, fullPage: true });
  });
});
