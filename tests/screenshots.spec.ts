import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

import { AGENTDECK_BATCH } from "./support/batch";
import {
  DUPLICATE_AMOUNT_DRAFT,
  stubStructuring,
} from "./support/draft";
import { addIngredientRow, openDraftEditor, openMore } from "./support/lines";
import { flatPng } from "./support/png";
import { executeLocalSql, reseed } from "./support/seed";
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
 * The flows and assertions in this spec are behavioural coverage, so they run
 * in every ordinary suite. Only writing the review artifacts is opt-in.
 * Regenerate them with:
 *
 *   PLAYWRIGHT_SCREENSHOTS=1 ./scripts/playwright.sh npx playwright test screenshots
 */

const SHOTS = "docs/screenshots";
const writeScreenshots = process.env["PLAYWRIGHT_SCREENSHOTS"] === "1";

async function capture(
  page: Page,
  options: Parameters<Page["screenshot"]>[0],
): Promise<void> {
  if (writeScreenshots) {
    await page.screenshot(options);
  }
}

test.beforeAll(reseed);

test("sign-in", async ({ page }) => {
  await page.goto("/signin");
  await capture(page, { path: `${SHOTS}/01-signin.png`, fullPage: true });
});

test("Cast receiver", async ({ page }) => {
  await page.route(
    "https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js",
    async (route) =>
      route.fulfill({ contentType: "application/javascript", body: "" }),
  );
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/cast/receiver");
  await page.evaluate(() => {
    (
      window as typeof window & {
        __ruokalistaCastReceive(recipe: unknown): void;
      }
    ).__ruokalistaCastReceive({
        version: 1,
        title: "Kaalilaatikko",
        multiplier: "1,5×",
        ingredients: [{
          title: "",
          items: [
            "¾ dl öljy",
            "1½–2¼ l vesi",
            "¾ kpl (750 g) valkokaali",
            "hieman sitruunaruohoa",
          ],
        }],
        instructions: [{
          title: "",
          items: [
            "Kuullota kaali öljyssä.",
            "Lisää vesi ja sitruunaruoho.",
            "Hauduta kaalilaatikko kypsäksi.",
          ],
        }],
      });
  });
  await expect(page.getByRole("heading", { name: "Kaalilaatikko" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ainekset" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Valmistus" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollHeight))
    .toBeLessThanOrEqual(1080);
  await capture(page, { path: `${SHOTS}/63-cast-receiver.png` });
});

test("Cast receiver, long recipe on a Nest Hub", async ({ page }) => {
  await page.route(
    "https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js",
    async (route) =>
      route.fulfill({ contentType: "application/javascript", body: "" }),
  );
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.goto("/cast/receiver");
  await page.evaluate(() => {
    (
      window as typeof window & {
        __ruokalistaCastReceive(recipe: unknown): void;
      }
    ).__ruokalistaCastReceive({
      version: 1,
      title: "Mausteinen makkarastroganoff, perunoita ja raikasta salaattia",
      multiplier: "1×",
      ingredients: [{
        title: "",
        items: [
          "400 g nautamakkaraa",
          "2 kpl sipulia",
          "3 kynttä valkosipulia",
          "2 rkl tomaattipyreetä",
          "2 dl kermaa",
          "2 dl lihalientä",
          "1 rkl sinappia",
          "1 tl paprikajauhetta",
          "1 tl savupaprikaa",
          "½ tl chilirouhetta",
          "1 tl kuivattua timjamia",
          "2 laakerinlehteä",
          "1 rkl voita",
          "1 rkl öljyä",
          "800 g perunoita",
          "1 nippu tilliä",
          "1 kpl jäävuorisalaattia",
          "2 kpl tomaattia",
          "1 kpl kurkkua",
          "hieman suolaa ja mustapippuria",
        ],
      }],
      instructions: [{
        title: "",
        items: [
          "Kuori perunat ja keitä ne kypsiksi suolatussa vedessä.",
          "Kuutioi makkara ja ruskista se voi-öljyseoksessa.",
          "Lisää sipuli ja valkosipuli, kuullota pehmeiksi.",
          "Lisää tomaattipyree ja kypsennä hetki.",
          "Kaada joukkoon lihaliemi ja mausteet.",
          "Hauduta kastiketta noin 20 minuuttia.",
          "Lisää kerma ja sinappi, tarkista maku.",
          "Pilko salaatti, tomaatti ja kurkku kulhoon.",
          "Tarjoa stroganoff perunoiden, tillin ja salaatin kanssa.",
        ],
      }],
    });
  });
  await expect(page.locator(".columns")).toHaveClass("columns split");
  await expect(page.locator(".ingredients li")).toHaveCount(20);
  expect(await page.evaluate(() => document.documentElement.scrollHeight))
    .toBeLessThanOrEqual(600);
  await capture(page, { path: `${SHOTS}/64-cast-receiver-long.png` });
});

test("intake requires JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  await context.addCookies([sessionCookie(1)]);
  const page = await context.newPage();

  await page.goto("/intake");
  await expect(page.locator("#status")).toHaveText(
    "Reseptin tuonti tarvitsee JavaScriptin.",
  );
  await expect(page.getByRole("button", { name: "Jäsennä" })).toBeDisabled();
  await page.locator("#status").evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  await expect(page.locator("#status")).toBeInViewport();
  await capture(page, {
    path: `${SHOTS}/57-intake-requires-javascript.png`,
  });

  await context.close();
});

test.describe("PWA", () => {
  test.use({ serviceWorkers: "allow" });

  test("offline shell", async ({ page, context }) => {
    await page.goto("/signin");
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await expect.poll(
      () => page.evaluate(() => navigator.serviceWorker.controller !== null),
    ).toBe(true);
    await context.setOffline(true);
    await page.goto("/recipes/1", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Ruokalista odottaa verkkoyhteyttä" }),
    ).toBeVisible();
    await capture(page, { path: `${SHOTS}/31-pwa-offline.png`, fullPage: true });
    await context.setOffline(false);
  });
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
    await capture(page, {
      path: `${SHOTS}/19-batch-coverage.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Tallenna jatkumo" }).click();
    await page.getByRole("link", { name: "Takaisin erään" }).click();
    await page.getByRole("link", { name: "Takaisin viikkoon" }).click();
    await expect(page.locator(".batch-start")).toBeVisible();
    await expect(page.locator(".batch-end")).toBeVisible();
    await capture(page, { path: `${SHOTS}/02-week.png`, fullPage: true });
  });

  test("a batch spanning several days is one card", async ({ page }) => {
    const lunches = await createBatch(page, "2026-12-07", "lunch", 1);
    await setCoverage(page, lunches, [
      ["2026-12-07", "lunch"],
      ["2026-12-08", "dinner"],
      ["2026-12-09", "lunch"],
      ["2026-12-09", "dinner"],
    ]);
    const dinners = await createBatch(page, "2026-12-07", "dinner", 2);
    await setCoverage(page, dinners, [
      ["2026-12-07", "dinner"],
      ["2026-12-08", "lunch"],
    ]);

    await page.goto("/?week=2026-12-07");
    await expect(page.locator(".batch-card")).toHaveCount(2);
    await expect(page.locator(".day").first().locator(".batch-card")).toHaveCount(2);
    await expect(page.locator(".batch-when-day")).toHaveCount(5);
    await expect(page.locator(".batch-end")).toHaveCount(2);
    const tuesday = page.locator(".day").nth(1);
    await expect(tuesday.locator(".covered-status")).toHaveText("✓ katettu");
    await expect(tuesday.locator(".continuing-row")).toHaveCount(2);
    await expect(tuesday.locator(".continuing-title")).toHaveText([
      "Öljykastike",
      "Kaalilaatikko",
    ]);
    await expect(tuesday.locator(".continuing-slots")).toHaveText([
      "Lounas",
      "Päivällinen",
    ]);
    await expect(tuesday.locator(".slot-actions a")).toHaveText([
      "+ Lounas",
      "+ Päivällinen",
    ]);
    const wednesday = page.locator(".day").nth(2);
    await expect(wednesday.locator(".continuing-slots")).toHaveText(
      "Lounas · Päivällinen",
    );
    await capture(page, {
      path: `${SHOTS}/24-multi-day-batch.png`,
      fullPage: true,
    });

    // A second, cropped shot for #138 rather than repurposing the one above:
    // full-page, the fixed bottom tabs land across Tuesday's second row, and
    // the covered days are the whole point of this one.
    await tuesday.evaluate((element) => {
      window.scrollTo(
        0,
        element.getBoundingClientRect().top + window.pageYOffset - 80,
      );
    });
    expect(await page.evaluate(() => window.pageYOffset)).toBeGreaterThan(0);
    await expect(tuesday.locator(".continuing-card")).toBeInViewport();
    await expect(tuesday.locator(".slot-actions")).toBeInViewport();
    await expect(wednesday.locator(".continuing-card")).toBeInViewport();
    await capture(page, { path: `${SHOTS}/49-covered-days.png` });
  });

  /**
   * Deliberately not `fullPage`: what it is evidence of is where the viewport
   * lands, and a full-page capture cannot show that.
   */
  test("an empty current week opens on today", async ({ page }) => {
    await page.goto("/");
    const today = page.locator(".day.is-today");
    await expect(page.locator(".batch-card")).toHaveCount(0);
    await expect(today).toBeInViewport();
    await capture(page, { path: `${SHOTS}/36-week-empty-today.png` });
  });

  test("today in the current week", async ({ page }) => {
    const now = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Helsinki",
    }).format(new Date());
    const tomorrow = new Date(`${now}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const id = await createBatch(page, now, "lunch", 1);
    await setCoverage(page, id, [
      [now, "lunch"],
      [now, "dinner"],
      [tomorrow.toISOString().slice(0, 10), "lunch"],
    ]);

    await page.goto("/");
    const today = page.locator(".day.is-today");
    await expect(today.locator(".today-badge")).toHaveText("Tänään");
    await expect(today.locator(".batch-card")).toHaveCount(1);
    await capture(page, {
      path: `${SHOTS}/27-week-today.png`,
      fullPage: true,
    });
  });

  test("what you can do to a planned meal", async ({ page }) => {
    await page.goto("/picker?date=2026-10-13&slot=dinner");
    await page
      .locator(".pick li", { hasText: "Kaalilaatikko" })
      .getByRole("button", { name: "Lisää" })
      .click();
    await page.locator(".day .entry a").first().click();
    await expect(page.getByRole("link", { name: "Avaa resepti" })).toBeVisible();
    await capture(page, { path: `${SHOTS}/15-meal-actions.png`, fullPage: true });
  });

  test("the recipe picker", async ({ page }) => {
    await page.goto("/picker?date=2026-10-06&slot=dinner");
    await expect(page.locator(".pick li").first()).toBeVisible();
    const multipliers = page.locator(".pick-multiplier");
    await expect(multipliers).toHaveCount(4);
    await expect(multipliers.first()).toHaveValue("1×");
    await capture(page, { path: `${SHOTS}/03-picker.png`, fullPage: true });
  });

  test("recipe list", async ({ page }) => {
    await page.goto("/recipes");
    await expect(page.locator(".recipes li").first()).toBeVisible();
    await capture(page, { path: `${SHOTS}/04-recipes.png`, fullPage: true });
  });

  test("one recipe", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/recipes/1");
    await expect(page.locator(".lines li").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Valmistus" })).toBeVisible();
    await expect(page.locator(".steps li").last()).toBeInViewport();
    await expect(page.getByText("Näytä kaikki määrät", { exact: true }))
      .toBeInViewport();
    await capture(page, { path: `${SHOTS}/05-recipe.png` });
  });

  /**
   * Issues #120 and #135's whole surface: the method as it reads by default,
   * with two ingredients tapped open, and with the recipe-wide layer open.
   * Cooking for eight rather than four, so the revealed figures are visibly
   * this meal's and not the page's.
   */
  test("ingredient amounts revealed in the method", async ({ page }) => {
    await page.goto("/recipes/1?multiplier=2");
    const kaali = page
      .locator(".steps .mention")
      .filter({ has: page.locator(".mention-word", { hasText: "kaali" }) });
    const vesi = page
      .locator(".steps .mention")
      .filter({ has: page.locator(".mention-word", { hasText: "vesi" }) });
    const revealAll = page.locator(".reveal-all-label");

    await expect(kaali.locator(".mention-amount")).toBeHidden();
    await expect(revealAll).toBeVisible();
    const methodBox = await page.locator(".steps").last().boundingBox();
    const toggleBox = await revealAll.boundingBox();
    expect(methodBox).not.toBeNull();
    expect(toggleBox).not.toBeNull();
    expect(toggleBox!.y).toBeGreaterThanOrEqual(
      methodBox!.y + methodBox!.height,
    );
    await capture(page, {
      path: `${SHOTS}/38-step-mentions-closed.png`,
      fullPage: true,
    });

    await kaali.locator("label").click();
    await vesi.locator("label").click();
    await expect(kaali.locator(".mention-amount")).toBeVisible();
    await expect(vesi.locator(".mention-amount")).toBeVisible();
    await capture(page, {
      path: `${SHOTS}/39-step-mentions-open.png`,
      fullPage: true,
    });

    await page.locator(".reveal-all-label").click();
    await expect(page.locator(".reveal-all")).toBeChecked();
    await expect(page.locator(".mention-amount:visible")).toHaveCount(3);
    await expect(page.getByText("Piilota määrät", { exact: true })).toBeVisible();
    await capture(page, {
      path: `${SHOTS}/48-step-mentions-all-open.png`,
      fullPage: true,
    });
  });

  test("a duplicated ingredient reveals all its amounts", async ({ page }) => {
    await stubStructuring(page, DUPLICATE_AMOUNT_DRAFT);
    await page.goto("/intake");
    await page.getByLabel("Liitä reseptin teksti").fill("Perunasalaatti");
    await page.getByRole("button", { name: "Jäsennä" }).click();
    await page.getByRole("button", { name: "Tallenna resepti" }).click();
    await expect(page).toHaveURL(/\/recipes\/\d+$/);
    const recipe = page.url();

    const oil = page
      .locator(".steps .mention")
      .filter({ has: page.locator(".mention-word", { hasText: /^öljyssä$/ }) });
    await oil.locator("label").click();
    await expect(oil.locator(".mention-amount")).toBeVisible();
    await expect(oil.locator(".mention-amount")).toHaveText("2 rkl / 1 dl");
    await capture(page, {
      path: `${SHOTS}/40-step-mention-all-amounts.png`,
      fullPage: true,
    });

    await page.goto(`${recipe}/delete`);
    await page.getByRole("button", { name: "Poista lopullisesti" }).click();
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
    await capture(page, { path: `${SHOTS}/22-recipe-image.png`, fullPage: true });

    await page.goto("/recipes/1/edit");
    await expect(page.locator(".recipe-image-editor img")).toBeVisible();
    await capture(page, { path: `${SHOTS}/23-editor-image.png`, fullPage: true });

    // The list, with one recipe pictured and the rest showing the placeholder —
    // which is the point of the placeholder, so the shot has to show both.
    await page.goto("/recipes");
    await expect(page.locator(".recipes .recipe-image img")).toBeVisible();
    await capture(page, { path: `${SHOTS}/24-recipes-images.png`, fullPage: true });

    await page.goto("/picker?date=2026-10-05&slot=dinner");
    await expect(page.locator(".pick .recipe-image img")).toBeVisible();
    await capture(page, { path: `${SHOTS}/25-picker-images.png`, fullPage: true });

    await page.request.post("/api/batches", {
      data: { date: "2026-10-06", slot: "dinner", recipeId: 1, multiplier: 1 },
    });
    await page.goto("/?week=2026-10-05");
    await expect(page.locator(".entry .recipe-image img").first()).toBeVisible();
    await capture(page, { path: `${SHOTS}/26-week-images.png`, fullPage: true });

    // Put it back, so the recipe every other shot photographs is unchanged.
    await page.request.delete("/api/recipes/1/image");
  });

  /**
   * Issue #116, on a phone: the square, part-transparent picture the generator
   * actually produces, shown on the recipe screen. The shot is the evidence
   * that the dish is whole rather than cropped into a strip, that the
   * transparent corners sit on the ordinary surface colour, and that the title
   * and ingredients still start right underneath it.
   */
  test("a square generated picture on the recipe screen", async ({ page }) => {
    const square = await page.evaluate(() => {
      const el = document.createElement("canvas");
      el.width = 512;
      el.height = 512;
      const ctx = el.getContext("2d");
      if (ctx === null) return "";
      // Transparent everywhere the dish is not — exactly what a cut cell is.
      ctx.fillStyle = "#c8703c";
      ctx.beginPath();
      ctx.arc(256, 256, 240, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#f2e2cf";
      ctx.beginPath();
      ctx.arc(256, 256, 180, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#7d3f1d";
      for (let at = 0; at < 6; at += 1) {
        const angle = (at / 6) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(256 + Math.cos(angle) * 110, 256 + Math.sin(angle) * 110, 34, 0, Math.PI * 2);
        ctx.fill();
      }
      return el.toDataURL("image/png").split(",")[1] ?? "";
    });

    await page.request.put("/api/recipes/1/image", {
      headers: { "content-type": "image/png" },
      data: Buffer.from(square, "base64"),
    });

    await page.goto("/recipes/1");
    const hero = page.locator(".recipe-image.is-hero img");
    await expect(hero).toBeVisible();
    // The intended state, asserted before the shutter: the whole square is
    // drawn inside the band rather than cropped to fill it.
    await expect(hero).toHaveCSS("object-fit", "contain");
    await expect(hero).toHaveJSProperty("naturalWidth", 512);
    await capture(page, {
      path: `${SHOTS}/35-recipe-image-square.png`,
      fullPage: true,
    });

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
    await capture(page, {
      path: `${SHOTS}/18-keep-awake-fallback.png`,
      fullPage: true,
    });
  });

  test("a recipe whose source never stated a yield, scaled anyway (#165)", async ({
    page,
  }) => {
    await page.goto("/recipes/2?multiplier=2");
    await expect(page.locator(".yield")).toHaveText("2×");
    await capture(page, { path: `${SHOTS}/06-recipe-no-yield.png`, fullPage: true });
  });

  test("intake", async ({ page }) => {
    await page.goto("/intake");
    await expect(
      page.getByLabel("…tai ota kuva painetusta sivusta"),
    ).toBeVisible();
    await expect(
      page.getByLabel("…tai valitse kuvia kuvakirjastosta"),
    ).toBeVisible();
    await capture(page, { path: `${SHOTS}/07-intake.png`, fullPage: true });
  });

  test("a recipe photographed across a spread", async ({ page }) => {
    await page.goto("/intake");

    // Two pages of a printed recipe, added the way a person adds them: the
    // first shot with the camera, the second picked from the library.
    await page.evaluate(async () => {
      const shoot = async (inputId: string, heading: string, body: string[]) => {
        const canvas = document.createElement("canvas");
        canvas.width = 900;
        canvas.height = 1200;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#f4efe6";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#221c14";
        context.font = "bold 74px Georgia, serif";
        context.fillText(heading, 70, 190);
        context.font = "48px Georgia, serif";
        body.forEach((line, index) => {
          context.fillText(line, 70, 330 + index * 90);
        });

        const blob = await new Promise<Blob>((resolve) =>
          canvas.toBlob((b) => resolve(b!), "image/jpeg", 0.9),
        );
        const transfer = new DataTransfer();
        transfer.items.add(
          new File([blob], `${heading}.jpg`, { type: "image/jpeg" }),
        );
        const input = document.getElementById(inputId) as HTMLInputElement;
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      };

      await shoot("camera", "Uunikaali", [
        "4 annosta",
        "1 valkokaali",
        "2 rkl öljyä",
        "1 tl suolaa",
        "2 dl kermaa",
      ]);
      await shoot("photo", "Näin teet", [
        "Lämmitä uuni 200",
        "asteeseen. Lohko kaali",
        "ja levitä vuokaan.",
        "Valuta öljy päälle ja",
        "paista 45 minuuttia.",
      ]);
    });

    // Both pages really landed in the list, numbered in reading order.
    await expect(page.locator("#chosen li .page-name")).toHaveText([
      "Sivu 1",
      "Sivu 2",
    ]);
    await capture(page, {
      path: `${SHOTS}/56-intake-two-pages.png`,
      fullPage: true,
    });
  });

  test("check and correct", async ({ page }) => {
    await stubStructuring(page);
    await page.goto("/intake");
    await page.getByLabel("Liitä reseptin teksti").fill("Uunikaali");
    await page.getByRole("button", { name: "Jäsennä" }).click();
    await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toBeVisible();
    await capture(page, { path: `${SHOTS}/08-correct.png`, fullPage: true });
  });

  test("a background import that failed", async ({ page }) => {
    executeLocalSql(
      `INSERT INTO intake_job
        (id, household_id, created_by, status, source_route, source_text,
         error_message, created_at, updated_at)
       VALUES ('screenshot-failed', 1, 1, 'failed', 'pasted',
         'Uunikaali\n1 kaali\n½ dl öljyä\nPaista uunissa 200 asteessa.',
         'Reseptin jäsennys ei onnistunut. Yritä uudelleen.',
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    );
    await page.goto("/intake");
    await expect(page.locator(".refused")).toContainText("jäsennys ei onnistunut");
    await expect(page.getByRole("button", { name: "Yritä uudelleen" })).toBeVisible();
    await page.getByText("Alkuperäinen teksti").click();
    await expect(page.getByText("Uunikaali\n1 kaali\n½ dl öljyä\nPaista uunissa 200 asteessa.")).toBeVisible();
    await capture(page, {
      path: `${SHOTS}/73-intake-background-failed.png`,
      fullPage: true,
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
    await capture(page, { path: `${SHOTS}/09-gate-refused.png`, fullPage: true });
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
    await capture(page, { path: `${SHOTS}/13-dish-in-parts.png`, fullPage: true });
  });

  test("a dish scaled to a planned day", async ({ page }) => {
    await page.goto("/recipes/3?multiplier=1.5");
    await expect(page.locator(".part").first()).toBeVisible();
    await capture(page, { path: `${SHOTS}/14-scaled.png`, fullPage: true });
  });

  test("the recipe editor", async ({ page }) => {
    await page.goto("/recipes/1/edit");
    await expect(page.locator(".line").first()).toBeVisible();
    await capture(page, { path: `${SHOTS}/11-editor.png`, fullPage: true });
  });

  /**
   * Issue #184's two halves, both of them viewport shots rather than full-page
   * ones: a full-page capture paints a sticky element at the end of its
   * container, which is exactly the position this change exists to stop it
   * being in.
   */
  test("the editor's save bar rides the scroll on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 720 });
    await page.goto("/recipes/1/edit");
    await page.getByRole("heading", { name: "Ainekset" }).scrollIntoViewIfNeeded();

    // The intended state, asserted before the shutter: the ingredient rows are
    // what is being looked at, and Tallenna is on screen anyway.
    await expect(page.locator(".line").first()).toBeInViewport();
    await expect(
      page.getByRole("button", { name: "Tallenna muutokset" }),
    ).toBeInViewport();
    await capture(page, { path: `${SHOTS}/65-editor-save-bar.png` });
  });

  test("editing a dish that has no ingredients of its own", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 720 });

    // Take the lasagne's one own line away, leaving a dish whose ingredients
    // all sit on its two parts.
    await page.goto("/recipes/3/edit");
    await page.locator(".line").first().locator("> details.line-more > summary").click();
    await page.locator(".line").first().locator("input[name$=remove]").check();
    await page.getByRole("button", { name: "Tallenna muutokset" }).click();
    await expect(page).toHaveURL(/\/recipes\/3$/);

    // The editor of that dish: no ingredient rows at all, and it opens fine.
    await page.goto("/recipes/3/edit");
    await expect(page.locator(".line")).toHaveCount(0);
    await page.getByRole("heading", { name: "Ainekset" }).scrollIntoViewIfNeeded();
    // A viewport shot again, for the same reason as the one above.
    await capture(page, { path: `${SHOTS}/66-parts-only-editor.png` });

    // Saved, not refused: the old "Reseptissä pitää olla ainakin yksi aines."
    // is what this shot is here to show the absence of.
    await page.getByRole("button", { name: "Tallenna muutokset" }).click();
    await expect(page).toHaveURL(/\/recipes\/3$/);
    await expect(page.locator(".refused")).toHaveCount(0);
    await expect(page.locator(".part")).toHaveCount(2);
    await capture(page, { path: `${SHOTS}/67-parts-only-dish.png`, fullPage: true });

    // This spec seeds once for the whole file, so put back what was removed.
    reseed();
  });

  test("a removal the steps still argue with", async ({ page }) => {
    await page.goto("/recipes/1/edit");
    // A fifth row asked for by hand, so the shot shows the add button having
    // done its job as well as the row it makes.
    await addIngredientRow(page);
    await page.locator(".line").nth(4).locator("select").selectOption({
      label: "ananas",
    });
    await page.locator(".line").nth(4).locator("input[name$=quantity]").fill("1");

    // The saved row is sitruunaruoho. Even if it is repointed on the same
    // submit, removing it is refused because the last step still names the
    // saved ingredient.
    const linked = page.locator(".line").nth(3);
    await linked.locator("select").selectOption({ label: "valkokaali" });
    await linked.locator("input[name$=remove]").check();
    await page.getByRole("button", { name: "Tallenna muutokset" }).click();

    await expect(page.locator(".line-conflicts")).toContainText("Vaihe 3");
    await expect(page.locator(".refused")).toContainText("sitruunaruoho");
    await expect(linked.locator("select")).toHaveValue("3");
    await expect(page.getByRole("button", { name: "Poista silti" })).toBeVisible();
    await capture(page, {
      path: `${SHOTS}/47-editor-remove-mentioned.png`,
      fullPage: true,
    });
  });

  test("confirming a deletion", async ({ page }) => {
    await page.goto("/recipes/3/delete");
    await expect(
      page.getByRole("button", { name: "Poista lopullisesti" }),
    ).toBeVisible();
    await capture(page, { path: `${SHOTS}/16-confirm-delete.png`, fullPage: true });
  });

  test("a search that finds nothing", async ({ page }) => {
    await page.goto("/recipes?q=pizza");
    await expect(page.locator(".nothing")).toBeVisible();
    await capture(page, { path: `${SHOTS}/17-nothing-found.png`, fullPage: true });
  });

  /**
   * The shopping list (#123), on a fortnight planned relative to today —
   * because the screen's fortnight and its five-day default are relative to
   * today too, so a fixed October week would photograph an empty screen.
   *
   * Two shots: the list as it opens, and the same list with a total opened to
   * show what it is made of.
   */
  test("the shopping list", async ({ page }) => {
    const soon = shiftedFromToday(0);
    const later = shiftedFromToday(2);

    const planned = [
      await createBatch(page, soon, "dinner", 1, 2),
      await createBatch(page, later, "dinner", 3, 1),
    ];

    await page.goto("/ostoslista");
    await expect(page.locator(".shopping-list > li").first()).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "Kaalilaatikko + Lasagne",
    );
    await capture(page, { path: `${SHOTS}/38-shopping-list.png`, fullPage: true });

    const milk = page.locator(".shopping-item", { hasText: "maito" }).first();
    await milk.locator("summary").click();
    await milk.getByRole("button", { name: "Valitse tuote" }).click();
    const product = milk.locator(".s-product-results > li", {
      hasText: "Kotimaista rasvaton maito",
    });
    await expect(product).toBeVisible();
    await capture(page, {
      path: `${SHOTS}/57-s-ostoslista-product-search.png`,
      fullPage: true,
    });

    // Hold the optimistic save open, then try to send: the screen says it is
    // finishing the visible choice before it reads that mapping back from D1.
    let releaseSave: () => void = () => {};
    const heldSave = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    await page.route("**/ostoslista/tuote", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await heldSave;
      await route.continue();
    });
    await product.getByRole("button", { name: "Valitse" }).click();
    await expect(milk.locator(".s-shopping-product-summary")).toContainText(
      "Kotimaista rasvaton maito",
    );
    const send = page.locator(".s-send-form button");
    await send.click();
    await expect(send).toContainText("Tallennetaan valintoja");
    await expect(send.locator(".spinner")).toBeVisible();
    await capture(page, {
      path: `${SHOTS}/59-s-ostoslista-waits-for-product.png`,
      fullPage: true,
    });

    const sent = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/ostoslista/laheta"),
    );
    releaseSave();
    await sent;
    await page.unroute("**/ostoslista/tuote");
    await expect(page.locator(".shopping-sent")).toContainText(
      "lähetettiin S-ostoslistaan",
    );
    await expect(
      page.locator(".s-current-items li").filter({ hasText: "Kotimaista rasvaton maito" }),
    ).toHaveCount(1);

    // The choice itself, back on the list: the picture on the row, and the
    // S-ostoslista panel saying what the list already holds (#159).
    await milk.evaluate((details: HTMLDetailsElement) => {
      details.open = false;
    });
    await capture(page, {
      path: `${SHOTS}/58-s-ostoslista-current.png`,
      fullPage: true,
    });

    await milk.evaluate((details: HTMLDetailsElement) => {
      details.open = true;
    });
    await page.locator(".shopping-picker > summary").click();
    await expect(milk.locator(".shopping-from li").first()).toBeVisible();
    await capture(page, {
      path: `${SHOTS}/39-shopping-breakdown.png`,
      fullPage: true,
    });

    // The product chosen above is the same linked product the recipe now shows.
    // Photograph that real path rather than seeding a display-only shortcut.
    // The extra height keeps the fixed bottom navigation off the changed row
    // in Playwright's full-page rendering.
    await page.setViewportSize({ width: 1024, height: 1200 });
    await page.goto("/recipes/3");
    const recipeThumb = page
      .locator(".recipe-ingredient", { hasText: "maito" })
      .locator(".recipe-product-thumb");
    await expect(recipeThumb).toBeVisible();
    await expect(
      page.locator(".recipe-ingredient", { hasText: "juusto" }).locator("img"),
    ).toHaveCount(0);
    await capture(page, {
      path: `${SHOTS}/60-recipe-product-thumbnail.png`,
      fullPage: true,
    });

    // Only what this shot planned goes away again; the week screenshot above
    // has a cooking on today too, and it is not this test's to delete.
    for (const id of planned) {
      await page.request.delete(`/api/batches/${id}`);
    }
  });

  /**
   * #161: an ingredient that knows more than one packet, and a recipe allowed
   * its own product.
   *
   * The fixture is two lasagne cookings, one of them a double batch, so the
   * milk really does need one and a half litres — the state where a package
   * count is the whole point rather than decoration.
   */
  test("packages and a recipe's own product", async ({ page }) => {
    const planned = [
      await createBatch(page, shiftedFromToday(0), "dinner", 3, 1),
      await createBatch(page, shiftedFromToday(1), "dinner", 3, 2),
    ];

    await page.goto("/ostoslista");
    const milk = page.locator(".shopping-item", { hasText: "maito" }).first();
    await expect(milk.locator(".shopping-total")).toHaveText("15 dl");

    // The panel, with the one question #161 adds to it: how far this reaches.
    // The shopping-list shot above already chose a product for milk and this
    // file reseeds once, so the button may read either way by now.
    await milk.locator("summary").click();
    await milk.getByRole("button", { name: /Valitse tuote|Vaihda tuote/ }).click();
    const product = milk.locator(".s-product-results > li", {
      hasText: "Kotimaista rasvaton maito",
    });
    await expect(product).toBeVisible();
    await expect(milk.locator(".s-product-scope-choice")).toBeVisible();
    await capture(page, {
      path: `${SHOTS}/60-product-scope-choice.png`,
      fullPage: true,
    });

    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/ostoslista/tuote"),
    );
    await product.getByRole("button", { name: "Valitse" }).click();
    await saved;
    await page.reload();

    // 15 dl does not fit in one litre, so the row buys two — and says so.
    const counted = page.locator(".shopping-item", { hasText: "maito" }).first();
    await counted.locator("summary").click();
    await expect(counted.locator(".s-shopping-product-summary")).toContainText(
      "2 × Kotimaista rasvaton maito 1 l",
    );
    await expect(counted.locator(".s-package-total")).toContainText("2 l");
    await capture(page, {
      path: `${SHOTS}/61-package-count.png`,
      fullPage: true,
    });

    // A second package size, taught from the row itself rather than a settings
    // page, and listed underneath with the size that was stored for it.
    await counted.getByRole("button", { name: "Lisää toinen pakkauskoko" }).click();
    const second = counted.locator(".s-product-results > li", {
      hasText: "Valio kevytmaito",
    });
    await expect(second).toBeVisible();
    await Promise.all([
      page.waitForEvent("load"),
      second.getByRole("button", { name: "Valitse" }).click(),
    ]);

    const sized = page.locator(".shopping-item", { hasText: "maito" }).first();
    await sized.locator("summary").click();
    await expect(sized.locator(".s-product-sizes > li")).toHaveCount(2);
    await capture(page, {
      path: `${SHOTS}/62-package-sizes.png`,
      fullPage: true,
    });

    for (const id of planned) {
      await page.request.delete(`/api/batches/${id}`);
    }
  });

  /**
   * The cupboard, used rather than empty: two staples put in from the list,
   * the list split into its two sections, and the cupboard's own page.
   */
  test("the cupboard, and the list it splits in two", async ({ page }) => {
    const planned = [
      await createBatch(page, shiftedFromToday(0), "dinner", 1, 2),
      await createBatch(page, shiftedFromToday(2), "dinner", 3, 1),
    ];

    await page.goto("/ostoslista");
    for (const name of ["öljy", "maito"]) {
      const item = page
        .locator(".shopping-item", { hasText: name })
        .first();
      await item.locator("summary").click();
      await item.getByRole("button", { name: "Löytyy jo kaapista" }).click();
    }

    // The Löytyy section is really there, with its rows and their amounts,
    // before anything is photographed.
    const found = page.locator(".shopping-section", { hasText: "Löytyy" });
    await expect(found).toBeVisible();
    await expect(
      page.locator(".shopping-list").last().locator("> li"),
    ).toHaveCount(2);
    await capture(page, {
      path: `${SHOTS}/40-shopping-pantry.png`,
      fullPage: true,
    });

    await page.goto("/kaappi");
    await expect(page.locator(".pantry li")).toHaveCount(2);
    await capture(page, { path: `${SHOTS}/41-pantry.png`, fullPage: true });

    // Leave the cupboard and the week as they were found: the shots above and
    // below share this database.
    for (const id of [1, 9]) {
      await page.request.post(`/kaappi/${id}/poista`);
    }
    for (const id of planned) {
      await page.request.delete(`/api/batches/${id}`);
    }
  });

  test("the ingredient list", async ({ page }) => {
    await page.goto("/ingredients");
    await expect(page.locator(".ingredients li").first()).toBeVisible();
    await capture(page, { path: `${SHOTS}/12-ingredients.png`, fullPage: true });
  });

  test("search results", async ({ page }) => {
    await page.goto("/recipes?q=kaali");
    await expect(page.locator(".recipes li")).toHaveCount(1);
    await capture(page, { path: `${SHOTS}/10-recipes-search.png`, fullPage: true });
  });

  test("the account menu as an ordinary member sees it", async ({ page }) => {
    await page.goto("/?week=2026-10-05");
    await page.getByRole("button", { name: "Tili" }).click();
    await expect(page.getByRole("button", { name: "Kirjaudu ulos" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Ylläpito" })).toHaveCount(0);
    await capture(page, {
      path: `${SHOTS}/28-week-not-admin.png`,
      fullPage: true,
    });
  });
});

test.describe("signed in as an admin", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([sessionCookie(3)]);
  });

  test("the account menu, with the way into the admin surface", async ({
    page,
  }) => {
    await page.goto("/?week=2026-10-05");
    await page.getByRole("button", { name: "Tili" }).click();
    await expect(page.getByRole("link", { name: "Ylläpito" })).toBeVisible();
    await capture(page, {
      path: `${SHOTS}/29-week-admin.png`,
      fullPage: true,
    });
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
    await capture(page, {
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
    await capture(page, {
      path: `${SHOTS}/21-agentdeck-stale-review.png`,
      fullPage: true,
    });
    await page.request.post("/ingredients/5/rename", {
      form: { name: "ananas" },
    });
  });
  test("the admin screen", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Ylläpito" })).toBeVisible();
    await capture(page, { path: `${SHOTS}/30-admin.png`, fullPage: true });
  });

  test("every household, and one of them open", async ({ page }) => {
    await page.goto("/admin/households");
    await expect(page.getByRole("heading", { name: "Householdit" })).toBeVisible();
    // Both seeded households, including the one this admin is not in — that
    // crossing is the whole point of the screen.
    await expect(page.getByRole("link", { name: /Naapuri/ })).toBeVisible();
    await capture(page, {
      path: `${SHOTS}/42-admin-households.png`,
      fullPage: true,
    });

    await page.getByRole("link", { name: /Koti/ }).click();
    // A member row opened, because a list of closed rows says nothing about
    // what the screen is for.
    await page.locator("details.rename").first().locator("summary").click();
    await expect(page.locator("#member-1-sub")).toHaveValue("dev-seed-koti");
    await capture(page, {
      path: `${SHOTS}/43-admin-household.png`,
      fullPage: true,
    });
  });

  test("an admin's row refusing to be repointed", async ({ page }) => {
    // The guard that keeps admin an operator action: sign-in matches on
    // google_sub, so changing an admin's would hand admin to another Google
    // account. Member 3 is the seed's admin.
    await page.goto("/admin/households/1");
    const row = page.locator("details.rename").filter({ hasText: "Ylläpitäjä" });
    await row.locator("summary").click();
    await page.locator("#member-3-sub").fill("jonkun-muun-google-tili");
    await row.getByRole("button", { name: "Tallenna muutokset" }).click();
    await expect(page.locator(".refused")).toContainText(
      "Google-tunnistettaan ei voi vaihtaa",
    );
    await capture(page, {
      path: `${SHOTS}/44-admin-member-refused.png`,
      fullPage: true,
    });
  });

  test("a Google identifier that is not one, refused", async ({ page }) => {
    // What a `sub` may be is Google's contract and not this app's habit — see
    // `src/google.ts::isGoogleSub`. Holding the form to it is what keeps the
    // value a removed member's row is parked on out of anyone's reach, and it
    // catches the ordinary slip too: a name typed into the identifier field.
    await page.goto("/admin/households/1");
    await page.locator("#add-name").fill("Matti Meikäläinen");
    await page.locator("#add-email").fill("matti@example.com");
    await page.locator("#add-sub").fill("Matti Meikäläinen");
    await page.getByRole("button", { name: "Lisää jäsen" }).click();
    await expect(page.locator(".refused")).toContainText(
      "ei ole kelvollinen Google-tunniste",
    );
    await capture(page, {
      path: `${SHOTS}/47-admin-member-sub-refused.png`,
      fullPage: true,
    });
  });

  test("choosing which recipes get a picture", async ({ page }) => {
    // A household in the middle of things, which is the only state this screen
    // is interesting in: one recipe with no picture, one with a picture
    // somebody uploaded, and one whose generated picture no longer matches the
    // recipe. Two real pictures are cut from the fixture sheet first, then
    // re-recorded as those two kinds — nothing here is drawn by hand.
    await splitSheet(page, [2, 3]);

    const asUploaded = await page.request.get("/api/recipes/2/image");
    await page.request.put("/api/recipes/2/image", {
      headers: { "content-type": "image/png" },
      data: await asUploaded.body(),
    });

    const asStale = await page.request.get("/api/recipes/3/image");
    await page.request.put(
      "/api/recipes/3/image?origin=generated&fingerprint=vanha&model=supplied:manual/s1",
      { headers: { "content-type": "image/png" }, data: await asStale.body() },
    );

    await page.goto("/admin/recipe-images");
    await expect(page.getByRole("heading", { name: /Kuvaa vailla \(2\)/ })).toBeVisible();
    await page.locator("details.image-current > summary").click();
    await capture(page, {
      path: `${SHOTS}/32-admin-recipe-images.png`,
      fullPage: true,
    });

    // The working screen: the prompt to copy, the numbered manifest, and the
    // field the finished sheet comes back to. Nothing on it costs anything.
    await page.goto("/admin/recipe-images/confirm?id=1&id=3");
    await expect(page.locator("#split-manifest li")).toHaveCount(2);
    await expect(page.locator("#sheet-prompt")).toContainText("4-column by 4-row grid");
    await capture(page, {
      path: `${SHOTS}/33-admin-recipe-images-confirm.png`,
      fullPage: true,
    });

    // And the same screen after the browser has cut a sheet and stored it.
    await putSheetOnInput(page);
    await page.getByRole("button", { name: /Leikkaa arkki/ }).click();
    await expect(page.locator("#split-note")).toContainText("2 / 2 reseptiä sai kuvan.", {
      timeout: 30_000,
    });
    const pictured = page.locator("#split-manifest .recipe-image img");
    await expect(pictured).toHaveCount(2);
    await capture(page, {
      path: `${SHOTS}/34-admin-recipe-images-done.png`,
      fullPage: true,
    });
  });

  test("recipes pictured from one contact sheet", async ({ page }) => {
    // The sheet is the real one bought while #96 was built, before #111 removed
    // the paid route — see tests/recipe-image-admin.spec.ts. Three recipes take
    // cells 1 to 3 of it, which is what these two shots are of.
    await splitSheet(page, [1, 2, 3]);

    await page.goto("/recipes");
    // Every row pictured, and loaded rather than a broken-image icon: the shot
    // has to be of the thing working, not of three grey squares.
    await expect(page.locator(".recipes .recipe-image img")).toHaveCount(3);
    for (let at = 0; at < 3; at += 1) {
      await expect(page.locator(".recipes .recipe-image img").nth(at))
        .not.toHaveJSProperty("naturalWidth", 0);
    }
    await capture(page, { path: `${SHOTS}/32-generated-images.png`, fullPage: true });

    await page.goto("/recipes/1");
    await expect(page.locator(".recipe-image img").first()).toHaveJSProperty(
      "naturalWidth",
      512,
    );
    await capture(page, { path: `${SHOTS}/33-generated-recipe.png`, fullPage: true });
  });
});

/**
 * Last in the file on purpose: it renames a seeded recipe, and every shot
 * above still expects the seed titles.
 */
test.describe("a long recipe name on a phone", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([sessionCookie(1)]);
  });

  test("wraps in the card head rather than being cut off", async ({ page }) => {
    const longTitle =
      "Uunissa paahdettu kasvispaistos ja tilliperunamuusi kermaviilikastikkeella";
    await page.goto("/recipes/1/edit");
    await page.locator("#title").fill(longTitle);
    await page.getByRole("button", { name: "Tallenna muutokset" }).click();
    await expect(page.getByRole("heading", { name: longTitle })).toBeVisible();

    // A week of its own, so the shot holds only these two cards.
    const cooked = await createBatch(page, "2027-03-01", "lunch", 1);
    await setCoverage(page, cooked, [
      ["2027-03-01", "lunch"],
      ["2027-03-02", "lunch"],
    ]);
    const carried = await createBatch(page, "2027-02-28", "dinner", 1);
    await setCoverage(page, carried, [
      ["2027-02-28", "dinner"],
      ["2027-03-01", "dinner"],
    ]);

    await page.goto("/?week=2027-03-01");
    // Both pills are on screen and whole before the shot is taken.
    await expect(page.locator(".batch-start")).toHaveText("Kokataan · 1×");
    await expect(page.locator(".batch-carried")).toHaveText(
      "Kokattu 28.2. · 1×",
    );
    await capture(page, {
      path: `${SHOTS}/37-week-long-title.png`,
      fullPage: true,
    });
  });
});

/** A day relative to today in Helsinki, which is what the Worker means by it. */
function shiftedFromToday(days: number): string {
  const [year, month, day] = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Helsinki",
  })
    .format(new Date())
    .split("-")
    .map(Number) as [number, number, number];
  const at = new Date(Date.UTC(year, month - 1, day));
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

async function createBatch(
  page: Page,
  date: string,
  slot: "lunch" | "dinner",
  recipeId: number,
  multiplier = 1,
): Promise<number> {
  const response = await page.request.post("/api/batches", {
    data: { date, slot, recipeId, multiplier },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { id: number }).id;
}

async function setCoverage(
  page: Page,
  id: number,
  occurrences: Array<[string, "lunch" | "dinner"]>,
): Promise<void> {
  const response = await page.request.patch(`/api/batches/${id}`, {
    data: {
      occurrences: occurrences.map(([date, slot]) => ({ date, slot })),
    },
  });
  expect(response.status()).toBe(204);
}

/**
 * Give some recipes real pictures, by cutting the committed sheet the way an
 * admin does.
 *
 * There is no server route that does this any more: since #111 the split runs
 * in the browser, so a screenshot that wants pictured recipes has to walk the
 * actual screen. Which is no loss — it means these shots are of the flow as it
 * ships rather than of a state only a test could reach.
 */
async function splitSheet(page: Page, recipeIds: readonly number[]): Promise<void> {
  await page.goto(`/admin/recipe-images/confirm?${recipeIds.map((id) => `id=${id}`).join("&")}`);
  await putSheetOnInput(page);
  await page.getByRole("button", { name: /Leikkaa arkki/ }).click();
  await expect(page.locator("#split-note")).toContainText(
    `${recipeIds.length} / ${recipeIds.length} reseptiä sai kuvan.`,
    { timeout: 30_000 },
  );
}

async function putSheetOnInput(page: Page): Promise<void> {
  await page.locator("#sheet").setInputFiles({
    name: "contact-sheet.png",
    mimeType: "image/png",
    buffer: readFileSync(new URL("./fixtures/contact-sheet.png", import.meta.url)),
  });
}

/**
 * Last in the file on purpose: it removes the member every describe above signs
 * in as. What it is evidence of is the point of #127's removal — the household
 * loses the person, and keeps everything the person made.
 */
test.describe("removing an established member", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([sessionCookie(3)]);
  });

  test("the household loses them, the recipes keep their name", async ({
    page,
  }) => {
    await page.goto("/admin/households/1");
    const row = page.locator("details.rename").filter({ hasText: "Eero" });
    await row.locator("summary").click();
    await row.getByRole("button", { name: "Poista taloudesta" }).click();

    // Removed, with no refusal — this is the case the first attempt blocked.
    await expect(page.locator(".refused")).toHaveCount(0);
    await expect(
      page.locator("details.rename").filter({ hasText: "Eero" }),
    ).toHaveCount(0);
    await capture(page, {
      path: `${SHOTS}/45-admin-household-after-removal.png`,
      fullPage: true,
    });

    // And the recipes they wrote are still on the list, still theirs.
    await page.goto("/recipes");
    await expect(page.locator(".recipes").first()).toContainText("Eero");
    await capture(page, {
      path: `${SHOTS}/46-recipes-after-removal.png`,
      fullPage: true,
    });
  });
});

/**
 * Sharing between households (#143). Its own block because these need two
 * households at the same time, and the seed's member 2 is the other one.
 */
test.describe("public recipes", () => {
  // This file reseeds once, in `beforeAll`, and the block above it deliberately
  // removes member 1 from their household. These shots sign in as that member,
  // so they need the database put back first.
  test.beforeEach(reseed);

  test("publishing, the public section, and reading somebody else's", async ({
    page,
    context,
  }) => {
    await context.addCookies([sessionCookie(1)]);

    // A picture on the dish about to be shared, so these shots show what the
    // other household actually sees. Its image request is the one read that is
    // not owner-scoped, and a broken picture here would be the symptom.
    const pictured = await page.request.put("/api/recipes/1/image", {
      headers: { "content-type": "image/png" },
      data: flatPng(900, 600, [198, 122, 64]),
    });
    expect(pictured.status()).toBe(204);

    // Koti publishes two recipes from the list, in one go.
    await page.goto("/recipes");
    await page.getByLabel("Valitse Kaalilaatikko").check();
    await page.getByLabel("Valitse Lasagne").check();
    await expect(page.getByLabel("Valitse Lasagne")).toBeChecked();
    await capture(page, {
      path: `${SHOTS}/50-recipes-select-to-publish.png`,
      fullPage: true,
    });

    await page.getByRole("button", { name: "Julkaise valitut" }).click();
    await expect(page.locator(".badge.is-published")).toHaveCount(2);
    await capture(page, {
      path: `${SHOTS}/51-recipes-published.png`,
      fullPage: true,
    });

    // The owner's own view of a published recipe: the publish control, and the
    // household's own default multiplier beside it.
    await page.goto("/recipes/1");
    await page
      .locator(".multiplier-choice")
      .getByRole("button", { name: "1,5×" })
      .click();
    await expect(
      page.locator(".multiplier-choice button.is-current"),
    ).toHaveText("1,5×");
    await expect(
      page.getByLabel("Julkinen"),
    ).toBeChecked();
    await capture(page, {
      path: `${SHOTS}/52-recipe-owner-sharing.png`,
      fullPage: true,
    });

    // The same dish narrowed to one named household: this is the new #185
    // state, shown after save so the summary and checked recipient agree.
    await page.getByLabel("Valituille").check();
    await page.locator(".recipient-picker").getByLabel("Naapuri").check();
    await page.getByRole("button", { name: "Tallenna jako" }).click();
    await expect(page.locator(".recipe-sharing")).toContainText(
      "Tämä resepti on jaettu: Naapuri.",
    );
    const sharing = page.locator(".recipe-sharing");
    const search = sharing.getByLabel("Hae vastaanottavaa taloutta");
    const recipient = sharing.getByLabel("Naapuri");
    const saveSharing = sharing.getByRole("button", { name: "Tallenna jako" });
    const [sharingBox, searchBox, recipientBox, saveBox] = await Promise.all([
      sharing.boundingBox(),
      search.boundingBox(),
      recipient.boundingBox(),
      saveSharing.boundingBox(),
    ]);
    expect(sharingBox).not.toBeNull();
    expect(searchBox).not.toBeNull();
    expect(recipientBox).not.toBeNull();
    expect(saveBox).not.toBeNull();
    expect(searchBox!.x).toBeGreaterThanOrEqual(sharingBox!.x);
    expect(searchBox!.x + searchBox!.width).toBeLessThanOrEqual(
      sharingBox!.x + sharingBox!.width,
    );
    expect(recipientBox!.y).toBeGreaterThan(searchBox!.y + searchBox!.height);
    expect(saveBox!.y + saveBox!.height).toBeLessThanOrEqual(
      sharingBox!.y + sharingBox!.height,
    );
    const width = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(width.content).toBeLessThanOrEqual(width.viewport);
    await capture(page, {
      path: `${SHOTS}/68-recipe-selected-sharing.png`,
      fullPage: true,
    });

    // Now Naapuri, who can read and plan it but not edit it.
    await context.clearCookies();
    await context.addCookies([sessionCookie(2)]);

    await page.goto("/recipes/julkiset");
    await expect(page.locator(".recipes li")).toHaveCount(2);
    // Somebody else's picture, actually loaded rather than a broken icon.
    const thumb = page.locator(".recipes .recipe-image img").first();
    await expect(thumb).toHaveJSProperty("complete", true);
    await expect(thumb).not.toHaveJSProperty("naturalWidth", 0);
    await capture(page, {
      path: `${SHOTS}/53-public-recipes.png`,
      fullPage: true,
    });

    await page.goto("/recipes/1");
    await expect(page.locator(".shared-from")).toContainText("Koti");
    await expect(page.getByRole("link", { name: "Muokkaa reseptiä" })).toHaveCount(0);
    const hero = page.locator(".recipe-image.is-hero img");
    await expect(hero).toHaveJSProperty("complete", true);
    await expect(hero).not.toHaveJSProperty("naturalWidth", 0);
    await capture(page, {
      path: `${SHOTS}/54-public-recipe-read-only.png`,
      fullPage: true,
    });

    // Naapuri plans it, which is what puts the refusal below within reach.
    await page.goto("/picker?date=2099-01-01&slot=dinner");
    await page
      .locator(".pick li", { hasText: "Kaalilaatikko" })
      .getByRole("button", { name: "Lisää" })
      .click();

    // And Koti, trying to take it back while somebody is about to cook it.
    await context.clearCookies();
    await context.addCookies([sessionCookie(1)]);
    await page.goto("/recipes/1");
    await page.getByLabel("Oma").check();
    await page.getByRole("button", { name: "Tallenna jako" }).click();
    await expect(page.locator(".refused")).toContainText("tulevalla ruokalistalla");
    await capture(page, {
      path: `${SHOTS}/55-unpublish-refused.png`,
      fullPage: true,
    });
  });
});

test.describe("ingredient alternatives", () => {
  // The block above publishes a recipe and leaves it planned by the other
  // household, so these start from a database put back to the seed.
  test.beforeEach(reseed);

  test("a recipe line that offers a choice (#183)", async ({
    page,
    context,
  }) => {
    await context.addCookies([sessionCookie(1)]);

    // The choice is built the way a member builds one: two ordinary rows given
    // the same group number in the editor.
    await page.goto("/recipes/1/edit");
    const oil = page.locator(".line").first();
    await openMore(oil);
    await oil.getByLabel("Vaihtoehtoryhmä (sama numero = tai)").fill("1");

    await addIngredientRow(page);
    const added = page.locator(".line").nth(4);
    await added.locator("select").selectOption({ label: "Luo uusi aines" });
    await added.locator("input[name$=quantity]").fill("0,5");
    await openMore(added);
    await added.getByLabel("Yksikkö", { exact: true }).fill("dl");
    await added.getByLabel("Uuden aineksen nimi").fill("margariini");
    await added.getByLabel("Vaihtoehtoryhmä (sama numero = tai)").fill("1");
    await capture(page, {
      path: `${SHOTS}/69-alternative-editor.png`,
      fullPage: true,
    });

    await page.getByRole("button", { name: "Tallenna muutokset" }).click();
    await expect(page).toHaveURL(/\/recipes\/1$/);

    // The state worth photographing: one row, both amounts, the word between.
    const choice = page.locator(".recipe-ingredient.is-alternative");
    await expect(choice).toHaveCount(1);
    await expect(choice.locator(".alt-or")).toHaveText("tai");
    await expect(choice).toContainText("½ dl öljy");
    await expect(choice).toContainText("½ dl margariini");
    await capture(page, {
      path: `${SHOTS}/70-alternative-recipe.png`,
      fullPage: true,
    });

    // And the shopping list, which buys one of them.
    const today = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Helsinki",
    }).format(new Date());
    const created = await page.request.post("/api/batches", {
      data: { date: today, slot: "dinner", recipeId: 1, multiplier: 1 },
    });
    expect(created.status()).toBe(201);

    await page.goto("/ostoslista");
    await expect(page.locator(".shopping-item[data-haku='öljy']")).toHaveCount(1);
    await expect(
      page.locator(".shopping-item[data-haku='margariini']"),
    ).toHaveCount(0);
    await capture(page, {
      path: `${SHOTS}/71-alternative-shopping.png`,
      fullPage: true,
    });
  });

  test("an imported choice, doubled (#183 review)", async ({ page, context }) => {
    await context.addCookies([sessionCookie(1)]);

    // Import gives every option of a group the same source sentence, so this
    // shot is the one that would have shown the whole `tai` phrase repeated
    // under each option before the review fix.
    const sentence = "½ dl öljyä tai voita";
    await page.goto("/recipes/1/edit");
    const oil = page.locator(".line").first();
    await openMore(oil);
    await oil.getByLabel("Vaihtoehtoryhmä (sama numero = tai)").fill("1");
    await oil.getByLabel("Lähderivi").fill(sentence);

    await addIngredientRow(page);
    const added = page.locator(".line").nth(4);
    await added.locator("select").selectOption({ label: "Luo uusi aines" });
    await added.locator("input[name$=quantity]").fill("0,5");
    await openMore(added);
    await added.getByLabel("Yksikkö", { exact: true }).fill("dl");
    await added.getByLabel("Uuden aineksen nimi").fill("voi");
    await added.getByLabel("Vaihtoehtoryhmä (sama numero = tai)").fill("1");
    await added.getByLabel("Lähderivi").fill(sentence);
    await page.getByRole("button", { name: "Tallenna muutokset" }).click();
    await expect(page).toHaveURL(/\/recipes\/1$/);

    await page.goto("/recipes/1?multiplier=2");
    const choice = page.locator(".recipe-ingredient.is-alternative");
    await expect(choice).toContainText("1 dl öljy");
    await expect(choice).toContainText("1 dl voi");
    await expect(choice.locator(".source")).toHaveCount(1);
    await capture(page, {
      path: `${SHOTS}/72-alternative-scaled-source.png`,
      fullPage: true,
    });
  });
});
