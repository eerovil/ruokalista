import { expect, test, type Page } from "@playwright/test";

import { cookedOn, listDish } from "./support/cook-list";
import { captureReview } from "./support/review-capture";
import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * The one recipe browser (#307). `/picker` went with the meal calendar (#345),
 * so `/recipes` is the screen it is checked on. The ordering rules themselves are pure
 * and are checked in `dev/check-recipe-browser.ts`; what needs a browser is the
 * cooking history coming out of real cooked dishes, and the instant search,
 * which is a browser or it is nothing.
 */

/**
 * The history every test below reads, made once: two cookings of one dish, one
 * of another, and a third nobody has ever cooked.
 */
test.beforeAll(async ({ browser }) => {
  reseed();
  const context = await browser.newContext();
  await context.addCookies([sessionCookie(1)]);
  const page = await context.newPage();
  await cookedOn(page, 1, daysAgo(30));
  await cookedOn(page, 1, daysAgo(10));
  await cookedOn(page, 2, daysAgo(20));
  await context.close();
});

test.beforeEach(async ({ context }) => {
  await context.addCookies([sessionCookie(1)]);
});

/** `YYYY-MM-DD`, that many days before today. Cooking history is about past days. */
function daysAgo(days: number): string {
  const at = new Date();
  at.setDate(at.getDate() - days);
  return at.toISOString().slice(0, 10);
}

const visibleRows = (page: Page, list: string) =>
  page.locator(`${list} li:not([hidden])`);

test("the list says how many times each recipe has been cooked", async ({
  page,
}) => {
  await page.goto("/recipes");

  const kaali = page.locator(".recipes li", { hasText: "Kaalilaatikko" });
  await expect(kaali.locator(".meta").first()).toContainText("Kokattu 2×");
  await expect(kaali.locator(".meta").first()).toContainText("viimeksi");
  await expect(
    page.locator(".recipes li", { hasText: "Lasagne" }).locator(".meta").first(),
  ).toContainText("Ei vielä kokattu");
  // The row still says who imported it: a member removed from the household
  // keeps their name on the recipes they wrote (#187).
  await expect(kaali.locator(".meta").last()).toContainText("Eero");
});

test("a dish still on the to-do list is a plan, not a cooking", async ({ page }) => {
  await listDish(page, 3);
  await page.goto("/recipes");

  await expect(
    page.locator(".recipes li", { hasText: "Lasagne" }).locator(".meta").first(),
  ).toContainText("Ei vielä kokattu");
});

test("the list can be ordered by when it was last cooked", async ({ page }) => {
  await page.goto("/recipes");

  await page.locator(".browse-sort").getByRole("link", { name: "Viimeksi kokatut" }).click();
  await expect(page.locator(".recipes-title")).toHaveText([
    "Kaalilaatikko",
    "Öljykastike",
    // Never cooked is not recent, so it is last — Naapuri's shared dish too.
    "Naapurin uunikala",
    "Lasagne",
  ]);

  await page.locator(".browse-sort").getByRole("link", { name: "Kauan kokkaamatta" }).click();
  await expect(page.locator(".recipes-title")).toHaveText([
    // Nothing has been longer than never.
    "Naapurin uunikala",
    "Lasagne",
    "Öljykastike",
    "Kaalilaatikko",
  ]);
});

test("typing filters the list at once, without asking the server", async ({
  page,
}) => {
  await page.goto("/recipes");
  let documents = 0;
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents += 1;
  });

  await page.locator(".browse-search input[name=q]").fill("kaali");
  await expect(visibleRows(page, ".recipes")).toHaveCount(1);
  await expect(visibleRows(page, ".recipes")).toContainText("Kaalilaatikko");
  // The name is matched the way Finnish is read, not the way ASCII is.
  await page.locator(".browse-search input[name=q]").fill("ÖLJY");
  await expect(visibleRows(page, ".recipes")).toHaveCount(1);
  await expect(visibleRows(page, ".recipes")).toContainText("Öljykastike");

  await page.locator(".browse-search input[name=q]").fill("pizza");
  await expect(visibleRows(page, ".recipes")).toHaveCount(0);
  await expect(page.locator(".browse-none")).toContainText('Haku "pizza"');

  await page.locator(".browse-search input[name=q]").fill("");
  await expect(visibleRows(page, ".recipes")).toHaveCount(4);
  expect(documents).toBe(0);
  // There is nothing left to submit, so the button is not offered.
  await expect(page.locator(".browse-go")).toBeHidden();
});

test("the instant search never searches only what the server left", async ({
  page,
}) => {
  // A link or a bookmark can still carry ?q=, and the rows it did not match are
  // not on the screen at all. So the page is replaced once by the whole list.
  await page.goto("/recipes?q=kaali");

  await expect(page).toHaveURL("/recipes#haku=kaali");
  await expect(page.locator(".browse-search input[name=q]")).toHaveValue("kaali");
  await expect(visibleRows(page, ".recipes")).toHaveCount(1);

  // And now the others are here to be found, without another request.
  await page.locator(".browse-search input[name=q]").fill("");
  await expect(visibleRows(page, ".recipes")).toHaveCount(4);
});

test("the typed search survives a category or order chip", async ({ page }) => {
  await page.goto("/recipes");
  await page.locator(".browse-search input[name=q]").fill("la");
  await expect(page).toHaveURL("/recipes#haku=la");

  await page.locator(".browse-sort").getByRole("link", { name: "Kauan kokkaamatta" }).click();
  await expect(page.locator(".browse-search input[name=q]")).toHaveValue("la");
  // Lasagne, Kaalilaatikko and Naapurin uunikala.
  await expect(visibleRows(page, ".recipes")).toHaveCount(3);
});

test("a row the search hides is not a row the bulk buttons act on", async ({
  page,
}) => {
  await page.goto("/recipes");
  await page.locator(".recipes li", { hasText: "Lasagne" }).locator(".recipe-pick").check();
  await expect(page.locator(".selection-count")).toContainText("1 resepti valittuna");

  await page.locator(".browse-search input[name=q]").fill("kaali");
  await expect(page.locator(".selection-count")).toContainText(
    "Ei yhtään reseptiä valittuna",
  );
});

test("without script the search is still the server's, and still works", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  await context.addCookies([sessionCookie(1)]);
  const page = await context.newPage();

  await page.goto("/recipes");
  await page.locator(".browse-search input[name=q]").fill("kaali");
  await page.getByRole("button", { name: "Hae" }).click();

  await expect(page).toHaveURL("/recipes?q=kaali");
  await expect(page.locator(".recipes li")).toHaveCount(1);
  await context.close();
});

/**
 * The enhancement and the fallback are one search, not two.
 *
 * `?q=` is what a browser without script submits, so a query that finds a dish
 * with script has to find it without. The query that proves it is the name of
 * the member who imported the household's own recipes: `Eero` is on each of
 * those rows, and is in none of their names — so a client search that looked
 * at anything but the name would find three recipes here and the server would
 * find none.
 */
test("the search finds the same recipes with and without JavaScript", async ({
  browser,
}) => {
  const scripted = await browser.newContext();
  await scripted.addCookies([sessionCookie(1)]);
  const withScript = await scripted.newPage();
  await withScript.goto("/recipes");

  const plain = await browser.newContext({ javaScriptEnabled: false });
  await plain.addCookies([sessionCookie(1)]);
  const withoutScript = await plain.newPage();

  for (const query of ["Eero", "Naapuri", "kaali", "UUNIKALA", "öljy", "pizza"]) {
    await withoutScript.goto(`/recipes?q=${encodeURIComponent(query)}`);
    const served = await withoutScript
      .locator(".recipes li .recipes-title")
      .allTextContents();

    await withScript.locator(".browse-search input[name=q]").fill(query);
    await expect(
      withScript.locator(".recipes li:not([hidden]) .recipes-title"),
      `haku "${query}"`,
    ).toHaveText(served);
  }

  // Not vacuously equal: the member's name really is on the screen, and
  // really is not a recipe name.
  await withScript.locator(".browse-search input[name=q]").fill("");
  await expect(withScript.locator(".recipes li", { hasText: "Kaalilaatikko" }))
    .toContainText("Eero");
  await withScript.locator(".browse-search input[name=q]").fill("Eero");
  await expect(withScript.locator(".browse-none")).toContainText('Haku "Eero"');
  await captureReview(withScript, "test-results/307-parity-script-koti.png");
  await withoutScript.goto("/recipes?q=Eero");
  await expect(withoutScript.locator(".nothing")).toContainText('Haku "Eero"');
  await captureReview(withoutScript, "test-results/307-parity-noscript-koti.png");

  await withScript.locator(".browse-search input[name=q]").fill("Naapuri");
  await expect(visibleRows(withScript, ".recipes")).toHaveCount(1);
  await captureReview(withScript, "test-results/307-parity-script-naapuri.png");
  await withoutScript.goto("/recipes?q=Naapuri");
  await expect(withoutScript.locator(".recipes li")).toHaveCount(1);
  await captureReview(withoutScript, "test-results/307-parity-noscript-naapuri.png");

  await scripted.close();
  await plain.close();
});

/**
 * Review evidence, in the state a household actually leaves this screen in: a
 * few dishes cooked, one never, and the order chips where a phone shows them.
 * The assertions run in every suite; only the pictures are opt-in.
 */
test("the browser, on a phone, with cooking behind it", async ({ page }) => {
  await page.goto("/recipes");
  await expect(page.locator(".recipes li", { hasText: "Kaalilaatikko" })).toContainText(
    "Kokattu 2×",
  );
  await expect(page.locator(".browse-sort .chip")).toHaveCount(3);
  await captureReview(page, "test-results/307-recipes.png");

  await page.locator(".browse-sort").getByRole("link", { name: "Kauan kokkaamatta" }).click();
  await expect(page.locator(".browse-sort .chip.is-on")).toHaveText("Kauan kokkaamatta");
  await expect(page.locator(".recipes-title").nth(1)).toHaveText("Lasagne");
  await captureReview(page, "test-results/307-recipes-jarjestys.png");

});
