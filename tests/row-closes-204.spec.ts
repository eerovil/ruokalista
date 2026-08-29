import { expect, test, type Locator, type Page } from "@playwright/test";

import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * #204, the second half: finishing an ingredient should not leave the member
 * wondering where they were. A row that has just been given a product is the
 * tallest thing on the screen at exactly the moment there is nothing left to do
 * in it, and the next ingredient gets pushed off the bottom.
 *
 * So the interesting state is not one row — it is the whole screen after a
 * choice, on a phone, with a real two-recipe list. This spec runs in every
 * ordinary run and takes the pictures for the issue when asked:
 *
 *   PLAYWRIGHT_SCREENSHOTS=1 ./scripts/playwright.sh \
 *     npx playwright test row-closes-204
 */

const SHOTS = "docs/screenshots/row-closes-204";
const capturing = process.env["PLAYWRIGHT_SCREENSHOTS"] === "1";
const browserPort = Number(process.env["PLAYWRIGHT_PORT"] ?? "8787");
const S_OSTOSLISTA_FIXTURE = `http://127.0.0.1:${browserPort + 1}`;

const KAALILAATIKKO = 1;
const LASAGNE = 3;

test.describe("a finished ingredient gets out of the way (#204)", () => {
  test.beforeEach(async ({ context, request }) => {
    reseed();
    expect((await request.post(`${S_OSTOSLISTA_FIXTURE}/_test/reset`)).ok()).toBe(
      true,
    );
    await context.addCookies([sessionCookie(1)]);
  });

  test("choosing a product leaves the next ingredient a tap away", async ({
    page,
  }) => {
    await createBatch(page, shiftedFromToday(0), KAALILAATIKKO, 2);
    await createBatch(page, shiftedFromToday(2), LASAGNE, 1);
    await page.goto("/ostoslista");
    await expect(page.locator(".shopping-list > li").first()).toBeVisible();

    // The ingredient from the report, and the one after it on the same list.
    const cheese = row(page, "juusto");
    const next = row(page, "lasagnelevy");

    await cheese.locator("summary").click();
    await expect(
      cheese.getByRole("button", { name: "Lisää toinen pakkauskoko" }),
    ).toBeVisible();
    await shot(page, "1-row-open-before-choosing");

    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/ostoslista/tuote"),
    );
    await cheese.getByRole("button", { name: "Valitse tuote" }).click();
    await expect(page.locator(".s-sheet .s-product-results > li").first()).toBeVisible();
    await page
      .locator(".s-sheet .s-product-results > li")
      .filter({ hasText: "Kotimaista juustoraaste" })
      .getByRole("button", { name: "Valitse" })
      .click();
    await saved;
    await expect(cheese.locator(".s-status .spinner")).toHaveCount(0);

    // The row is closed, and what it chose is still on it.
    await expect(cheese.locator(".s-shopping-product-summary")).toBeHidden();
    await expect(cheese.locator(".shopping-thumb img")).toHaveCount(1);
    // On a list this size nothing scrolled at all, in either direction. The
    // browser only hands scroll back when the document was taller than the
    // screen and collapsing made it shorter than the offset it was at.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await shot(page, "2-after-choosing");

    // The point of all of it: the next ingredient is on the screen, without
    // scrolling and without hunting for it.
    await expect(next).toBeInViewport();
    await next.locator("summary").click();
    await expect(next.getByRole("button", { name: "Valitse tuote" })).toBeVisible();
    await shot(page, "3-straight-on-to-the-next");
    await next.locator("summary").click();

    // And straight through a second one, to show what the list looks like part
    // way down it. Milk, because its fixture EANs are S-group's own — so this
    // is the one row in these pictures whose photograph really arrives, and it
    // is what a finished row looks like in earnest.
    const milk = row(page, "maito");
    const savedMilk = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/ostoslista/tuote"),
    );
    await milk.locator("summary").click();
    await milk.getByRole("button", { name: "Valitse tuote" }).click();
    await expect(page.locator(".s-sheet .s-product-results > li").first()).toBeVisible();
    await page
      .locator(".s-sheet .s-product-results > li")
      .filter({ hasText: "Kotimaista rasvaton maito" })
      .getByRole("button", { name: "Valitse" })
      .click();
    await savedMilk;
    await expect(milk.locator(".s-status .spinner")).toHaveCount(0);
    await expect(milk.locator(".s-shopping-product-summary")).toBeHidden();
    await expect
      .poll(() =>
        milk
          .locator(".shopping-thumb img")
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);
    await shot(page, "4-two-done-and-the-list-still-whole");
  });
});

function row(page: Page, ingredient: string): Locator {
  return page.locator(`.shopping-item[data-haku="${ingredient}"]`).first();
}

async function shot(page: Page, name: string): Promise<void> {
  if (!capturing) return;
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function createBatch(
  page: Page,
  date: string,
  recipeId: number,
  multiplier: number,
): Promise<void> {
  const response = await page.request.post("/api/batches", {
    data: { date, slot: "dinner", recipeId, multiplier },
  });
  expect(response.status()).toBe(201);
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
