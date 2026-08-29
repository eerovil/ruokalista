import { expect, test, type Locator, type Page } from "@playwright/test";

import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * #204: photograph the shopping list's product-picking flow as it is today, on
 * a phone, before anybody changes it.
 *
 * This is an audit artifact, not behavioural coverage — every ordinary run
 * skips it. Capture with:
 *
 *   PLAYWRIGHT_SCREENSHOTS=1 ./scripts/playwright.sh \
 *     npx playwright test ux-audit-shopping-204
 *
 * The pictures land in docs/screenshots/ux-audit-204/ and the recording of the
 * four-ingredient run lands in test-results/.
 */

const SHOTS = "docs/screenshots/ux-audit-204";
const capturing = process.env["PLAYWRIGHT_SCREENSHOTS"] === "1";
const browserPort = Number(process.env["PLAYWRIGHT_PORT"] ?? "8787");
const S_OSTOSLISTA_FIXTURE = `http://127.0.0.1:${browserPort + 1}`;

const KAALILAATIKKO = 1;
const LASAGNE = 3;

test.skip(!capturing, "audit artifacts are opt-in (PLAYWRIGHT_SCREENSHOTS=1)");
test.use({ video: { mode: "on", size: { width: 412, height: 915 } } });

test.describe("shopping product picking, as it is (#204)", () => {
  test.beforeEach(async ({ context, request }) => {
    reseed();
    expect((await request.post(`${S_OSTOSLISTA_FIXTURE}/_test/reset`)).ok()).toBe(
      true,
    );
    await context.addCookies([sessionCookie(1)]);
  });

  test("one whole happy path, and the actions beside it", async ({ page }) => {
    test.setTimeout(180_000);
    await planTheFortnight(page);
    await page.goto("/ostoslista");
    await expect(page.locator(".shopping-list > li").first()).toBeVisible();

    // 1. The list as the member finds it: nothing chosen yet.
    await shot(page, "01-list-top");
    await shot(page, "02-list-whole-page", { fullPage: true });

    // 2. Opening an ingredient that has no product yet.
    const cheese = row(page, "juusto");
    await cheese.locator("summary").click();
    await expect(
      cheese.getByRole("button", { name: "Valitse tuote" }),
    ).toBeVisible();
    await shot(page, "03-row-open");

    // 3. The search sheet before results — the request held open on purpose so
    //    the state the member actually sees is in the picture.
    let holdSearch = true;
    let releaseSearch: () => void = () => {};
    const heldSearch = new Promise<void>((resolve) => {
      releaseSearch = resolve;
    });
    // Left registered afterwards as a pass-through: unrouting while the sheet's
    // prefetch is still in flight is what "Route is already handled" means.
    await page.route("**/ostoslista/haku*", async (route) => {
      if (holdSearch) await heldSearch;
      await route.continue().catch(() => {});
    });
    await cheese.getByRole("button", { name: "Valitse tuote" }).click();
    await expect(page.locator(".s-sheet")).toBeVisible();
    await expect(page.locator(".s-sheet .s-product-panel-state")).toContainText(
      "Haetaan tuotteita",
    );
    await shot(page, "04-sheet-searching");
    holdSearch = false;
    releaseSearch();

    // 4. The results of the search the sheet ran by itself.
    const results = page.locator(".s-sheet .s-product-results > li");
    await expect(results.first()).toBeVisible();
    await expect(page.locator(".s-sheet .spinner")).toHaveCount(0);
    await shot(page, "05-sheet-results");

    // 5. The moment before the tap, with the sheet scrolled to its end — what
    //    is below the fold of the sheet when the member scans the results.
    const chosen = results.filter({ hasText: "Kotimaista juustoraaste" });
    await page
      .locator(".s-sheet-panel")
      .evaluate((panel: HTMLElement) => panel.scrollTo(0, panel.scrollHeight));
    await shot(page, "06-sheet-scrolled-to-the-end");

    // 6. Straight after the tap. The save is held open so the picture shows
    //    what #200 introduced: the choice drawn on the row immediately, with
    //    the sheet already gone and the row saying it is still saving.
    let holdSave = true;
    let releaseSave: () => void = () => {};
    const heldSave = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    await page.route("**/ostoslista/tuote", async (route) => {
      if (route.request().method() === "POST" && holdSave) await heldSave;
      await route.continue().catch(() => {});
    });
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/ostoslista/tuote"),
    );
    await chosen.getByRole("button", { name: "Valitse" }).click();
    await expect(page.locator(".s-sheet")).toBeHidden();
    await expect(cheese.locator(".s-shopping-product-summary")).toContainText(
      "Kotimaista juustoraaste",
    );
    await shot(page, "07-just-after-choosing");
    holdSave = false;
    releaseSave();
    await saved;

    // 7. Back on the list, saved — no navigation happened, so this is exactly
    //    where the member is left.
    await expect(cheese.locator(".s-status .spinner")).toHaveCount(0);
    await shot(page, "08-back-on-the-list");
    await shot(page, "09-back-on-the-list-whole-page", { fullPage: true });

    // 8. The next ingredient with no product, without scrolling first: this is
    //    the distance between finishing one and starting the next.
    const mince = row(page, "jauheliha");
    await mince.locator("summary").click();
    await shot(page, "10-next-ingredient-open");

    // Changing a product that is already chosen.
    await mince.locator("summary").click();
    await cheese.getByRole("button", { name: "Vaihda tuote" }).click();
    await expect(page.locator(".s-sheet .s-product-results > li").first()).toBeVisible();
    await shot(page, "11-changing-a-chosen-product");
    await page.locator(".s-sheet .s-sheet-close").click();
    await expect(page.locator(".s-sheet")).toBeHidden();

    // A second package size for the same ingredient. This one does not draw
    // optimistically: the server answers `reload`, so the page really reloads.
    const secondSize = page.waitForEvent("load");
    await cheese.getByRole("button", { name: "Lisää toinen pakkauskoko" }).click();
    await expect(page.locator(".s-sheet .s-sheet-sub")).toContainText(
      "Lisää pakkauskoko",
    );
    await shot(page, "12-add-another-package-size");
    await page
      .locator(".s-sheet .s-product-results > li")
      .filter({ hasText: "Valio Polar" })
      .getByRole("button", { name: "Valitse" })
      .click();
    await secondSize;
    const cheeseAfter = row(page, "juusto");
    await expect(cheeseAfter.locator(".s-product-sizes > li")).toHaveCount(2);
    await shot(page, "13-two-package-sizes");

    // Already in the cupboard: the row leaves the buy list for the Löytyy
    // section, through a full page load.
    const oil = row(page, "öljy");
    await oil.locator("summary").click();
    await oil.getByRole("button", { name: "Löytyy jo kaapista" }).click();
    await expect(
      page.locator(".shopping-section", { hasText: "Löytyy" }),
    ).toBeVisible();
    await shot(page, "14-already-in-the-cupboard", { fullPage: true });

    // Sending what has been chosen, and its own waiting state.
    const send = page.locator(".s-send-form button");
    await send.scrollIntoViewIfNeeded();
    await shot(page, "15-send-button");
    await send.click();
    await expect(page.locator(".shopping-sent")).toBeVisible();
    await shot(page, "16-sent", { fullPage: true });
  });

  test("four ingredients in a row", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await planTheFortnight(page);
    await page.goto("/ostoslista");
    await expect(page.locator(".shopping-list > li").first()).toBeVisible();

    const walk: Array<[string, string]> = [
      ["jauheliha", "Kotimaista nauta-sikajauheliha"],
      ["juusto", "Kotimaista juustoraaste"],
      ["maito", "Kotimaista rasvaton maito"],
      ["öljy", "Keiju rypsiöljy"],
    ];

    let step = 0;
    for (const [ingredient, product] of walk) {
      step += 1;
      const item = row(page, ingredient);
      await pause(page);
      await item.locator("summary").click();
      await shot(page, `seq-${step}a-${slug(ingredient)}-open`);
      await pause(page);
      await item.getByRole("button", { name: "Valitse tuote" }).click();
      const chosen = page
        .locator(".s-sheet .s-product-results > li")
        .filter({ hasText: product });
      await expect(chosen).toBeVisible();
      await shot(page, `seq-${step}b-${slug(ingredient)}-results`);
      await pause(page);
      const saved = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().includes("/ostoslista/tuote"),
      );
      await chosen.getByRole("button", { name: "Valitse" }).click();
      await saved;
      await expect(item.locator(".s-shopping-product-summary")).toContainText(
        product,
      );
      await shot(page, `seq-${step}c-${slug(ingredient)}-chosen`);
      await pause(page);
      // Tidy the row away the way a member would before moving on.
      await item.locator("summary").click();
    }

    await shot(page, "seq-9-four-chosen", { fullPage: true });
    testInfo.attach("note", { body: "four ingredients picked in one sitting" });
  });
});

function row(page: Page, ingredient: string): Locator {
  return page.locator(`.shopping-item[data-haku="${ingredient}"]`).first();
}

async function shot(
  page: Page,
  name: string,
  options: { fullPage?: boolean } = {},
): Promise<void> {
  if (!capturing) return;
  await page.screenshot({
    path: `${SHOTS}/${name}.png`,
    fullPage: options.fullPage ?? false,
  });
}

/** Watchable pacing for the recording; the assertions do not depend on it. */
async function pause(page: Page): Promise<void> {
  await page.waitForTimeout(700);
}

function slug(name: string): string {
  return name
    .replace(/ä/g, "a")
    .replace(/ö/g, "o")
    .replace(/[^a-z0-9]+/g, "-");
}

async function planTheFortnight(page: Page): Promise<void> {
  await createBatch(page, shiftedFromToday(0), KAALILAATIKKO, 2);
  await createBatch(page, shiftedFromToday(2), LASAGNE, 1);
}

async function createBatch(
  page: Page,
  date: string,
  recipeId: number,
  multiplier: number,
): Promise<number> {
  const response = await page.request.post("/api/batches", {
    data: { date, slot: "dinner", recipeId, multiplier },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { id: number }).id;
}

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
