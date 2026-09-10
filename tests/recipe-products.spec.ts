import { expect, test, type Locator, type Page } from "@playwright/test";

import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

const browserPort = Number(process.env["PLAYWRIGHT_PORT"] ?? "8787");
const S_OSTOSLISTA_FIXTURE = `http://127.0.0.1:${browserPort + 1}`;

/**
 * Choosing an S-ostoslista product from a recipe's ingredient row (#302).
 *
 * Two things are being checked, and they are the two the card asks for. That
 * the recipe screen reaches the *same* component and writes the *same* mapping
 * the shopping list does — so a choice made here is a choice the trolley knows
 * about — and that none of it exists for a household without the integration,
 * down to the chosen product's picture.
 *
 * The seed's second household is what proves the second half: member 1 is
 * Koti's, which is the household `playwright.config.ts` configures the
 * integration for, and member 2 is Naapuri's, which is not.
 */

const LASAGNE = 3;
const NAAPURIN_UUNIKALA = 6;
const MAITO = 9;
const OLJY = 1;

const RASVATON = "6415712506032";
const KEVYTMAITO = "6414893386488";

test.beforeEach(async ({ request }) => {
  reseed();
  expect((await request.post(`${S_OSTOSLISTA_FIXTURE}/_test/reset`)).ok()).toBe(true);
});

test.afterAll(reseed);

/** The recipe row for one ingredient, by the name printed on it. */
function ingredient(page: Page, name: string): Locator {
  return page.locator(".recipe-ingredient", { hasText: name });
}

/** Choose a product for one ingredient, straight through the picker's routes. */
async function chooseFromRecipe(
  page: Page,
  recipeId: number,
  ingredientId: number,
  query: string,
  ean: string,
  scope = "aines",
): Promise<void> {
  const form = new URLSearchParams({
    rivi: String(ingredientId),
    haku: query,
    ean,
    laajuus: scope,
    muoto: "json",
  });
  const saved = await page.request.post(`/recipes/${recipeId}/tuote`, {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    data: form.toString(),
  });
  expect(saved.ok()).toBe(true);
}

test.describe("our household", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([sessionCookie(1)]);
  });

  test("an ingredient row opens the same product sheet the shopping list uses", async ({
    page,
  }) => {
    await page.goto(`/recipes/${LASAGNE}`);

    const milk = ingredient(page, "maito");
    await expect(milk.locator(".s-shopping-product")).toHaveClass(/is-note/);
    await milk.getByRole("button", { name: "Valitse", exact: true }).click();

    // The same fixed sheet, built by the same client, named after the row.
    const sheet = page.locator(".s-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.locator(".s-sheet-name")).toHaveText("maito");
    await expect(sheet.locator(".s-sheet-sub")).toContainText("Ei valittua tuotetta");

    // The choice is drawn before it is saved (#159), so the save is what has to
    // be waited for — not the row, which is already showing the answer.
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes(`/recipes/${LASAGNE}/tuote`),
    );
    await sheet
      .locator(".s-product-results > li", { hasText: "Kotimaista rasvaton maito" })
      .getByRole("button", { name: "Valitse" })
      .click();

    await expect(sheet).toBeHidden();
    await expect(milk.locator(".s-shopping-product")).toHaveClass(/is-mapped/);
    await expect(milk.locator(".s-shopping-product-copy")).toContainText(
      "Kotimaista rasvaton maito 1 l",
    );
    await expect(milk.getByRole("button", { name: "Vaihda", exact: true })).toBeVisible();

    // And it really was written down, not only drawn: the picture is there on
    // a fresh load of the screen.
    expect((await saved).ok()).toBe(true);
    await page.reload();
    await expect(ingredient(page, "maito").locator(".recipe-product-thumb"))
      .toHaveAttribute("src", new RegExp(RASVATON));
  });

  test("a product chosen from a recipe is the one the shopping list buys", async ({
    page,
  }) => {
    await chooseFromRecipe(page, LASAGNE, MAITO, "maito", RASVATON);

    const date = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Helsinki",
    }).format(new Date());
    const cooking = await page.request.post("/api/batches", {
      data: { date, slot: "dinner", recipeId: LASAGNE, multiplier: 1 },
    });
    expect(cooking.status()).toBe(201);

    await page.goto("/ostoslista");
    const milk = page.locator(".shopping-item", { hasText: "maito" });
    await milk.locator("summary").click();
    await expect(milk.locator(".s-shopping-product-summary")).toContainText(
      "Kotimaista rasvaton maito 1 l",
    );
  });

  test("a recipe can insist on its own product without changing the ingredient's", async ({
    page,
  }) => {
    await chooseFromRecipe(page, LASAGNE, MAITO, "maito", RASVATON);
    await page.goto(`/recipes/${LASAGNE}`);

    const milk = ingredient(page, "maito");
    await milk.getByRole("button", { name: "Vaihda", exact: true }).click();

    const sheet = page.locator(".s-sheet");
    await expect(sheet).toBeVisible();
    // The scope choice is the server's own element, lifted into the sheet.
    await sheet.locator(".s-product-scope-choice select").selectOption({
      label: "Käytä tässä reseptissä: Lasagne",
    });
    await sheet
      .locator(".s-product-results > li", { hasText: "Valio kevytmaito" })
      .getByRole("button", { name: "Valitse" })
      .click();

    // A pinned product changes what the row is, so the server redraws it.
    await expect(ingredient(page, "maito").locator(".recipe-product-thumb"))
      .toHaveAttribute("src", new RegExp(KEVYTMAITO));
    await expect(ingredient(page, "maito").locator(".s-shopping-product-body"))
      .toContainText("Valio kevytmaito 1 l");

    // It was written as this dish's own exception rather than as the
    // ingredient's product — which is the whole point of the two scopes (#161),
    // and the shopping list is where the difference shows.
    const date = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Helsinki",
    }).format(new Date());
    const cooking = await page.request.post("/api/batches", {
      data: { date, slot: "dinner", recipeId: LASAGNE, multiplier: 1 },
    });
    expect(cooking.status()).toBe(201);

    await page.goto("/ostoslista");
    const row = page.locator(".shopping-item", { hasText: "maito" });
    await row.locator("summary").click();
    await expect(row.locator(".s-product-scope")).toContainText(
      "Vain reseptissä Lasagne",
    );
    await expect(row.locator(".s-shopping-product-summary")).toContainText(
      "Valio kevytmaito 1 l",
    );
  });

  test("a shared recipe from another household can still be given our product", async ({
    page,
  }) => {
    await page.goto(`/recipes/${NAAPURIN_UUNIKALA}`);

    const oil = ingredient(page, "öljy");
    await oil.getByRole("button", { name: "Valitse", exact: true }).click();
    const sheet = page.locator(".s-sheet");
    await sheet
      .locator(".s-product-results > li", { hasText: "Keiju rypsiöljy" })
      .getByRole("button", { name: "Valitse" })
      .click();

    await expect(oil.locator(".s-shopping-product-copy")).toContainText(
      "Keiju rypsiöljy 1 l",
    );
  });

  test.describe("without JavaScript", () => {
    test.use({ javaScriptEnabled: false });

    test("the row still reaches a real product screen", async ({ page }) => {
      await page.goto(`/recipes/${LASAGNE}`);

      await ingredient(page, "maito")
        .getByRole("button", { name: "Valitse", exact: true })
        .click();

      await expect(page.locator("h1")).toHaveText("Valitse tuote: maito");
      await page
        .locator(".s-product-results > li", { hasText: "Kotimaista rasvaton maito" })
        .getByRole("button", { name: "Valitse" })
        .click();

      await expect(page).toHaveURL(new RegExp(`/recipes/${LASAGNE}`));
      await expect(ingredient(page, "maito").locator(".recipe-product-thumb"))
        .toHaveAttribute("src", new RegExp(RASVATON));
    });
  });
});

test.describe("every other household", () => {
  test("sees no S-ostoslista on a recipe, and no route to one", async ({
    browser,
    page,
  }) => {
    // Our household maps the oil that the neighbour's published dish also uses,
    // so there is real integration data to leak if anything is going to.
    await page.context().addCookies([sessionCookie(1)]);
    await chooseFromRecipe(page, NAAPURIN_UUNIKALA, OLJY, "öljy", "6414893000019");
    await expect(
      (await page.goto(`/recipes/${NAAPURIN_UUNIKALA}`))!.status(),
    ).toBe(200);
    await expect(ingredient(page, "öljy").locator(".recipe-product-thumb"))
      .toHaveAttribute("src", /6414893000019/);

    const neighbour = await browser.newContext();
    await neighbour.addCookies([sessionCookie(2)]);
    const theirs = await neighbour.newPage();

    await theirs.goto(`/recipes/${NAAPURIN_UUNIKALA}`);
    await expect(theirs.locator(".recipe-ingredient")).not.toHaveCount(0);
    await expect(theirs.locator(".s-shopping-product")).toHaveCount(0);
    await expect(theirs.locator("[data-product-picture]")).toHaveCount(0);
    await expect(theirs.locator("[data-product-row]")).toHaveCount(0);
    await expect(theirs.getByRole("button", { name: "Valitse", exact: true })).toHaveCount(0);
    await expect(theirs.getByRole("button", { name: "Vaihda", exact: true })).toHaveCount(0);
    // Not the shop's name for the product, and no script to search for another.
    expect(await theirs.content()).not.toContain("Keiju rypsiöljy");
    expect(await theirs.content()).not.toContain("/ostoslista/haku");

    // And the routes say the same thing the screen does, rather than merely
    // being unlinked: a bare 404, on both the search and the save.
    const opened = await theirs.request.get(
      `/recipes/${NAAPURIN_UUNIKALA}/tuote?rivi=${OLJY}&haku=öljy`,
    );
    expect(opened.status()).toBe(404);

    const saved = await theirs.request.post(`/recipes/${NAAPURIN_UUNIKALA}/tuote`, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      data: new URLSearchParams({
        rivi: String(OLJY),
        haku: "öljy",
        ean: "6414893000019",
        laajuus: "aines",
        muoto: "json",
      }).toString(),
    });
    expect(saved.status()).toBe(404);

    await neighbour.close();
  });
});
