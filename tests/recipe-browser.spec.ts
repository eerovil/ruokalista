import { expect, test, type Page } from "@playwright/test";

import { captureReview } from "./support/review-capture";
import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * The one recipe browser (#307), on both screens that list recipes.
 *
 * The point of the change is that `/recipes` and `/picker` are the same browse
 * surface, so nearly everything here is checked twice — once where recipes are
 * read and once where they are planned. The ordering rules themselves are pure
 * and are checked in `dev/check-recipe-browser.ts`; what needs a browser is the
 * cooking history coming out of real planned batches, and the instant search,
 * which is a browser or it is nothing.
 */

/**
 * The history every test below reads, made once: two cookings of one dish, one
 * of another, and a third nobody has ever cooked. Planned through the picker,
 * because a batch planned any other way would not prove the picker plans one.
 */
test.beforeAll(async ({ browser }) => {
  reseed();
  const context = await browser.newContext();
  await context.addCookies([sessionCookie(1)]);
  const page = await context.newPage();
  await planOn(page, daysAgo(30), "Kaalilaatikko");
  await planOn(page, daysAgo(10), "Kaalilaatikko");
  await planOn(page, daysAgo(20), "Öljykastike");
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

function inDays(days: number): string {
  return daysAgo(-days);
}

/** Plan one batch the way a member does: from the picker, on that day. */
async function planOn(page: Page, date: string, title: string): Promise<void> {
  await page.goto(`/picker?date=${date}&slot=dinner`);
  await page
    .locator(".pick li", { hasText: title })
    .getByRole("button", { name: "Lisää" })
    .click();
  await expect(page).toHaveURL(/\/\?week=/);
}

const visibleRows = (page: Page, list: string) =>
  page.locator(`${list} li:not([hidden])`);

test("the list says how many times each recipe has been cooked", async ({
  page,
}) => {
  await page.goto("/recipes");

  const kaali = page.locator(".recipes li", { hasText: "Kaalilaatikko" });
  await expect(kaali.locator(".meta")).toContainText("Kokattu 2×");
  await expect(kaali.locator(".meta")).toContainText("viimeksi");
  await expect(
    page.locator(".recipes li", { hasText: "Lasagne" }).locator(".meta"),
  ).toContainText("Ei vielä kokattu");
});

test("a batch still to come is a plan, not a cooking", async ({ page }) => {
  // Far enough out that no later test's week screen shows it too.
  await planOn(page, inDays(40), "Lasagne");
  await page.goto("/recipes");

  await expect(
    page.locator(".recipes li", { hasText: "Lasagne" }).locator(".meta"),
  ).toContainText("Ei vielä kokattu");
});

test("the list can be ordered by when it was last cooked", async ({ page }) => {
  await page.goto("/recipes");

  await page.locator(".browse-sort").getByRole("link", { name: "Viimeksi kokatut" }).click();
  await expect(page.locator(".recipes-title")).toHaveText([
    "Kaalilaatikko",
    "Öljykastike",
    // Never cooked is not recent, so it is last.
    "Lasagne",
  ]);

  await page.locator(".browse-sort").getByRole("link", { name: "Kauan kokkaamatta" }).click();
  await expect(page.locator(".recipes-title")).toHaveText([
    // Nothing has been longer than never.
    "Lasagne",
    "Öljykastike",
    "Kaalilaatikko",
  ]);
});

test("the week picker browses with the same filters and the same order", async ({
  page,
}) => {
  await page.goto(`/picker?date=${inDays(2)}&slot=lunch`);

  await expect(page.locator(".pick li", { hasText: "Kaalilaatikko" })).toContainText(
    "Kokattu 2×",
  );
  await page.locator(".browse-sort").getByRole("link", { name: "Kauan kokkaamatta" }).click();
  await expect(page.locator(".pick .recipes-title").first()).toHaveText("Lasagne");

  // The day and the meal survive the chip, and planning still works.
  await expect(page).toHaveURL(new RegExp(`date=${inDays(2)}&slot=lunch`));
  await page
    .locator(".pick li", { hasText: "Lasagne" })
    .getByRole("button", { name: "Lisää" })
    .click();
  await expect(page).toHaveURL(/\/\?week=/);
  await expect(page.locator(".entry", { hasText: "Lasagne" })).toHaveCount(1);
});

test("the picker filters by category, which it never could before", async ({
  page,
}) => {
  await page.goto("/recipes");
  await page.locator(".recipe-pick").first().check();
  await page.locator("select[name=bulkCategory]").selectOption("uuniruoka");
  await page.getByRole("button", { name: "Lisää valituille" }).click();
  await expect(page.locator(".done")).toContainText("Uuniruoka");

  await page.goto(`/picker?date=${inDays(1)}&slot=lunch`);
  await page.locator(".category-filter").getByRole("link", { name: "Uuniruoka" }).click();
  await expect(page.locator(".pick li")).toHaveCount(1);
  await expect(page.locator(".pick .recipes-title")).toHaveText("Lasagne");
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
  await expect(visibleRows(page, ".recipes")).toHaveCount(3);
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

  // And now the other two are here to be found, without another request.
  await page.locator(".browse-search input[name=q]").fill("");
  await expect(visibleRows(page, ".recipes")).toHaveCount(3);
});

test("the typed search survives a category or order chip", async ({ page }) => {
  await page.goto("/recipes");
  await page.locator(".browse-search input[name=q]").fill("la");
  await expect(page).toHaveURL("/recipes#haku=la");

  await page.locator(".browse-sort").getByRole("link", { name: "Kauan kokkaamatta" }).click();
  await expect(page.locator(".browse-search input[name=q]")).toHaveValue("la");
  await expect(visibleRows(page, ".recipes")).toHaveCount(2);
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
  await expect(page.locator(".recipes-title").first()).toHaveText("Lasagne");
  await captureReview(page, "test-results/307-recipes-jarjestys.png");

  await page.goto(`/picker?date=${inDays(5)}&slot=dinner`);
  await expect(page.locator(".pick li", { hasText: "Öljykastike" })).toContainText(
    "Kokattu 1×",
  );
  await expect(page.locator(".category-filter")).toBeVisible();
  await captureReview(page, "test-results/307-picker.png");

  await page.locator(".browse-search input[name=q]").fill("kaali");
  await expect(visibleRows(page, ".pick")).toHaveCount(1);
  await captureReview(page, "test-results/307-picker-haku.png");
});
