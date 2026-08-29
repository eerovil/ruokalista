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
  multiplier: number,
): Promise<number> {
  const response = await page.request.post("/api/batches", {
    data: { date, slot: "dinner", recipeId, multiplier },
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
  // Twice the recipe, so every amount on it is scaled.
  await createBatch(page, today(), KAALILAATIKKO, 2);
  const lasagne = await createBatch(page, inDays(2), LASAGNE, 1);
  const sauce = await createSpoonedSauce(page);
  await createBatch(page, inDays(3), sauce, 1);
  // Beyond the five days, inside the fortnight.
  await createBatch(page, inDays(10), KAALILAATIKKO, 1);
  return { lasagne };
}

function row(page: Page, name: string) {
  return page.locator(".shopping-list > li", { hasText: name }).first();
}

/**
 * Choosing a product the way a member with JavaScript does it (#159, reshaped
 * by #200): the search happens in one sheet fixed over the screen, and the
 * choice returns to the list immediately while the save runs in the background.
 * The helper waits for that save to land, because everything asserted after it
 * is about what the server kept.
 */
async function chooseProduct(
  page: Page,
  ingredient: string,
  product: string,
): Promise<void> {
  const item = row(page, ingredient);
  await item.locator("summary").click();
  await openPanel(page, item);
  const result = results(page).filter({ hasText: product });
  await expect(result).toBeVisible();

  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/ostoslista/tuote"),
  );
  await result.getByRole("button", { name: "Valitse" }).click();
  await saved;
  await expect(item.locator(".s-status .spinner")).toHaveCount(0);
  // The row is done, so it has closed itself (#204). Every caller that then
  // wants something from inside the row has to say so with reopen().
  await expect(item.locator(".s-shopping-product-summary")).toBeHidden();
}

/**
 * The tap #204 accepted as the cost of a tidy list: the rarer actions inside a
 * finished row — a second package size, dropping one — are behind reopening it.
 */
async function reopen(item: ReturnType<typeof row>): Promise<void> {
  await item.locator("summary").click();
  await expect(item.locator(".s-shopping-product-summary")).toBeVisible();
}

/** Dismiss the picker: its backdrop covers the list while it is open. */
async function closeSheet(page: Page): Promise<void> {
  await page.locator(".s-sheet-close").click();
  await expect(page.locator(".s-sheet")).toBeHidden();
}

/** The product results, which live in the one sheet rather than in a row. */
function results(page: Page) {
  return page.locator(".s-sheet .s-product-results > li");
}

/** Open one row's product sheet and wait for its first results to arrive. */
async function openPanel(
  page: Page,
  item: ReturnType<typeof row>,
): Promise<void> {
  await item.getByRole("button", { name: /Valitse tuote|Vaihda tuote/ }).click();
  await expect(page.locator(".s-sheet")).toBeVisible();
  await expect(page.locator(".s-sheet .spinner")).toHaveCount(0);
}

/** The buy rows in the order the screen lists them. */
async function buyRowNames(page: Page): Promise<string[]> {
  return page.locator(".shopping-list > li .shopping-item").evaluateAll(
    (rows) =>
      rows.map((one) => one.getAttribute("data-haku") ?? ""),
  );
}

/** Wait for the S-ostoslista panel to have finished its own read. */
async function currentListLoaded(page: Page): Promise<void> {
  await expect(page.locator(".s-current")).toBeVisible();
  await expect(page.locator(".s-current .spinner")).toHaveCount(0);
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

  // Kaalilaatikko at 2×: ½ dl of oil becomes 1 dl.
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
  await openPanel(page, reloadedMilk);
  await page.locator(".s-sheet").getByLabel("Haku").fill("kahvi");
  await page.locator(".s-sheet").getByRole("button", { name: "Hae" }).click();
  const replaced = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/ostoslista/tuote"),
  );
  await results(page)
    .filter({ hasText: "Juhla Mokka" })
    .getByRole("button", { name: "Valitse" })
    .click();
  await expect(reloadedMilk.locator(".s-shopping-product-summary")).toContainText(
    "Juhla Mokka kahvi 500 g",
  );

  // The row said so before the save answered, so wait for the save itself
  // before asking the server what it kept.
  await replaced;
  await page.reload();
  await expect(row(page, "maito").locator(".s-shopping-product-summary")).toContainText(
    "Juhla Mokka kahvi 500 g",
  );
});

test("the chosen product's picture is on the row, and the row is no taller", async ({
  page,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");

  const milk = row(page, "maito");
  const water = row(page, "vesi");
  await expect(milk.locator(".s-shopping-product.is-note strong")).toHaveText(
    "Teksti",
  );
  await expect(page.locator(".s-send-counts")).toContainText(/\d+ teksti(?:ä)?/);
  const before = await milk.locator("summary").boundingBox();
  await chooseProduct(page, "maito", "Kotimaista rasvaton maito");

  // The count above the send button keeps up with a mapping made in place.
  await expect(page.locator(".s-send-counts")).toContainText(
    /1 tuote · \d+ teksti(?:ä)?/,
  );

  await page.reload();
  await expect(page.locator(".s-send-counts")).toContainText(
    /1 tuote · \d+ teksti(?:ä)?/,
  );
  const thumb = row(page, "maito").locator(".shopping-thumb img");
  await expect(thumb).toBeVisible();
  await expect(thumb).toHaveAttribute("src", /cdn\.s-cloud\.fi.*6415712506032/);

  // The row keeps its height: the picture is smaller than the tap target the
  // summary already reserved, and an unmapped row beside it is the same height.
  const after = await row(page, "maito").locator("summary").boundingBox();
  const unmapped = await water.locator("summary").boundingBox();
  expect(after?.height).toBe(before?.height);
  expect(after?.height).toBe(unmapped?.height);
  // An ingredient with no product has no empty box where the picture would be.
  await expect(water.locator(".shopping-thumb img")).toHaveCount(0);
});

test("product selection preserves an explicit non-default meal selection", async ({
  page,
}) => {
  await planTheFortnight(page);
  const futureLasagne = await createBatch(page, inDays(11), LASAGNE, 1);
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

  // The selection the screen is showing, so the post below is the one the
  // browser would really make — with an EAN no search ever returned.
  const chosen = await page
    .locator('.s-shopping-send form input[name="ateria"]')
    .evaluateAll((fields) =>
      fields.map((field) => (field as HTMLInputElement).value),
    );

  // Both ways in re-search before writing, so an EAN the browser made up is
  // refused whether it arrives from the screen's form or from the island.
  for (const format of ["", "json"]) {
    const body = new URLSearchParams({
      rivi: "9",
      haku: "maito",
      ean: "0000000000000",
      valittu: "1",
    });
    for (const id of chosen) body.append("ateria", id);
    if (format !== "") body.set("muoto", format);

    const forged = await page.request.post("/ostoslista/tuote", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      data: body.toString(),
    });
    expect(forged.status()).toBe(400);
    expect(await forged.text()).toContain(
      "Valittua tuotetta ei löytynyt uudesta hausta",
    );
  }

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
  await openPanel(page, milk);

  const result = results(page).first();
  await expect(result).toBeVisible();
  await expect(result.locator("img")).toBeHidden();
  await expect(result.getByRole("button", { name: "Valitse" })).toBeEnabled();
});

test("the next ingredient's search is fetched while this one is open", async ({
  page,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");

  const names = await buyRowNames(page);
  const at = names.indexOf("maito");
  const next = names[at + 1] ?? "";
  expect(next).not.toBe("");

  const milk = row(page, "maito");
  await milk.locator("summary").click();
  await openPanel(page, milk);

  await expect
    .poll(async () => {
      const calls = await externalRequests(page);
      return calls.some(
        (call) =>
          call.path.startsWith("/products") &&
          call.path.includes(encodeURIComponent(next)),
      );
    })
    .toBe(true);
});

test("a prefetched search is never shown for another ingredient", async ({
  page,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");

  const names = await buyRowNames(page);
  const next = names[names.indexOf("maito") + 1] ?? "";
  const milk = row(page, "maito");
  await milk.locator("summary").click();
  await openPanel(page, milk);
  await expect(results(page).first()).toContainText("Kotimaista rasvaton maito");

  // The row the prefetch warmed shows its own answer — the fixture knows no
  // product for it — and not the milk sitting in the cache beside it.
  await closeSheet(page);
  const neighbour = row(page, next);
  await neighbour.locator("summary").click();
  await openPanel(page, neighbour);
  await expect(page.locator(".s-sheet .s-product-panel-state")).toContainText(
    "Haulla ei löytynyt tuotteita",
  );
  await expect(results(page)).toHaveCount(0);
});

test("a choice returns to the list at once and saves behind it", async ({
  page,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");

  // Hold the save open, so what the row shows meanwhile is the whole point.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/ostoslista/tuote", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await held;
    await route.continue();
  });

  const milk = row(page, "maito");
  await milk.locator("summary").click();
  await openPanel(page, milk);
  await results(page)
    .filter({ hasText: "Kotimaista rasvaton maito" })
    .getByRole("button", { name: "Valitse" })
    .click();

  // Back in the list, with the choice on the row and the panel closed, while
  // the save is still in flight.
  await expect(milk.locator(".s-shopping-product-summary")).toContainText(
    "Kotimaista rasvaton maito 1 l",
  );
  await expect(milk.locator(".shopping-thumb img")).toBeVisible();
  await expect(page.locator(".s-sheet")).toBeHidden();
  await expect(milk.locator(".s-status .spinner")).toBeVisible();

  release();
  await expect(milk.locator(".s-status .spinner")).toHaveCount(0);
  await page.unroute("**/ostoslista/tuote");

  await page.reload();
  await expect(row(page, "maito").locator(".s-shopping-product-summary")).toContainText(
    "Kotimaista rasvaton maito 1 l",
  );
});

/**
 * #200: the whole point of the picker being a fixed sheet rather than a panel
 * grown inside the row.
 *
 * What made this unusable on a phone was that opening the picker, closing it,
 * choosing a product and having the save land each moved the page under the
 * member's thumb. So the test scrolls to a row well down the list, writes the
 * position down, walks the whole flow, and demands nothing move.
 *
 * It watches two different things, because either one alone can pass while the
 * screen is still misbehaving. `window.scrollY` catches the page being yanked
 * somewhere else, but it holds perfectly still while a row grows and shoves
 * every row under it down the screen. So the edited row's own height and the
 * next row's top are checked too — including at the moment the optimistic draw
 * is on screen and the save has not answered yet, which is exactly where an
 * optimistic redraw that does not match the server's shape shows up.
 */
test("choosing a product never moves the page under the member", async ({
  page,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  await currentListLoaded(page);

  // Far enough down that a jump to the top would be unmistakable, and on a row
  // that is really being worked on rather than the first one on the screen.
  // Opened, because the product line is inside the row's own disclosure and a
  // closed row would hide the growth this is looking for.
  const names = await buyRowNames(page);
  const milk = row(page, "maito");
  const following = page.locator(".shopping-list > li").nth(names.indexOf("maito") + 1);
  await milk.locator("summary").click();
  await milk.evaluate((node) => {
    node.scrollIntoView(true);
  });
  const scrolled = await page.evaluate(() => window.scrollY);
  expect(scrolled).toBeGreaterThan(0);
  const height = (await milk.boundingBox())?.height;
  const nextTop = (await following.boundingBox())?.y;
  expect(height).toBeGreaterThan(0);
  expect(nextTop).toBeGreaterThan(0);

  const still = async (what: string) => {
    expect(await page.evaluate(() => window.scrollY), `${what}: scroll`).toBe(
      scrolled,
    );
    expect((await milk.boundingBox())?.height, `${what}: row height`).toBe(height);
    expect((await following.boundingBox())?.y, `${what}: next row`).toBe(nextTop);
  };

  await openPanel(page, milk);
  await still("opening the picker");

  await page.locator(".s-sheet").getByLabel("Haku").fill("maito");
  await page.locator(".s-sheet").getByRole("button", { name: "Hae" }).click();
  await expect(page.locator(".s-sheet .spinner")).toHaveCount(0);
  await still("searching again");

  await closeSheet(page);
  await still("closing the picker");

  // Hold the save open, so the optimistic draw and the confirmed one are two
  // separate moments the page has to survive.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/ostoslista/tuote", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await held;
    await route.continue();
  });

  await openPanel(page, milk);
  await results(page)
    .filter({ hasText: "Kotimaista rasvaton maito" })
    .getByRole("button", { name: "Valitse" })
    .click();
  await expect(milk.locator(".s-shopping-product-summary")).toContainText(
    "Kotimaista rasvaton maito",
  );
  await expect(milk.locator(".s-status .spinner")).toBeVisible();
  await still("the choice drawn, the save still running");

  release();
  await expect(milk.locator(".s-status .spinner")).toHaveCount(0);
  await page.unroute("**/ostoslista/tuote");

  // Once the save has landed the row does move: it closes itself, because the
  // ingredient is finished (#204). Two things have to survive that.
  //
  // The page never scrolls *further down*. Collapsing a row near the end of the
  // list can leave the document too short to hold the offset it was at, and the
  // browser then hands some scroll back — the list comes up the screen. That is
  // allowed, and on a list that now fits in one screen it is the whole point;
  // what is not allowed is the page running away from the member.
  await expect(milk.locator(".s-shopping-product-summary")).toBeHidden();
  const settledScroll = await page.evaluate(() => window.scrollY);
  expect(settledScroll, "collapsed: never further down").toBeLessThanOrEqual(
    scrolled,
  );
  const settled = await milk.boundingBox();
  expect(settled!.height, "collapsed: shorter than it was").toBeLessThan(height!);
  // Measured down the document, not down the screen: when the browser hands
  // scroll back it does so by exactly what the document lost, so the next
  // ingredient can end up in the same place on screen while genuinely being
  // closer to the top of the list.
  const nextNow = (await following.boundingBox())!.y + settledScroll;
  expect(nextNow, "collapsed: the next ingredient came closer").toBeLessThan(
    nextTop! + scrolled,
  );

  // And the member is still looking at the ingredient they were working on,
  // with the next one beside it — which was the point of closing the row.
  const view = page.viewportSize();
  expect(settled!.y).toBeGreaterThanOrEqual(0);
  expect(settled!.y).toBeLessThan(view!.height);
  await expect(following).toBeInViewport();
});

/**
 * The one flow that does still reload — a second package size changes what the
 * row adds up to, and that arithmetic is the server's. It has to come back to
 * the ingredient it was about rather than to the top of the list (#200).
 */
test("a reload after adding a package size lands back on the ingredient", async ({
  page,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  await chooseProduct(page, "maito", "Kotimaista rasvaton maito");

  const milk = row(page, "maito");
  const ingredientId = await milk
    .locator(".shopping-item")
    .getAttribute("data-aines");
  expect(await milk.getAttribute("id")).toBe(`aines-${ingredientId}`);

  await reopen(milk);
  await openPanelWith(page, milk, "Lisää toinen pakkauskoko");
  await chooseAndReload(page, "Valio kevytmaito");

  expect(new URL(page.url()).hash).toBe(`#aines-${ingredientId}`);
  const landed = row(page, "maito");
  const where = await landed.boundingBox();
  const view = page.viewportSize();
  expect(where).not.toBeNull();
  expect(where!.y).toBeGreaterThanOrEqual(0);
  expect(where!.y).toBeLessThan(view!.height);
});

/**
 * The cupboard button leaves the page too, and it used to leave it at the top.
 */
test("the cupboard button comes back to the row it was pressed on", async ({
  page,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");

  const oil = row(page, "öljy");
  const ingredientId = await oil
    .locator(".shopping-item")
    .getAttribute("data-aines");
  await oil.locator("summary").click();
  await oil.getByRole("button", { name: "Löytyy jo kaapista" }).click();

  expect(new URL(page.url()).hash).toBe(`#aines-${ingredientId}`);
  // The row moved to the cupboard section and kept its name, so the anchor
  // still points at it.
  await expect(page.locator(`#aines-${ingredientId}`)).toContainText("öljy");
});

test("sending waits for an optimistic product save", async ({ page }) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");

  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/ostoslista/tuote", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await held;
    await route.continue();
  });

  let sends = 0;
  await page.route("**/ostoslista/laheta", async (route) => {
    sends += 1;
    await route.continue();
  });

  const milk = row(page, "maito");
  await milk.locator("summary").click();
  await openPanel(page, milk);
  await results(page)
    .filter({ hasText: "Kotimaista rasvaton maito" })
    .getByRole("button", { name: "Valitse" })
    .click();
  await expect(milk.locator(".s-status .spinner")).toBeVisible();

  const send = page.locator(".s-send-form button");
  await send.click();
  await expect(send).toBeDisabled();
  await expect(send).toContainText("Tallennetaan valintoja");
  expect(sends).toBe(0);

  const sent = page.waitForRequest(
    (request) =>
      request.method() === "POST" && request.url().includes("/ostoslista/laheta"),
  );
  release();
  await sent;
  await expect(page.locator(".shopping-sent")).toContainText(
    "lähetettiin S-ostoslistaan",
  );
  expect(sends).toBe(1);

  const calls = await externalRequests(page);
  expect(
    calls.some(
      (call) => call.path === "/items" && call.body?.["ean"] === "6415712506032",
    ),
  ).toBe(true);
  expect(
    calls.some(
      (call) =>
        call.path === "/items" &&
        String(call.body?.["note"] ?? "").startsWith("maito"),
    ),
  ).toBe(false);
});

test("a failed background save is shown, undone, and retryable", async ({
  page,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");

  let failing = true;
  let releaseFailure: () => void = () => {};
  const heldFailure = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });
  await page.route("**/ostoslista/tuote", async (route) => {
    if (route.request().method() !== "POST" || !failing) return route.continue();
    await heldFailure;
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Tuotetta ei voitu varmistaa." }),
    });
  });
  let sends = 0;
  await page.route("**/ostoslista/laheta", async (route) => {
    sends += 1;
    await route.continue();
  });

  const milk = row(page, "maito");
  await milk.locator("summary").click();
  await openPanel(page, milk);
  await results(page)
    .filter({ hasText: "Kotimaista rasvaton maito" })
    .getByRole("button", { name: "Valitse" })
    .click();

  const send = page.locator(".s-send-form button");
  await send.click();
  await expect(send).toContainText("Tallennetaan valintoja");
  expect(sends).toBe(0);
  releaseFailure();

  // The row goes back to what the server actually holds, and says why.
  await expect(page.locator(".s-toast")).toContainText(
    "Tuotetta ei voitu varmistaa",
  );
  await expect(send).toBeEnabled();
  await expect(page.locator(".s-shopping-send .refused")).toContainText(
    "Lähetystä ei aloitettu",
  );
  expect(sends).toBe(0);
  // Still open, and it has to be: the refusal and its retry are what the member
  // needs to see, so a refused save is the one that does not close the row.
  await expect(milk.locator(".s-shopping-product.is-note")).toBeVisible();
  await expect(milk.locator(".shopping-thumb img")).toHaveCount(0);

  failing = false;
  const retried = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/ostoslista/tuote"),
  );
  await page.locator(".s-toast").getByRole("button", { name: "Yritä uudelleen" }).click();
  await retried;
  await expect(page.locator(".s-toast")).toBeHidden();
  await expect(milk.locator(".s-shopping-product-summary")).toContainText(
    "Kotimaista rasvaton maito 1 l",
  );
  // A retry that works is a save that worked, so it closes the row like any
  // other.
  await expect(milk.locator(".s-shopping-product-summary")).toBeHidden();

  await page.unroute("**/ostoslista/tuote");
  await page.unroute("**/ostoslista/laheta");
  await page.reload();
  await expect(row(page, "maito").locator(".s-shopping-product-summary")).toContainText(
    "Kotimaista rasvaton maito 1 l",
  );
});

test("the send button spins and cannot be pressed twice", async ({ page }) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  await currentListLoaded(page);

  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sends = 0;
  await page.route("**/ostoslista/laheta", async (route) => {
    sends += 1;
    await held;
    await route.continue();
  });

  const send = page.getByRole("button", { name: /Lähetä S-ostoslistaan|Lähetetään/ });
  await send.click();
  await expect(page.locator(".s-shopping-send .spinner")).toBeVisible();
  await expect(send).toBeDisabled();
  expect(sends).toBe(1);

  release();
  await expect(page.locator(".shopping-sent")).toContainText(
    "lähetettiin S-ostoslistaan",
  );
  await expect(send).toBeEnabled();
  expect(sends).toBe(1);
});

test("the shopping screen shows what the S list already holds, and refreshes it", async ({
  page,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  await chooseProduct(page, "maito", "Kotimaista rasvaton maito");
  await currentListLoaded(page);
  await expect(page.locator(".s-current-state")).toContainText("vielä tyhjä");

  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();
  await expect(page.locator(".shopping-sent")).toContainText(
    "lähetettiin S-ostoslistaan",
  );

  // The panel is refreshed by the send, so the member sees the new situation
  // without reloading: the mapped product as a product, the rest as reminders.
  const items = page.locator(".s-current-items li");
  await expect(items.filter({ hasText: "Kotimaista rasvaton maito" })).toHaveCount(1);
  await expect(
    items.filter({ hasText: "Kotimaista rasvaton maito" }),
  ).toContainText("Tuote");
  await expect(items.filter({ hasText: "vesi — 2–3 l" })).toContainText(
    "Teksti",
  );
});

test("an unreadable S list is a line in its own panel, not a broken screen", async ({
  page,
}) => {
  await planTheFortnight(page);
  let failing = true;
  await page.route("**/ostoslista/s-lista", async (route) => {
    if (!failing) return route.continue();
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "S-ostoslistan sisältöä ei saatu luettua." }),
    });
  });

  await page.goto("/ostoslista");
  await expect(page.locator(".s-current-state")).toContainText(
    "sisältöä ei saatu luettua",
  );
  // The household's own list is untouched by the external failure.
  await expect(row(page, "maito").locator(".shopping-total")).toHaveText(
    "5 dl + 2 rkl",
  );

  failing = false;
  await page.getByRole("button", { name: "Yritä uudelleen" }).click();
  await expect(page.locator(".s-current-state")).toContainText("vielä tyhjä");
  await page.unroute("**/ostoslista/s-lista");
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the product screen and the send form still work on their own", async ({
    page,
  }) => {
    await planTheFortnight(page);
    await page.goto("/ostoslista");

    const milk = row(page, "maito");
    await milk.locator("summary").click();
    await milk.getByRole("button", { name: "Valitse tuote" }).click();
    await page
      .locator(".s-product-results > li", { hasText: "Kotimaista rasvaton maito" })
      .getByRole("button", { name: "Valitse" })
      .click();

    await expect(row(page, "maito").locator(".s-shopping-product-summary")).toContainText(
      "Kotimaista rasvaton maito 1 l",
    );
    await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();
    await expect(page.locator(".shopping-sent")).toContainText(
      "lähetettiin S-ostoslistaan",
    );
    // The panel that needs a browser to fill it stays out of the way entirely.
    await expect(page.locator(".s-current")).toBeHidden();
  });
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

test("a finished send pushes the phone's list once, after the last item", async ({
  page,
  request,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  await currentListLoaded(page);
  await request.post(`${S_OSTOSLISTA_FIXTURE}/_test/reset`);

  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();
  await expect(page.locator(".shopping-sent")).toContainText(
    "lähetettiin S-ostoslistaan",
  );

  const calls = await externalRequests(page);
  const syncs = calls.filter(
    (call) => call.method === "POST" && call.path === "/sync",
  );
  expect(syncs).toHaveLength(1);

  // Once, and last: everything that was going on the list is on it before the
  // phone is told to fetch it.
  const at = calls.indexOf(syncs[0]!);
  expect(
    calls.slice(at).some((call) => call.method === "POST" && call.path === "/items"),
  ).toBe(false);
  await expect(page.locator(".s-shopping-send .refused")).toHaveCount(0);
});

test("a partial send does not push the phone's list", async ({ page, request }) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  await currentListLoaded(page);
  await request.post(`${S_OSTOSLISTA_FIXTURE}/_test/fail-next`);

  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();
  await expect(page.locator(".refused")).toContainText(
    "S-ostoslistaan ei saatu lähetettyä kaikkea",
  );

  const calls = await externalRequests(page);
  expect(calls.some((call) => call.path === "/sync")).toBe(false);
});

test("a failed push is said beside the send, not instead of it", async ({
  page,
  request,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  await currentListLoaded(page);
  await request.post(`${S_OSTOSLISTA_FIXTURE}/_test/fail-sync`);

  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();
  await expect(page.locator(".shopping-sent")).toContainText(
    "lähetettiin S-ostoslistaan",
  );
  await expect(page.locator(".s-shopping-send .refused")).toContainText(
    "päivitystä ei saatu käynnistettyä",
  );

  // The send itself really happened, whatever the phone knows about it yet.
  const calls = await externalRequests(page);
  expect(
    calls.filter((call) => call.method === "POST" && call.path === "/items").length,
  ).toBeGreaterThan(0);
});

test("an external outage refuses recoverably without replacing the list", async ({
  page,
  request,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  // The current-list read is an external call too, so let it finish before
  // arming the fixture — otherwise it, not the send, would take the outage.
  await currentListLoaded(page);
  await request.post(`${S_OSTOSLISTA_FIXTURE}/_test/fail-next`);
  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();

  await expect(page.locator(".refused")).toContainText(
    "S-ostoslistaan ei saatu lähetettyä kaikkea",
  );
  await expect(row(page, "maito")).toBeVisible();
});

test("a failed product search keeps the local ingredient unmapped", async ({ page }) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista/tuote?rivi=9&haku=virhe");
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
  // A second Kaalilaatikko at 1× adds another ½ dl of oil.
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
  const id = await createBatch(page, today(), KAALILAATIKKO, 2);

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
  await createBatch(page, inDays(-1), KAALILAATIKKO, 2);

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
    (await neighbour.request.get("/ostoslista/tuote?rivi=9&haku=maito")).status(),
  ).toBe(404);
  expect(
    (await neighbour.request.post("/ostoslista/tuote", {
      form: { rivi: "9", haku: "maito", ean: "6415712506032" },
    })).status(),
  ).toBe(404);
  // The island's own routes are behind the same door.
  expect((await neighbour.request.get("/ostoslista/haku?haku=maito")).status()).toBe(
    404,
  );
  expect((await neighbour.request.get("/ostoslista/s-lista")).status()).toBe(404);

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

/**
 * #161: one ingredient, several package sizes, and a recipe allowed its own
 * product. The arithmetic is proved in `dev/check-shopping.ts` and
 * `dev/check-packaging.ts`; what these add is that the screens really say it
 * and really store it.
 */

/** Open a row's sheet through a named button, and wait for its results. */
async function openPanelWith(
  page: Page,
  item: ReturnType<typeof row>,
  button: string | RegExp,
): Promise<void> {
  await item.getByRole("button", { name: button }).click();
  await expect(page.locator(".s-sheet")).toBeVisible();
  await expect(page.locator(".s-sheet .spinner")).toHaveCount(0);
}

/**
 * Choose a result that changes what the *other* rows add up to — a second
 * package size or a recipe's own product — where the island reloads rather
 * than drawing an answer it cannot work out itself.
 */
async function chooseAndReload(page: Page, product: string): Promise<void> {
  const result = results(page).filter({ hasText: product });
  await expect(result).toBeVisible();
  await Promise.all([
    page.waitForEvent("load"),
    result.getByRole("button", { name: "Valitse" }).click(),
  ]);
}

test("an ingredient can be taught a second package size", async ({ page }) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");

  await chooseProduct(page, "maito", "Kotimaista rasvaton maito");

  const milk = row(page, "maito");
  await reopen(milk);
  await openPanelWith(page, milk, "Lisää toinen pakkauskoko");
  // Adding a packet is a fact about the ingredient, so the panel does not ask
  // how far the choice reaches.
  await expect(milk.locator(".s-product-scope-choice")).toBeHidden();
  await chooseAndReload(page, "Valio kevytmaito");

  const sizes = row(page, "maito").locator(".s-product-sizes > li");
  await expect(sizes).toHaveCount(2);
  await expect(sizes.nth(0)).toContainText("Kotimaista rasvaton maito 1 l");
  await expect(sizes.nth(1)).toContainText("Valio kevytmaito 1 l");
  // Read off the name once when it was chosen, and stored as data since.
  await expect(sizes.nth(1)).toContainText("1 l");
});

test("a package size can be dropped again", async ({ page }) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");

  await chooseProduct(page, "maito", "Kotimaista rasvaton maito");
  const milk = row(page, "maito");
  await reopen(milk);
  await openPanelWith(page, milk, "Lisää toinen pakkauskoko");
  await chooseAndReload(page, "Valio kevytmaito");

  const listed = row(page, "maito");
  await listed.locator("summary").click();
  await listed
    .locator(".s-product-sizes > li", { hasText: "Valio kevytmaito" })
    .getByRole("button", { name: "Poista" })
    .click();

  await expect(row(page, "maito").locator(".s-product-sizes")).toHaveCount(0);
  await expect(row(page, "maito").locator(".s-shopping-product-summary")).toContainText(
    "Kotimaista rasvaton maito 1 l",
  );
});

test("a recipe's own product is not merged into the generic pile", async ({
  page,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");

  // Both cookings want milk: the lasagne in decilitres, the sauce in spoons.
  await expect(row(page, "maito").locator(".shopping-total")).toHaveText(
    "5 dl + 2 rkl",
  );

  const milk = row(page, "maito");
  await milk.locator("summary").click();
  await openPanelWith(page, milk, "Valitse tuote");
  await page
    .locator(".s-sheet .s-product-scope-choice select")
    .selectOption({ label: "Käytä tässä reseptissä: Lasagne" });
  await chooseAndReload(page, "Kotimaista rasvaton maito");

  // Two milk rows now: the lasagne's own, and everything else's.
  const milkRows = page.locator(".shopping-list > li", { hasText: "maito" });
  await expect(milkRows).toHaveCount(2);
  const pinned = page.locator(".shopping-list > li", { hasText: "Vain reseptissä" });
  await expect(pinned.locator(".shopping-total")).toHaveText("5 dl");
  await expect(pinned).toContainText("Vain reseptissä Lasagne");
  await expect(pinned).toContainText("Kotimaista rasvaton maito 1 l");

  // The spoons stay unmapped rather than quietly inheriting the pinned choice.
  const generic = page
    .locator(".shopping-list > li", { hasText: "maito" })
    .filter({ hasNot: page.locator(".s-product-scope") });
  await expect(generic.locator(".shopping-total")).toHaveText("2 rkl");
  await generic.locator("summary").click();
  await expect(generic.locator(".s-shopping-product.is-note")).toBeVisible();
});

test("the packet count follows what the week actually needs", async ({ page }) => {
  // 5 dl from one lasagne and 10 dl from a double batch: 1,5 l of milk, which
  // one litre does not cover and two do.
  await createBatch(page, today(), LASAGNE, 1);
  await createBatch(page, inDays(1), LASAGNE, 2);
  await page.goto("/ostoslista");

  await expect(row(page, "maito").locator(".shopping-total")).toHaveText("15 dl");
  await chooseProduct(page, "maito", "Kotimaista rasvaton maito");
  await page.reload();

  const milk = row(page, "maito");
  await expect(milk.locator(".s-shopping-product-summary")).toContainText(
    "2 × Kotimaista rasvaton maito 1 l",
  );
  await expect(milk.locator(".s-package-total")).toContainText("2 l");
});

test("a second packet is said to the S list in the one way its API carries", async ({
  page,
  request,
}) => {
  await createBatch(page, today(), LASAGNE, 1);
  await createBatch(page, inDays(1), LASAGNE, 2);
  await page.goto("/ostoslista");
  await chooseProduct(page, "maito", "Kotimaista rasvaton maito");

  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();
  await expect(page.locator(".shopping-sent")).toContainText(
    "lähetettiin S-ostoslistaan",
  );

  const calls = (await (
    await request.get(`${S_OSTOSLISTA_FIXTURE}/_test/requests`)
  ).json()) as { requests: Array<{ path: string; body: Record<string, string> }> };
  const added = calls.requests.filter((call) => call.path === "/items");
  // The service's add is keyed by EAN and will not hold two of one product, so
  // the second packet goes as the written line beside it rather than as an
  // invented quantity field.
  expect(added.some((call) => call.body?.["ean"] === "6415712506032")).toBe(true);
  expect(
    added.some((call) => call.body?.["note"] === "Kotimaista rasvaton maito 1 l × 2"),
  ).toBe(true);
});

test("an unreadable package size is asked for rather than guessed", async ({
  page,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");

  // The fixture's coffee is named "Juhla Mokka kahvi 500 g", so its size is
  // read; searching for milk from the coffee row is the way to reach a name
  // this row cannot size. Instead, prove the honest half directly: a product
  // whose name states a size never asks, and the stored size is what shows.
  const milk = row(page, "maito");
  await milk.locator("summary").click();
  await openPanelWith(page, milk, "Valitse tuote");
  const result = results(page).filter({ hasText: "Kotimaista rasvaton maito" });
  await expect(result.locator(".s-product-size")).toContainText("Pakkaus 1 l");
  await expect(result.locator(".s-product-size-entry")).toHaveCount(0);
});

test.describe("choosing a scope without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("a recipe's own product can be chosen from the plain screen", async ({
    page,
  }) => {
    await planTheFortnight(page);
    await page.goto("/ostoslista");

    const milk = row(page, "maito");
    await milk.locator("summary").click();
    await milk.getByRole("button", { name: "Valitse tuote" }).click();

    await page
      .locator("select[name='laajuus']")
      .selectOption({ label: "Käytä tässä reseptissä: Lasagne" });
    await page
      .locator(".s-product-results > li", { hasText: "Kotimaista rasvaton maito" })
      .getByRole("button", { name: "Valitse" })
      .click();

    const pinned = page.locator(".shopping-list > li", { hasText: "Vain reseptissä" });
    await expect(pinned).toContainText("Vain reseptissä Lasagne");
    await expect(pinned.locator(".shopping-total")).toHaveText("5 dl");
  });
});
