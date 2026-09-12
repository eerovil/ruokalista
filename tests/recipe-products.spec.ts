import { expect, test, type Locator, type Page } from "@playwright/test";

import { executeLocalSql, reseed } from "./support/seed";
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

  test("choosing a product does not change the row's height", async ({ page }) => {
    // The regression CI caught and this machine did not: left to size itself,
    // the block took whatever room the product's name wanted, so a mapped row
    // left the ingredient less width — and a long ingredient then wrapped onto a
    // second line in one state and not the other. A row that grows when it is
    // given a product is the thing #200 and #204 removed from the shopping list.
    const widths = [375, 768, 1024];

    await page.goto(`/recipes/${LASAGNE}`);
    const before: number[] = [];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      const box = await ingredient(page, "maito").boundingBox();
      expect(box).not.toBeNull();
      before.push(box!.height);
    }

    await chooseFromRecipe(page, LASAGNE, MAITO, "maito", RASVATON);
    await page.goto(`/recipes/${LASAGNE}`);
    await expect(ingredient(page, "maito").locator(".s-shopping-product"))
      .toHaveClass(/is-mapped/);

    for (const [index, width] of widths.entries()) {
      await page.setViewportSize({ width, height: 900 });
      const box = await ingredient(page, "maito").boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeCloseTo(before[index]!, 0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(width);
    }
  });

  test("changing a dish's own product changes that, not everyone's", async ({
    page,
  }) => {
    // Found in review. The scope choice was drawn on a row that already had a
    // dish's own product and defaulted to "Käytä aina tälle ainekselle", so
    // changing the row wrote the *global* mapping while the override went on
    // winning — the row showed a product the screen would not use, and every
    // other dish quietly changed instead.
    await chooseFromRecipe(page, LASAGNE, MAITO, "maito", RASVATON);
    await chooseFromRecipe(page, LASAGNE, MAITO, "maito", KEVYTMAITO, String(LASAGNE));
    await page.goto(`/recipes/${LASAGNE}`);

    const milk = ingredient(page, "maito");
    await expect(milk.locator(".recipe-product-thumb"))
      .toHaveAttribute("src", new RegExp(KEVYTMAITO));
    await milk.getByRole("button", { name: "Vaihda", exact: true }).click();

    const sheet = page.locator(".s-sheet");
    await expect(sheet).toBeVisible();
    // There is no scope question on a row that is already one dish's own.
    await expect(sheet.locator(".s-product-scope-choice")).toHaveCount(0);

    await sheet
      .locator(".s-product-results > li", { hasText: "Kotimaista rasvaton maito" })
      .getByRole("button", { name: "Valitse" })
      .click();

    // What the row says after the save is what a reload says too.
    await expect(ingredient(page, "maito").locator(".recipe-product-thumb"))
      .toHaveAttribute("src", new RegExp(RASVATON));
    await page.reload();
    await expect(ingredient(page, "maito").locator(".recipe-product-thumb"))
      .toHaveAttribute("src", new RegExp(RASVATON));

    // And it moved the dish's own product, not the ingredient's: the shopping
    // list still draws this as the dish's exception.
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
      "Kotimaista rasvaton maito 1 l",
    );
  });

  test("one ingredient on two rows of a dish moves together", async ({ page }) => {
    // Also from review. A dish can name the same ingredient twice — itself and
    // in a part — and a choice on either is a choice about the ingredient. The
    // row nobody pressed used to sit there saying "Ei tuotetta" until a reload.
    executeLocalSql(`
      INSERT INTO ingredient_line
        (recipe_id, position, quantity, quantity_max, unit,
         alt_quantity, alt_unit, ingredient_id, source_line, phase)
      VALUES (${LASAGNE}, 11, 2, NULL, 'dl', NULL, NULL, ${MAITO},
              '2 dl maitoa', 'after_parts')
    `);

    await page.goto(`/recipes/${LASAGNE}`);
    const rows = page.locator(`.recipe-ingredient[data-aines="${MAITO}"]`);
    await expect(rows).toHaveCount(2);
    // Each row's own amount, not the first one's, reaches the panel.
    await expect(rows.nth(0)).toHaveAttribute("data-maara", "5 dl");
    await expect(rows.nth(1)).toHaveAttribute("data-maara", "2 dl");

    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes(`/recipes/${LASAGNE}/tuote`),
    );
    await rows.nth(0).getByRole("button", { name: "Valitse", exact: true }).click();
    await page
      .locator(".s-product-results > li", { hasText: "Kotimaista rasvaton maito" })
      .getByRole("button", { name: "Valitse" })
      .click();
    expect((await saved).ok()).toBe(true);

    for (const index of [0, 1]) {
      await expect(rows.nth(index).locator(".s-shopping-product-copy"))
        .toContainText("Kotimaista rasvaton maito 1 l");
    }
  });

  test("two rows of one ingredient cannot save over each other", async ({ page }) => {
    // The overlapping-save case. Each row used to hold its own "saving" flag,
    // so both could post at once for the *same* `ingredient_product` row: the
    // second one's rollback then restored a state older than the first one's
    // confirmed save, and the screen ended up showing a product on one row and
    // "Ei tuotetta" on the other until a reload.
    executeLocalSql(`
      INSERT INTO ingredient_line
        (recipe_id, position, quantity, quantity_max, unit,
         alt_quantity, alt_unit, ingredient_id, source_line, phase)
      VALUES (${LASAGNE}, 11, 2, NULL, 'dl', NULL, NULL, ${MAITO},
              '2 dl maitoa', 'after_parts')
    `);

    // The save is held open until this test lets it go, and counted.
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let posts = 0;
    await page.route(`**/recipes/${LASAGNE}/tuote`, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      posts += 1;
      await held;
      return route.continue();
    });

    await page.goto(`/recipes/${LASAGNE}`);
    const rows = page.locator(`.recipe-ingredient[data-aines="${MAITO}"]`);
    await expect(rows).toHaveCount(2);

    // The opener by position rather than by label: once the first choice is
    // drawn, every row of this mapping says "Vaihda" instead of "Valitse".
    async function choose(index: number, product: string): Promise<void> {
      await rows.nth(index).locator("form.s-product-open button").first().click();
      await expect(page.locator(".s-sheet .s-product-results > li").first()).toBeVisible();
      await page
        .locator(".s-sheet .s-product-results > li", { hasText: product })
        .getByRole("button", { name: "Valitse" })
        .click();
    }

    await choose(0, "Kotimaista rasvaton maito");

    // Both rows show the choice while it is still in flight: they are one
    // mapping, so there is no moment where they disagree with each other.
    for (const index of [0, 1]) {
      await expect(rows.nth(index).locator(".s-shopping-product-copy"))
        .toContainText("Kotimaista rasvaton maito 1 l");
    }
    await expect(rows.nth(0).locator(".s-status")).toContainText("Tallennetaan");

    // And saying so moves nothing: the busy slot is reserved, not inserted.
    const saving = await rows.nth(0).boundingBox();
    const neighbour = await rows.nth(1).boundingBox();
    expect(saving).not.toBeNull();
    expect(neighbour).not.toBeNull();
    expect(saving!.height).toBeCloseTo(neighbour!.height, 0);

    // A second choice on the sibling while that save is open is ignored — the
    // same rule a single row has always followed.
    await choose(1, "Valio kevytmaito");
    expect(posts).toBe(1);

    release!();
    await expect(rows.nth(0).locator(".s-status")).toBeEmpty();
    await page.unroute(`**/recipes/${LASAGNE}/tuote`);
    await page.reload();
    for (const index of [0, 1]) {
      await expect(rows.nth(index).locator(".s-shopping-product-copy"))
        .toContainText("Kotimaista rasvaton maito 1 l");
    }
  });

  test("a refused save puts both rows of one ingredient back", async ({ page }) => {
    executeLocalSql(`
      INSERT INTO ingredient_line
        (recipe_id, position, quantity, quantity_max, unit,
         alt_quantity, alt_unit, ingredient_id, source_line, phase)
      VALUES (${LASAGNE}, 11, 2, NULL, 'dl', NULL, NULL, ${MAITO},
              '2 dl maitoa', 'after_parts')
    `);

    await page.route(`**/recipes/${LASAGNE}/tuote`, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      return route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: "Tuotetta ei voitu varmistaa S-ostoslistasta." }),
      });
    });

    await page.goto(`/recipes/${LASAGNE}`);
    const rows = page.locator(`.recipe-ingredient[data-aines="${MAITO}"]`);
    await rows.nth(0).getByRole("button", { name: "Valitse", exact: true }).click();
    await page
      .locator(".s-sheet .s-product-results > li", { hasText: "Kotimaista rasvaton maito" })
      .getByRole("button", { name: "Valitse" })
      .click();

    // Nothing was written, so neither row is left claiming otherwise.
    await expect(page.locator(".s-toast")).toContainText("ei voitu varmistaa");
    for (const index of [0, 1]) {
      await expect(rows.nth(index).locator(".s-shopping-product")).toHaveClass(/is-note/);
      await expect(rows.nth(index)).toContainText("Ei tuotetta");
    }
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

    test("the second of two rows for one ingredient is its own row", async ({
      page,
    }) => {
      // Without JavaScript the row is named only by what `rivi` carries, and
      // that used to be the ingredient alone — so opening the second of two
      // milk rows reached the route as "milk" and it rebuilt the first one.
      executeLocalSql(`
        INSERT INTO ingredient_line
          (recipe_id, position, quantity, quantity_max, unit,
           alt_quantity, alt_unit, ingredient_id, source_line, phase)
        VALUES (${LASAGNE}, 11, 2, NULL, 'dl', NULL, NULL, ${MAITO},
                '2 dl maitoa', 'after_parts')
      `);

      await page.goto(`/recipes/${LASAGNE}`);
      const rows = page.locator(`.recipe-ingredient[data-aines="${MAITO}"]`);
      await expect(rows).toHaveCount(2);

      await rows.nth(1).locator("form.s-product-open button").first().click();
      await expect(page.locator("h1")).toHaveText("Valitse tuote: maito");
      await expect(page.locator(".s-product-row-amount")).toContainText("2 dl");
      await expect(page.locator(".s-product-row-amount")).not.toContainText("5 dl");

      // And back again for the other one, which is the row it says it is.
      await page.goBack();
      await rows.nth(0).locator("form.s-product-open button").first().click();
      await expect(page.locator(".s-product-row-amount")).toContainText("5 dl");

      // Choosing from that page still writes the ingredient's mapping.
      await page
        .locator(".s-product-results > li", { hasText: "Kotimaista rasvaton maito" })
        .getByRole("button", { name: "Valitse" })
        .click();
      await expect(page).toHaveURL(new RegExp(`/recipes/${LASAGNE}`));
      for (const index of [0, 1]) {
        await expect(rows.nth(index).locator(".s-shopping-product-copy"))
          .toContainText("Kotimaista rasvaton maito 1 l");
      }
    });

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
