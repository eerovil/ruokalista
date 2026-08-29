import { expect, test, type Locator, type Page } from "@playwright/test";

import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * #204: a product picture is asked for at the width it is drawn at, and cropped
 * to its box rather than fitted inside it.
 *
 * Both halves have to hold in two places, because a chosen product is drawn
 * twice: by the server on a fresh page, and by the island the moment the member
 * taps Valitse. The picker's own results only ever come from the island's fetch,
 * so a check that only reloaded the page would miss the widest picture on the
 * screen.
 *
 * This spec runs in every ordinary run. It also takes the before/after pictures
 * for the issue when asked:
 *
 *   PLAYWRIGHT_SCREENSHOTS=1 ./scripts/playwright.sh \
 *     npx playwright test product-picture-204
 */

const SHOTS = "docs/screenshots/product-picture-204";
const capturing = process.env["PLAYWRIGHT_SCREENSHOTS"] === "1";
const browserPort = Number(process.env["PLAYWRIGHT_PORT"] ?? "8787");
const S_OSTOSLISTA_FIXTURE = `http://127.0.0.1:${browserPort + 1}`;

const LASAGNE = 3;

/** The slot sizes in html.ts, and the width each one asks the CDN for. */
const SLOTS = {
  row: { size: 26, width: 96 },
  summary: { size: 40, width: 128 },
  result: { size: 80, width: 192 },
} as const;

test.describe("a product picture is sized and cropped to its slot (#204)", () => {
  test.beforeEach(async ({ context, request }) => {
    reseed();
    expect((await request.post(`${S_OSTOSLISTA_FIXTURE}/_test/reset`)).ok()).toBe(
      true,
    );
    await context.addCookies([sessionCookie(1)]);
  });

  test("every slot asks the CDN for its own width and fills its box", async ({
    page,
  }) => {
    await createBatch(page, todayInHelsinki(), LASAGNE, 1);
    await page.goto("/ostoslista");

    const milk = row(page, "maito");
    await milk.locator("summary").click();
    await milk.getByRole("button", { name: "Valitse tuote" }).click();

    const results = page.locator(".s-sheet .s-product-results > li");
    await expect(results.first()).toBeVisible();
    await expect(page.locator(".s-sheet .spinner")).toHaveCount(0);

    // The fixture's milk EANs are S-group's own, so these two pictures really
    // do come down off the CDN. That is the whole point of photographing this
    // ingredient: a picture that 404s tells us nothing about how it is drawn.
    const pictures = results.locator("img");
    await expect(pictures).toHaveCount(2);
    for (let index = 0; index < 2; index += 1) {
      await expectPicture(pictures.nth(index), SLOTS.result);
    }
    await shot(page, "1-picker-results");

    // Drawn by the island: no page load happens between the tap and this.
    await results
      .filter({ hasText: "Kotimaista rasvaton maito" })
      .getByRole("button", { name: "Valitse" })
      .click();
    await expect(page.locator(".s-sheet")).toBeHidden();
    await expect(milk.locator(".s-shopping-product-summary")).toContainText(
      "Kotimaista rasvaton maito",
    );
    await expect(milk.locator(".s-status .spinner")).toHaveCount(0);
    await expectPicture(
      milk.locator(".s-shopping-product-one img"),
      SLOTS.summary,
    );
    await expectPicture(milk.locator(".shopping-thumb img"), SLOTS.row);
    await shot(page, "2-chosen-drawn-by-the-island");

    // And again from the server, which draws the same three slots from the
    // saved URL — a full-size one, for a product chosen before this change.
    await page.reload();
    const reopened = row(page, "maito");
    await expectPicture(reopened.locator(".shopping-thumb img"), SLOTS.row);
    await shot(page, "3-list-with-the-row-closed");
    await reopened.locator("summary").click();
    await expectPicture(
      reopened.locator(".s-shopping-product-one img"),
      SLOTS.summary,
    );
    await shot(page, "4-chosen-drawn-by-the-server");
  });
});

/**
 * A picture is right when it asked for its own width, arrived, and covers the
 * box it was given. `naturalWidth` is what says it arrived: `onerror` only
 * hides a picture, so a broken one is still in the page and would otherwise
 * pass every other check here.
 */
async function expectPicture(
  picture: Locator,
  slot: { size: number; width: number },
): Promise<void> {
  await expect(picture).toHaveAttribute("src", new RegExp(`/w${slot.width}_q75/`));
  // Polled, not read once: the picture is lazy and the tap that draws it does
  // not wait for the CDN, so a straight read races the download.
  await expect
    .poll(() =>
      picture.evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(slot.width);
  const drawn = await picture.evaluate((image: HTMLImageElement) => ({
    fit: getComputedStyle(image).objectFit,
    // The border box, so the frame around each picture counts as part of the
    // slot it was given.
    box: [image.offsetWidth, image.offsetHeight],
  }));
  expect(drawn.fit).toBe("cover");
  expect(drawn.box).toEqual([slot.size, slot.size]);
}

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

function todayInHelsinki(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Helsinki" }).format(
    new Date(),
  );
}
