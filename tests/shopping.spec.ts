import { expect, test, type Page } from "@playwright/test";

import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

const browserPort = Number(process.env["PLAYWRIGHT_PORT"] ?? "8787");
const S_OSTOSLISTA_FIXTURE = `http://127.0.0.1:${browserPort + 1}`;

/**
 * The shopping list. Every date here is relative to today, because the screen's
 * whole behaviour — the fortnight it offers and the five days it preselects —
 * is relative to today too.
 *
 * The database goes back to the seed before every test rather than once for
 * the file: several of these count what the picker offers, and a cooking left
 * behind by an earlier test would quietly change that count.
 */

test.beforeEach(async ({ context, request }) => {
  reseed();
  expect((await request.post(`${S_OSTOSLISTA_FIXTURE}/_test/reset`)).ok()).toBe(true);
  await context.addCookies([sessionCookie(1)]);
});

const KAALILAATIKKO = 1;
const LASAGNE = 3;

/** Today in Helsinki, which is what the Worker means by today. */
function today(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Helsinki",
  }).format(new Date());
}

function inDays(days: number): string {
  const [year, month, day] = today().split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const at = new Date(Date.UTC(year, month - 1, day));
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

async function createBatch(
  page: Page,
  date: string,
  recipeId: number,
  portions: number,
): Promise<number> {
  const response = await page.request.post("/api/batches", {
    data: { date, slot: "dinner", recipeId, portions },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { id: number }).id;
}

/**
 * A recipe measuring milk in spoons, so the list has two units of one
 * ingredient to keep apart. The seed has no such pair, and inventing one there
 * would change what every other spec sees.
 */
async function createSpoonedSauce(page: Page): Promise<number> {
  const response = await page.request.post("/recipes", {
    maxRedirects: 0,
    form: {
      title: "Maitokastike",
      yield: "2",
      sourceText: "Maitokastike\n2 rkl maitoa",
      sourceRoute: "pasted",
      structuredBy: "test",
      lineCount: "1",
      "line.0.quantity": "2",
      "line.0.quantityMax": "",
      "line.0.unit": "rkl",
      "line.0.altQuantity": "",
      "line.0.altUnit": "",
      "line.0.section": "",
      "line.0.position": "1",
      "line.0.ingredient": "9",
      "line.0.sourceLine": "2 rkl maitoa",
    },
  });
  expect(response.status()).toBe(302);

  const location = response.headers()["location"] ?? "";
  const id = Number(location.split("/").pop());
  expect(Number.isSafeInteger(id)).toBe(true);
  return id;
}

/**
 * The fixture the assertions below read: three cookings inside the five-day
 * default and one beyond it but still inside the fortnight.
 */
async function planTheFortnight(page: Page): Promise<{ lasagne: number }> {
  // Twice its own yield, so every amount on it is scaled.
  await createBatch(page, today(), KAALILAATIKKO, 8);
  const lasagne = await createBatch(page, inDays(2), LASAGNE, 6);
  const sauce = await createSpoonedSauce(page);
  await createBatch(page, inDays(3), sauce, 2);
  // Beyond the five days, inside the fortnight.
  await createBatch(page, inDays(10), KAALILAATIKKO, 4);
  return { lasagne };
}

function row(page: Page, name: string) {
  return page.locator(".shopping-list > li", { hasText: name }).first();
}

async function chooseProduct(
  page: Page,
  ingredient: string,
  product: string,
): Promise<void> {
  const item = row(page, ingredient);
  await item.locator("summary").click();
  await item.getByRole("button", { name: /Valitse tuote|Vaihda tuote/ }).click();
  const result = page.locator(".s-product-results > li", { hasText: product });
  await expect(result).toBeVisible();
  await result.getByRole("button", { name: "Valitse" }).click();
}

async function externalRequests(page: Page): Promise<
  Array<{ method: string; path: string; body: Record<string, unknown> | null }>
> {
  const response = await page.request.get(`${S_OSTOSLISTA_FIXTURE}/_test/requests`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as {
    requests: Array<{
      method: string;
      path: string;
      body: Record<string, unknown> | null;
    }>;
  }).requests;
}

test("the list opens on the next five days' cookings", async ({ page }) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");

  // The fortnight is all offered; only the imminent part is ticked.
  await expect(page.locator(".shopping-meals li")).toHaveCount(4);
  await expect(page.locator(".shopping-meals input:checked")).toHaveCount(3);
  await expect(page.locator(".shopping-picker > summary")).toContainText(
    "3/4 valittu",
  );

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Ostoslista: Kaalilaatikko + Lasagne + Maitokastike",
  );
});

test("what the selected cookings add up to", async ({ page }) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");

  // Kaalilaatikko at twice its yield: ½ dl of oil becomes 1 dl.
  await expect(row(page, "öljy").locator(".shopping-total")).toHaveText("1 dl");
  // A range scales at both ends and stays a range.
  await expect(row(page, "vesi").locator(".shopping-total")).toHaveText("2–3 l");
  // Two units of one ingredient are two amounts, never one converted one.
  await expect(row(page, "maito").locator(".shopping-total")).toHaveText(
    "5 dl + 2 rkl",
  );
  // A second measurement of the same item is not a second item to buy.
  await expect(row(page, "valkokaali").locator(".shopping-total")).toHaveText(
    "1 kpl",
  );
  // The recipe never said how much, and the list says exactly that.
  await expect(
    row(page, "sitruunaruoho").locator(".shopping-total"),
  ).toHaveText("määrä reseptin mukaan");
  // A part's ingredients are on the list, scaled with the dish.
  await expect(row(page, "jauheliha").locator(".shopping-total")).toHaveText(
    "400 g",
  );
});

test("an external product can be selected, persisted, and replaced", async ({
  page,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");

  await chooseProduct(page, "maito", "Kotimaista rasvaton maito");
  const milk = row(page, "maito");
  await expect(milk.locator(".s-shopping-product-summary")).toContainText(
    "Kotimaista rasvaton maito 1 l",
  );
  await expect(milk.locator(".s-shopping-product-summary img")).toHaveAttribute(
    "src",
    /cdn\.s-cloud\.fi.*6415712506032/,
  );

  await page.reload();
  await expect(row(page, "maito").locator(".s-shopping-product-summary")).toContainText(
    "Kotimaista rasvaton maito 1 l",
  );

  const reloadedMilk = row(page, "maito");
  await reloadedMilk.locator("summary").click();
  await reloadedMilk.getByRole("button", { name: "Vaihda tuote" }).click();
  await page.getByLabel("Haku").fill("kahvi");
  await page.getByRole("button", { name: "Hae tuotteita" }).click();
  await page
    .locator(".s-product-results > li", { hasText: "Juhla Mokka" })
    .getByRole("button", { name: "Valitse" })
    .click();
  await expect(row(page, "maito").locator(".s-shopping-product-summary")).toContainText(
    "Juhla Mokka kahvi 500 g",
  );
});

test("product selection preserves an explicit non-default meal selection", async ({
  page,
}) => {
  await planTheFortnight(page);
  const futureLasagne = await createBatch(page, inDays(11), LASAGNE, 6);
  await page.goto("/ostoslista");
  await page.locator(".shopping-picker > summary").click();
  const checked = page.locator(".shopping-meals input:checked");
  for (let at = (await checked.count()) - 1; at >= 0; at -= 1) {
    await checked.nth(at).uncheck();
  }
  await page.locator(`.shopping-meals input[value="${futureLasagne}"]`).check();
  await page.getByRole("button", { name: "Päivitä lista" }).click();

  await chooseProduct(page, "maito", "Kotimaista rasvaton maito");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Ostoslista: Lasagne",
  );
  await expect(page.locator(".shopping-meals input:checked")).toHaveCount(1);
  await expect(
    page.locator(`.shopping-meals input[value="${futureLasagne}"]`),
  ).toBeChecked();
});

test("a forged product result is refused and never persisted", async ({ page }) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  const milk = row(page, "maito");
  await milk.locator("summary").click();
  await milk.getByRole("button", { name: "Valitse tuote" }).click();

  const result = page.locator(".s-product-results > li").first();
  await result.locator('input[name="ean"]').evaluate((input: HTMLInputElement) => {
    input.value = "0000000000000";
  });
  await result.getByRole("button", { name: "Valitse" }).click();
  await expect(page.locator(".refused")).toContainText(
    "Valittua tuotetta ei löytynyt uudesta hausta",
  );

  await page.goto("/ostoslista");
  await row(page, "maito").locator("summary").click();
  await expect(row(page, "maito").locator(".s-shopping-product.is-note")).toBeVisible();
});

test("a missing CDN image is hidden without breaking product choice", async ({ page }) => {
  await page.route("**/6415712506032_kuva1.jpg", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: "{}" }),
  );
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  const milk = row(page, "maito");
  await milk.locator("summary").click();
  await milk.getByRole("button", { name: "Valitse tuote" }).click();

  const result = page.locator(".s-product-results > li").first();
  await expect(result).toBeVisible();
  await expect(result.locator("img")).toBeHidden();
  await expect(result.getByRole("button", { name: "Valitse" })).toBeEnabled();
});

test("sending uses stored EANs, note fallbacks, and excludes the pantry", async ({
  page,
  request,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  await chooseProduct(page, "maito", "Kotimaista rasvaton maito");

  const oil = row(page, "öljy");
  await oil.locator("summary").click();
  await oil.getByRole("button", { name: "Löytyy jo kaapista" }).click();

  // Keep the local ingredient mapping, but clear the external call log and
  // list so this send proves a stored EAN needs no second product search.
  await request.post(`${S_OSTOSLISTA_FIXTURE}/_test/reset`);
  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();
  await expect(page.locator(".shopping-sent")).toContainText(
    "lähetettiin S-ostoslistaan",
  );

  const calls = await externalRequests(page);
  expect(calls.some((call) => call.path.startsWith("/products"))).toBe(false);
  const added = calls.filter((call) => call.method === "POST" && call.path === "/items");
  expect(added.some((call) => call.body?.["ean"] === "6415712506032")).toBe(true);
  expect(added.some((call) => call.body?.["note"] === "vesi — 2–3 l")).toBe(true);
  expect(added.some((call) => String(call.body?.["note"] ?? "").startsWith("öljy"))).toBe(
    false,
  );
  expect(added.every((call) => !("quantity" in (call.body ?? {})))).toBe(true);
});

test("an external outage refuses recoverably without replacing the list", async ({
  page,
  request,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  await request.post(`${S_OSTOSLISTA_FIXTURE}/_test/fail-next`);
  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();

  await expect(page.locator(".refused")).toContainText(
    "S-ostoslistaan ei saatu lähetettyä kaikkea",
  );
  await expect(row(page, "maito")).toBeVisible();
});

test("a failed product search keeps the local ingredient unmapped", async ({ page }) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista/tuote?aines=9&haku=virhe");
  await expect(page.locator(".refused")).toContainText("tuotehakua ei saatu avattua");

  await page.goto("/ostoslista");
  const milk = row(page, "maito");
  await milk.locator("summary").click();
  await expect(milk.locator(".s-shopping-product.is-note")).toBeVisible();
});

test("an ingredient opens to say where its total came from", async ({ page }) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");

  const milk = row(page, "maito");
  await milk.locator("summary").click();

  const from = milk.locator(".shopping-from li");
  await expect(from).toHaveCount(2);
  await expect(from.first()).toContainText("Lasagne · Juustokastike");
  await expect(from.first().locator(".shopping-from-amount")).toHaveText("5 dl");
  await expect(from.last()).toContainText("Maitokastike");
  await expect(from.last().locator(".shopping-from-amount")).toHaveText("2 rkl");

  // The wording the source used is kept, which is the whole point for a line
  // that never stated a number.
  const lemongrass = row(page, "sitruunaruoho");
  await lemongrass.locator("summary").click();
  await expect(lemongrass.locator(".source")).toHaveText(
    "hieman sitruunaruohoa",
  );
});

test("unticking a cooking takes its ingredients with it", async ({ page }) => {
  const { lasagne } = await planTheFortnight(page);
  await page.goto("/ostoslista");

  await page.locator(".shopping-picker > summary").click();
  await page.locator(`.shopping-meals input[value="${lasagne}"]`).uncheck();
  await page.getByRole("button", { name: "Päivitä lista" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Ostoslista: Kaalilaatikko + Maitokastike",
  );
  await expect(row(page, "maito").locator(".shopping-total")).toHaveText("2 rkl");
  await expect(page.locator(".shopping-list > li", { hasText: "jauheliha" })).toHaveCount(
    0,
  );
});

test("ticking one further out adds it", async ({ page }) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");

  await page.locator(".shopping-picker > summary").click();
  await page.locator(".shopping-meals input").last().check();
  await page.getByRole("button", { name: "Päivitä lista" }).click();

  await expect(page.locator(".shopping-picker > summary")).toContainText(
    "4/4 valittu",
  );
  // A second Kaalilaatikko at its own yield adds another ½ dl of oil.
  await expect(row(page, "öljy").locator(".shopping-total")).toHaveText("1½ dl");
});

test("unticking everything is a thing a member is allowed to mean", async ({
  page,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista?valittu=1");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ostoslista");
  await expect(page.locator(".shopping-list")).toHaveCount(0);
  await expect(page.locator(".empty")).toContainText("Valitse ainakin yksi");
  // With nothing chosen the picker opens itself, because choosing is all there
  // is left to do.
  await expect(page.locator(".shopping-picker[open]")).toHaveCount(1);
});

test("a cooking that feeds several days is bought for once", async ({ page }) => {
  const id = await createBatch(page, today(), KAALILAATIKKO, 8);

  await page.goto("/ostoslista");
  await expect(row(page, "öljy").locator(".shopping-total")).toHaveText("1 dl");

  // The same pot, now covering three days and four meals.
  const spread = await page.request.patch(`/api/batches/${id}`, {
    data: {
      occurrences: [
        { date: today(), slot: "dinner" },
        { date: inDays(1), slot: "lunch" },
        { date: inDays(1), slot: "dinner" },
        { date: inDays(2), slot: "lunch" },
      ],
    },
  });
  expect(spread.status()).toBe(204);

  await page.goto("/ostoslista");
  await expect(row(page, "öljy").locator(".shopping-total")).toHaveText("1 dl");
  await row(page, "öljy").locator("summary").click();
  await expect(row(page, "öljy").locator(".shopping-from li")).toHaveCount(1);
});

test("a cooking already behind us is not shopped for", async ({ page }) => {
  await createBatch(page, inDays(-1), KAALILAATIKKO, 8);

  await page.goto("/ostoslista");
  await expect(page.locator(".shopping-meals li")).toHaveCount(0);
  await expect(page.locator(".empty")).toContainText("ei kokata mitään");
});

test("another household's cookings are not on our list", async ({
  page,
  browser,
}) => {
  await planTheFortnight(page);

  const context = await browser.newContext();
  await context.addCookies([sessionCookie(2)]);
  const neighbour = await context.newPage();

  await neighbour.goto("/ostoslista");
  await expect(neighbour.locator(".shopping-meals li")).toHaveCount(0);
  await expect(neighbour.locator(".shopping-list")).toHaveCount(0);
  await expect(neighbour.locator(".s-shopping-send")).toHaveCount(0);
  expect(
    (await neighbour.request.post("/ostoslista/laheta", { form: {} })).status(),
  ).toBe(404);
  expect(
    (await neighbour.request.get("/ostoslista/tuote?aines=9&haku=maito")).status(),
  ).toBe(404);
  expect(
    (await neighbour.request.post("/ostoslista/tuote", {
      form: { aines: "9", haku: "maito", ean: "6415712506032" },
    })).status(),
  ).toBe(404);

  await context.close();
});

test("another household's batch id on the query string buys nothing", async ({
  page,
  browser,
}) => {
  const { lasagne } = await planTheFortnight(page);

  const context = await browser.newContext();
  await context.addCookies([sessionCookie(2)]);
  const neighbour = await context.newPage();

  await neighbour.goto(`/ostoslista?valittu=1&ateria=${lasagne}`);
  await expect(neighbour.getByRole("heading", { level: 1 })).toHaveText(
    "Ostoslista",
  );
  await expect(neighbour.locator(".shopping-list")).toHaveCount(0);

  await context.close();
});
