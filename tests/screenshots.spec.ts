import { expect, test } from "@playwright/test";

import { AGENTDECK_BATCH } from "./support/batch";
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
    await page.locator(".entry a").first().click();
    await page.getByRole("link", { name: "Jatkuu…" }).click();
    await page.locator('input[value="2026-10-06:lunch"]').check();
    await page.locator('input[value="2026-10-07:lunch"]').check();
    await expect(page.locator('input[value="2026-10-07:lunch"]')).toBeChecked();
    await page.screenshot({
      path: `${SHOTS}/19-batch-coverage.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Tallenna jatkumo" }).click();
    await page.getByRole("link", { name: "Takaisin erään" }).click();
    await page.getByRole("link", { name: "Takaisin viikkoon" }).click();
    await expect(page.locator(".batch-start")).toBeVisible();
    await expect(page.locator(".batch-end")).toBeVisible();
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

  test("a recipe with a picture, and the editor that put it there", async ({
    page,
  }) => {
    // Built rather than committed, so what the shot shows is a picture that
    // really went through the upload path.
    const canvas = await page.evaluate(() => {
      const el = document.createElement("canvas");
      el.width = 900;
      el.height = 600;
      const ctx = el.getContext("2d");
      if (ctx === null) return "";
      const sky = ctx.createLinearGradient(0, 0, 0, 600);
      sky.addColorStop(0, "#c8703c");
      sky.addColorStop(1, "#7d3f1d");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, 900, 600);
      ctx.fillStyle = "#f2e2cf";
      ctx.beginPath();
      ctx.arc(450, 320, 190, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#a9552a";
      ctx.beginPath();
      ctx.arc(450, 320, 150, 0, Math.PI * 2);
      ctx.fill();
      return el.toDataURL("image/png").split(",")[1] ?? "";
    });

    await page.request.put("/api/recipes/1/image", {
      headers: { "content-type": "image/png" },
      data: Buffer.from(canvas, "base64"),
    });

    await page.goto("/recipes/1");
    await expect(page.locator(".recipe-image img")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/22-recipe-image.png`, fullPage: true });

    await page.goto("/recipes/1/edit");
    await expect(page.locator(".recipe-image-editor img")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/23-editor-image.png`, fullPage: true });

    // The list, with one recipe pictured and the rest showing the placeholder —
    // which is the point of the placeholder, so the shot has to show both.
    await page.goto("/recipes");
    await expect(page.locator(".recipes .recipe-image img")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/24-recipes-images.png`, fullPage: true });

    await page.goto("/picker?date=2026-10-05&slot=dinner");
    await expect(page.locator(".pick .recipe-image img")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/25-picker-images.png`, fullPage: true });

    await page.request.post("/api/batches", {
      data: { date: "2026-10-06", slot: "dinner", recipeId: 1, portions: 4 },
    });
    await page.goto("/?week=2026-10-05");
    await expect(page.locator(".entry .recipe-image img").first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/26-week-images.png`, fullPage: true });

    // Put it back, so the recipe every other shot photographs is unchanged.
    await page.request.delete("/api/recipes/1/image");
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

  test("AgentDeck batch review", async ({ page }) => {
    await page.goto("/intake/batch");
    await page.getByLabel("…tai JSON tekstinä").fill(JSON.stringify(AGENTDECK_BATCH));
    await page.getByRole("button", { name: "Tarkista nippu" }).click();
    await expect(page.locator(".batch-previews details")).toHaveCount(2);
    await expect(page.locator(".batch-ingredients")).toContainText("kikherne");
    await page.locator(".batch-previews details").first().evaluate((details) => {
      (details as HTMLDetailsElement).open = true;
    });
    await expect(page.locator(".batch-previews details").first()).toHaveAttribute("open", "");
    await page.screenshot({
      path: `${SHOTS}/20-agentdeck-batch-review.png`,
      fullPage: true,
    });
  });

  test("AgentDeck stale ingredient review", async ({ page }) => {
    const bundle = structuredClone(AGENTDECK_BATCH);
    bundle.recipes = [bundle.recipes[0]];
    await page.goto("/intake/batch");
    await page.getByLabel("…tai JSON tekstinä").fill(JSON.stringify(bundle));
    await page.getByRole("button", { name: "Tarkista nippu" }).click();
    await page.locator('select[data-proposed-index="0"]').selectOption({
      label: "Käytä olemassa olevaa: vesi",
    });
    await page.request.post("/ingredients/5/rename", {
      form: { name: "kikherne" },
    });
    await page.getByRole("button", { name: "Tuo 1 reseptiä" }).click();
    await expect(
      page.getByRole("heading", { name: "Tarkista reseptinippu uudelleen" }),
    ).toBeVisible();
    await expect(page.locator(".refused")).toContainText(
      "Talouden ainekset muuttuivat tarkistamisen jälkeen",
    );
    await page.screenshot({
      path: `${SHOTS}/21-agentdeck-stale-review.png`,
      fullPage: true,
    });
    await page.request.post("/ingredients/5/rename", {
      form: { name: "ananas" },
    });
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
    const cookingText = await page.locator("main").innerText();
    expect(cookingText.indexOf("Lämmitä uuni")).toBeLessThan(
      cookingText.indexOf("Jauhelihakastike"),
    );
    expect(cookingText.indexOf("Juustokastike")).toBeLessThan(
      cookingText.indexOf("Kokoa vuokaan"),
    );
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
