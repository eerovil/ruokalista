import { expect, test, type Page } from "@playwright/test";

import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

const browserPort = Number(process.env["PLAYWRIGHT_PORT"] ?? "8787");
const S_OSTOSLISTA_FIXTURE = `http://127.0.0.1:${browserPort + 1}`;

/** Reading the store, and the household wall around it. */

test.beforeAll(reseed);

test.beforeEach(async ({ context }) => {
  await context.addCookies([sessionCookie(1)]);
});

test("the list shows the household's recipes, newest first", async ({ page }) => {
  await page.goto("/recipes");

  const titles = page.locator(".recipes a");
  await expect(titles.first()).toContainText("Lasagne");
  await expect(titles.nth(1)).toContainText("Öljykastike");
  // Three dishes. The lasagne's two parts are not dishes and are not listed.
  await expect(page.locator(".recipes li")).toHaveCount(3);
});

test("search matches regardless of case", async ({ page }) => {
  await page.goto("/recipes");
  await page.getByLabel("Hae nimellä").fill("KAALI");
  await page.getByRole("button", { name: "Hae" }).click();

  await expect(page.locator(".recipes li")).toHaveCount(1);
  await expect(page.locator(".recipes a")).toContainText("Kaalilaatikko");
});

test("a search that finds nothing says so, and what to do next", async ({
  page,
}) => {
  await page.goto("/recipes?q=pizza");
  await expect(page.locator(".nothing")).toContainText("pizza");
  await page.getByRole("link", { name: "Näytä kaikki reseptit" }).click();
  await expect(page.locator(".recipes li").first()).toBeVisible();
});

test("a recipe renders every awkward line shape", async ({ page }) => {
  await page.goto("/recipes/1");

  const lines = page.locator(".lines li");
  // A plain amount, a range read as one figure, a second measurement shown in
  // full, and a line whose amount the source never gave.
  await expect(lines.nth(0)).toContainText("½ dl");
  await expect(lines.nth(1)).toContainText("1–1½ l");
  await expect(lines.nth(2)).toContainText("½ kpl (500 g)");
  await expect(lines.nth(3)).toContainText("sitruunaruoho");
  await expect(lines.nth(3)).not.toContainText("0");

  // Evidence is selective. A range and a second measurement round-trip through
  // the fields intact, so a copy underneath would only be a second thing to
  // read — but a line the source gave no amount for lost its "hieman", and that
  // only exists in the source.
  await expect(lines.nth(0).locator(".source")).toHaveCount(0);
  await expect(lines.nth(1).locator(".source")).toHaveCount(0);
  await expect(lines.nth(2).locator(".source")).toHaveCount(0);
  await expect(lines.nth(3).locator(".source")).toContainText(
    "hieman sitruunaruohoa",
  );
});

test.describe("linked product pictures", () => {
  test.beforeEach(async ({ request }) => {
    reseed();
    expect((await request.post(`${S_OSTOSLISTA_FIXTURE}/_test/reset`)).ok()).toBe(true);
  });

  test.afterEach(reseed);

  async function linkMilkProduct(
    page: Page,
    ean = "6415712506032",
    scope = "aines",
  ): Promise<void> {
    const date = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Helsinki",
    }).format(new Date());
    const cooking = await page.request.post("/api/batches", {
      data: { date, slot: "dinner", recipeId: 3, multiplier: 1 },
    });
    expect(cooking.status()).toBe(201);
    const cookingId = ((await cooking.json()) as { id: number }).id;

    const form = new URLSearchParams({
      rivi: "9",
      aines: "9",
      haku: "maito",
      ean,
      laajuus: scope,
      valittu: "1",
      ateria: String(cookingId),
      muoto: "json",
    });
    const linked = await page.request.post("/ostoslista/tuote", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      data: form.toString(),
    });
    expect(linked.ok()).toBe(true);
  }

  test("a recipe-specific product picture wins without changing recipe JSON", async ({
    page,
  }) => {
    await linkMilkProduct(page);
    await linkMilkProduct(page, "6414893386488", "3");
    await page.goto("/recipes/3");

    const milk = page.locator(".recipe-ingredient", { hasText: "maito" });
    await expect(milk.locator(".recipe-product-thumb")).toHaveAttribute(
      "src",
      /cdn\.s-cloud\.fi.*6414893386488/,
    );

    const response = await page.request.get("/api/recipes/3");
    const body = (await response.json()) as {
      recipe: {
        lines: Array<Record<string, unknown>>;
        parts: Array<{ lines: Array<Record<string, unknown>> }>;
      };
    };
    const lines = [body.recipe.lines, ...body.recipe.parts.map((part) => part.lines)].flat();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toHaveProperty("productImageUrl");
  });

  test("a product picture stays compact at phone, tablet, and desktop widths", async ({
    page,
  }) => {
    await linkMilkProduct(page);
    await page.goto("/recipes/3");

    const milk = page.locator(".recipe-ingredient", { hasText: "maito" });
    const cheese = page.locator(".recipe-ingredient", { hasText: "juusto" });
    const thumb = milk.locator(".recipe-product-thumb");
    await expect(thumb).toBeVisible();
    await expect(thumb).toHaveAttribute("src", /cdn\.s-cloud\.fi.*6415712506032/);
    await expect(cheese.locator("img")).toHaveCount(0);

    for (const width of [375, 768, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      const [rowBox, copyBox, imageBox, amountBox, plainBox] = await Promise.all([
        milk.boundingBox(),
        milk.locator(".recipe-ingredient-copy").boundingBox(),
        thumb.boundingBox(),
        milk.locator(".amount").boundingBox(),
        cheese.boundingBox(),
      ]);
      expect(rowBox).not.toBeNull();
      expect(copyBox).not.toBeNull();
      expect(imageBox).not.toBeNull();
      expect(amountBox).not.toBeNull();
      expect(plainBox).not.toBeNull();
      expect(imageBox!.width).toBeLessThanOrEqual(26);
      expect(imageBox!.height).toBeLessThanOrEqual(26);
      expect(copyBox!.x).toBeGreaterThanOrEqual(imageBox!.x + imageBox!.width);
      expect(amountBox!.x + amountBox!.width).toBeLessThanOrEqual(
        rowBox!.x + rowBox!.width,
      );
      expect(rowBox!.height).toBeLessThanOrEqual(plainBox!.height + 2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(width);
    }
  });

  test("a product whose picture cannot load leaves no placeholder", async ({ page }) => {
    await page.route("**/6415712506032_kuva1.jpg", (route) =>
      route.fulfill({ status: 404, contentType: "image/jpeg", body: "" }),
    );
    await linkMilkProduct(page);
    await page.goto("/recipes/3");

    const milk = page.locator(".recipe-ingredient", { hasText: "maito" });
    await expect(milk.locator(".recipe-product-thumb")).toBeHidden();
    await expect(milk).toContainText("5 dl maito");
  });
});

test("the cooking view uses tablet width without clipping long steps", async ({
  page,
}) => {
  await page.goto("/recipes/1");

  const ingredients = page.locator(".recipe-section").first().locator(".lines");
  const method = page.locator(".recipe-section").first().locator(".steps");
  const mobileIngredients = await ingredients.boundingBox();
  const mobileMethod = await method.boundingBox();
  expect(mobileIngredients).not.toBeNull();
  expect(mobileMethod).not.toBeNull();
  expect(mobileMethod!.y).toBeGreaterThanOrEqual(
    mobileIngredients!.y + mobileIngredients!.height,
  );

  await page.setViewportSize({ width: 768, height: 1024 });
  const tabletIngredients = await ingredients.boundingBox();
  const tabletMethod = await method.boundingBox();
  expect(tabletIngredients).not.toBeNull();
  expect(tabletMethod).not.toBeNull();
  expect(tabletMethod!.x).toBeGreaterThanOrEqual(
    tabletIngredients!.x + tabletIngredients!.width,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(768);

  const step = method.locator("li").first();
  const before = await step.boundingBox();
  await step.evaluate((element) => {
    element.textContent = `${element.textContent ?? ""} ${"Pitkä valmistusohje rivittyy kokonaan näkyviin. ".repeat(16)}`;
  });
  const after = await step.boundingBox();
  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  expect(after!.height).toBeGreaterThan(before!.height);
  expect(await step.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    overflowY: getComputedStyle(element).overflowY,
    whiteSpace: getComputedStyle(element).whiteSpace,
  }))).toEqual(expect.objectContaining({
    overflowY: "visible",
    whiteSpace: "normal",
  }));
  expect(await step.evaluate((element) => element.scrollWidth))
    .toBeLessThanOrEqual(await step.evaluate((element) => element.clientWidth));
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(768);
});

test("the original text is one tap away, not in the way", async ({ page }) => {
  await page.goto("/recipes/1");

  // Present, but closed: at the hob the recipe is the point.
  const disclosure = page.locator(".source-original");
  await expect(disclosure).toBeVisible();
  await expect(page.locator(".source-text")).toBeHidden();

  await disclosure.getByText("Näytä alkuperäinen").click();
  await expect(page.locator(".source-text")).toContainText("hieman sitruunaruohoa");
});

test("editing is reachable, but it is not what the screen is for", async ({
  page,
}) => {
  await page.goto("/recipes/1");

  const edit = page.getByRole("link", { name: "Muokkaa reseptiä" });
  await expect(edit).toBeVisible();

  // Below the cooking, not above it.
  const method = await page.locator("ol").first().boundingBox();
  const editBox = await edit.boundingBox();
  expect(editBox!.y).toBeGreaterThan(method!.y);
});

test("a recipe with a known yield shows it as source metadata", async ({
  page,
}) => {
  await page.goto("/recipes/1");
  await expect(page.locator(".source-yield")).toHaveText("Lähteessä 4 annosta");
  // And the scaling line says what the amounts on screen are, not that.
  await expect(page.locator(".yield")).toContainText("resepti sellaisenaan");
});

test("plain recipe JSON keeps its existing public shape", async ({ page }) => {
  const response = await page.request.get("/api/recipes/1");
  const body = (await response.json()) as {
    recipe: { steps: unknown[]; lines: Array<Record<string, unknown>> };
  };

  expect(body.recipe.steps[0]).toBe("Kuullota kaali öljyssä.");
  expect(body.recipe.lines[0]).not.toHaveProperty("phase");
  expect(body.recipe.lines[0]).not.toHaveProperty("productImageUrl");
});

test("a recipe with no stated yield says nothing about one (#165)", async ({
  page,
}) => {
  await page.goto("/recipes/2");
  await expect(page.locator(".source-yield")).toHaveCount(0);
  await expect(page.locator(".yield")).toContainText("resepti sellaisenaan");
});

test("another household's recipe is a 404, not a peek", async ({ browser }) => {
  const context = await browser.newContext();
  await context.addCookies([sessionCookie(2)]);
  const page = await context.newPage();

  const response = await page.goto("/recipes/1");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Ei löytynyt" })).toBeVisible();

  const api = await page.request.get("/api/recipes/1");
  expect(api.status()).toBe(404);

  await context.close();
});

test("the ingredient dictionary is one dictionary, but its counts are not", async ({
  browser,
}) => {
  // Until #143 this asserted that the neighbour saw only their own ingredient.
  // The dictionary is deliberately global now — one canonical `suola` for
  // everybody — because a published recipe's lines have to mean the same
  // foodstuff in every household's shopping list.
  const context = await browser.newContext();
  await context.addCookies([sessionCookie(2)]);

  const response = await context.request.get("/api/ingredients");
  const body = (await response.json()) as {
    ingredients: { name: string; recipeCount: number }[];
  };
  const names = body.ingredients.map((i) => i.name);
  expect(names).toContain("naapurin suola");
  expect(names).toContain("valkokaali");

  // What the neighbour still cannot see is how household 1 uses them: the
  // count is over the recipes this household can open, and Koti's are private.
  const cabbage = body.ingredients.find((i) => i.name === "valkokaali");
  expect(cabbage?.recipeCount).toBe(0);

  await context.close();
});

test("ingredients collate in Finnish", async ({ page }) => {
  const response = await page.request.get("/api/ingredients");
  const body = (await response.json()) as {
    ingredients: { name: string; recipeCount: number }[];
  };

  const names = body.ingredients.map((i) => i.name);
  // ö sorts last in Finnish; SQLite's ASCII-only NOCASE would file it after z.
  expect(names[names.length - 1]).toBe("öljy");
  expect(names).toContain("ananas");

  const unused = body.ingredients.find((i) => i.name === "ananas");
  expect(unused?.recipeCount).toBe(0);
});
