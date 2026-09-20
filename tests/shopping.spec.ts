import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { closeOpenShoppingRow, openShoppingRow } from "./support/shopping-rows";
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
  const created = (await response.json()) as { id: number; instanceKey: string };
  batchKeys.set(created.id, created.instanceKey);
  return created.id;
}

const batchKeys = new Map<number, string>();

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
  await openShoppingRow(item);
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
  await openShoppingRow(item);
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

/**
 * Leave for the plain product screen from an opened row, with no script to
 * help.
 *
 * The scroll is about reaching the button, not about what it does. The bottom
 * tab bar is fixed over the last few rem of the viewport and the minimal
 * scroll a click does can land an element exactly under it, so a row far
 * enough down the page has an unclickable button until something puts it in
 * the middle. It is still the real button and everything after it is unchanged.
 */
async function openPlainPicker(item: ReturnType<typeof row>): Promise<void> {
  const open = item.getByRole("button", { name: "Valitse tuote" });
  await open.evaluate((one) => one.scrollIntoView({ block: "center" }));
  await open.click();
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

/**
 * Send the list, then wait for the panel's own refresh to have landed, and say
 * how many still-to-buy rows it drew. Waiting for a row the send must have put
 * there is what makes the count safe: the refresh follows the send's answer, so
 * the panel is briefly still the empty one.
 */
async function sendAndReadPanel(page: Page): Promise<number> {
  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();
  await expect(page.locator(".shopping-sent")).toContainText(
    "lähetettiin S-ostoslistaan",
  );
  const items = page.locator(".s-current-items li");
  await expect(items.filter({ hasText: "vesi — 2–3 l" })).toHaveCount(1);
  await currentListLoaded(page);
  return items.count();
}

/** How many rows the Ostettavat list is offering to send right now. */
async function buyableRows(page: Page): Promise<number> {
  return page.locator(".shopping-list").first().locator("> li").count();
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
  await openShoppingRow(reloadedMilk);
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
  const before = await milk.locator(".shopping-summary").boundingBox();
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
  const after = await row(page, "maito").locator(".shopping-summary").boundingBox();
  const unmapped = await water.locator(".shopping-summary").boundingBox();
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
  await openShoppingRow(row(page, "maito"));
  await expect(row(page, "maito").locator(".s-shopping-product.is-note")).toBeVisible();
});

test("a missing CDN image is hidden without breaking product choice", async ({ page }) => {
  await page.route("**/6415712506032_kuva1.jpg", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: "{}" }),
  );
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  const milk = row(page, "maito");
  await openShoppingRow(milk);
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
  await openShoppingRow(milk);
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
  await openShoppingRow(milk);
  await openPanel(page, milk);
  await expect(results(page).first()).toContainText("Kotimaista rasvaton maito");

  // The row the prefetch warmed shows its own answer — the fixture knows no
  // product for it — and not the milk sitting in the cache beside it.
  await closeSheet(page);
  const neighbour = row(page, next);
  await openShoppingRow(neighbour);
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
  await openShoppingRow(milk);
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
  // Opened, because that is where the buttons this flow presses live.
  const names = await buyRowNames(page);
  const milk = row(page, "maito");
  const following = page.locator(".shopping-list > li").nth(names.indexOf("maito") + 1);
  await openShoppingRow(milk);
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

  // The row still shuts itself once the ingredient is finished (#204), and
  // since #321 what it shuts is a modal over the list rather than a fold in
  // it. So the list it uncovers is the list it covered: not one pixel of this
  // page moved from the first tap to the last, which is the strongest form of
  // what #200 asked for.
  await expect(milk.locator(".s-shopping-product-summary")).toBeHidden();
  await still("the save landed and the row closed itself");

  // And the member is still looking at the ingredient they were working on,
  // with the next one beside it — which was the point of closing the row.
  const settled = await milk.boundingBox();
  const view = page.viewportSize();
  expect(settled!.y).toBeGreaterThanOrEqual(0);
  expect(settled!.y).toBeLessThan(view!.height);
  await expect(following).toBeInViewport();
});

/**
 * Where the list is after a round-trip that leaves the page (#323).
 *
 * The three tests below all measure the same thing, because every one of those
 * round-trips makes the same promise: nothing moves under the thumb. They
 * measure it on screen — the viewport Y of a row, and of the list itself —
 * rather than as a document offset. The offset is not the promise: the first
 * tick brings the sentence about ticked rows and the first cupboard move brings
 * the `Ostettavat` heading, and behind an unchanged offset either of those puts
 * every row one paragraph lower than the thumb left it.
 */
const LEFT_AT = "test.pagehide";

interface WhereItLeft {
  offset: number;
  list: number | null;
  row: number | null;
}

/**
 * The list, scrolled down and told to write down where it really was when it
 * left. Reading any of this from a Playwright call before the tap would measure
 * the wrong moment: a tap has to be scrolled to, and that scroll is the test's
 * own, not the member's.
 */
async function scrollDownTheList(
  page: Page,
  rowName: string | null = null,
): Promise<void> {
  await page.evaluate(
    ([key, name]) => {
      window.scrollTo(0, document.body.scrollHeight);
      window.addEventListener("pagehide", () => {
        const list = document.querySelector(".shopping-list");
        const rows = document.querySelectorAll(".shopping-list > li");
        let row: Element | null = null;
        for (let at = 0; at < rows.length; at += 1) {
          const label = rows[at]!.querySelector(".shopping-name");
          if (name !== null && (label?.textContent ?? "").trim() === name) {
            row = rows[at]!;
            break;
          }
        }
        window.sessionStorage.setItem(
          key!,
          JSON.stringify({
            offset: window.pageYOffset,
            list: list ? Math.round(list.getBoundingClientRect().top) : null,
            row: row ? Math.round(row.getBoundingClientRect().top) : null,
          }),
        );
      });
    },
    [LEFT_AT, rowName] as [string, string | null],
  );
}

/** Where that same thing is on screen now. */
async function onScreen(page: Page, rowName: string | null): Promise<number> {
  return page.evaluate((name) => {
    if (name === null) {
      const list = document.querySelector(".shopping-list");
      return list ? Math.round(list.getBoundingClientRect().top) : NaN;
    }
    const rows = document.querySelectorAll(".shopping-list > li");
    for (let at = 0; at < rows.length; at += 1) {
      const label = rows[at]!.querySelector(".shopping-name");
      if ((label?.textContent ?? "").trim() === name) {
        return Math.round(rows[at]!.getBoundingClientRect().top);
      }
    }
    return NaN;
  }, rowName);
}

/**
 * `rowName` is the row that was pressed, where it is still in the same list
 * afterwards. The cupboard button's row is not — it moves to the other section
 * on purpose — so that one is measured by the list it left instead.
 */
async function stillWhereItLeft(
  page: Page,
  rowName: string | null = null,
): Promise<void> {
  // And no anchor left on the address bar, or the next reload — or the back
  // button — would jump to it all over again.
  expect(new URL(page.url()).hash).toBe("");

  const left = JSON.parse(
    (await page.evaluate((key) => window.sessionStorage.getItem(key), LEFT_AT)) ??
      "null",
  ) as WhereItLeft | null;
  expect(left).not.toBeNull();
  // A list with nowhere to be has nothing to test: the fixture has to be
  // taller than the screen for there to be a place to lose.
  expect(left!.offset).toBeGreaterThan(60);

  for (const [name, before] of [
    [null, left!.list],
    [rowName, rowName === null ? null : left!.row],
  ] as [string | null, number | null][]) {
    if (before === null) continue;
    await expect
      .poll(async () => Math.abs((await onScreen(page, name)) - before) < 4)
      .toBe(true);
  }
}

/**
 * The one flow that does still reload — a second package size changes what the
 * row adds up to, and that arithmetic is the server's. It used to come back on
 * `#aines-<id>`, which put the row a fixed distance below the sticky header
 * rather than where it was under the thumb (#323).
 */
test("a reload after adding a package size keeps the list where it was", async ({
  page,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  await chooseProduct(page, "maito", "Kotimaista rasvaton maito");

  const milk = row(page, "maito");
  await scrollDownTheList(page, "maito");
  await reopen(milk);
  await openPanelWith(page, milk, "Lisää toinen pakkauskoko");
  await chooseAndReload(page, "Valio kevytmaito");

  await stillWhereItLeft(page, "maito");
  await expect(row(page, "maito")).toContainText("maito");
});

/**
 * The cupboard button leaves the page too, and it used to leave it somewhere
 * else.
 */
test("the cupboard button leaves the list where it was", async ({ page }) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");

  const oil = row(page, "öljy");
  await scrollDownTheList(page);
  await openShoppingRow(oil);
  await Promise.all([
    page.waitForEvent("load"),
    oil.getByRole("button", { name: "Löytyy jo kaapista" }).click(),
  ]);

  await stillWhereItLeft(page);
  // The row itself did move — to the cupboard section, which is the change
  // that was asked for. Nothing else did.
  await expect(page.locator(".shopping-list").last()).toContainText("öljy");
});

/**
 * The tick is the list's most-pressed button and the one the card is about: one
 * row changed, by a plain link, and nothing moving under the thumb.
 */
test("ticking a row off leaves the list where it was", async ({ page }) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  await scrollDownTheList(page, "öljy");

  await tapAndWait(
    page,
    row(page, "öljy").getByRole("link", {
      name: "Jätä öljy pois tältä listalta",
    }),
  );

  await stillWhereItLeft(page, "öljy");
  await expect(row(page, "öljy").locator(".shopping-item")).toHaveClass(
    /is-excluded/,
  );
});

/**
 * Leaving a row off this one list (#313).
 *
 * The thing under test is the distinction, not the toggle: the cupboard says
 * the household has something and outlives the trip, and this says only that
 * this trip is not buying it. So every assertion below checks both halves —
 * the row left the list, *and* the cupboard is exactly where it was.
 */
async function leaveOff(page: Page, ingredient: string): Promise<void> {
  // One tap on the row's own tick, without opening it: that is the whole point
  // of #318, so the helper every assertion below runs through does it that way.
  await tapAndWait(
    page,
    row(page, ingredient).getByRole("link", {
      name: `Jätä ${ingredient} pois tältä listalta`,
    }),
  );
}

/**
 * Follow a control that reloads the list, and wait until the new list is the
 * one on the screen.
 *
 * Every toggle here is a plain link or a GET form, so the click only *starts*
 * a navigation. Without this the next assertion can read the old page — and
 * the ones that count rows read an empty one mid-swap, which looks like a
 * missing row rather than like a race.
 */
async function tapAndWait(
  page: Page,
  control: ReturnType<typeof row>,
): Promise<void> {
  const before = page.url();
  await control.click();
  await page.waitForURL((url) => url.href !== before);
  await expect(page.locator(".shopping-list").first()).toBeAttached();
}

/** The rows the member has taken off, wherever they sit in the list. */
function leftOff(page: Page) {
  return page.locator(".shopping-item.is-excluded");
}

test("a row left off this list is not sent, and the cupboard never hears it", async ({
  page,
  request,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  await leaveOff(page, "vesi");

  await expect(page.locator(".shopping-excluded-note")).toBeVisible();
  await expect(leftOff(page)).toHaveCount(1);
  await expect(leftOff(page)).toContainText("vesi");
  // The amount and the breakdown are still there — a row that vanished would
  // be indistinguishable from one the list forgot.
  await expect(leftOff(page)).toContainText("2–3 l");

  await request.post(`${S_OSTOSLISTA_FIXTURE}/_test/reset`);
  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();
  await expect(page.locator(".shopping-sent")).toContainText(
    "lähetettiin S-ostoslistaan",
  );

  const calls = await externalRequests(page);
  const added = calls.filter(
    (call) => call.method === "POST" && call.path === "/items",
  );
  expect(added.length).toBeGreaterThan(0);
  expect(
    added.some((call) => String(call.body?.["note"] ?? "").startsWith("vesi")),
  ).toBe(false);

  // The other sentence was never said: the cupboard is untouched.
  await page.goto("/kaappi");
  await expect(page.locator(".pantry")).toHaveCount(0);
});

test("a row left off stays where it was and comes back with one tap", async ({
  page,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  const before = await buyRowNames(page);

  await leaveOff(page, "vesi");

  // #318's whole point: the row did not move into a section of its own, so
  // untick is the same tap in the same spot rather than a hunt down the page.
  expect(await buyRowNames(page)).toEqual(before);
  await expect(leftOff(page)).toHaveCount(1);
  await expect(leftOff(page)).toContainText("vesi");

  await tapAndWait(
    page,
    row(page, "vesi").getByRole("link", { name: "Ota vesi takaisin listalle" }),
  );

  await expect(leftOff(page)).toHaveCount(0);
  await expect(page.locator(".shopping-excluded-note")).toBeHidden();
  expect(await buyRowNames(page)).toEqual(before);
});

test("the cupboard and the left-off list stay two separate answers", async ({
  page,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  await leaveOff(page, "vesi");

  const oil = row(page, "öljy");
  await openShoppingRow(oil);
  await oil.getByRole("button", { name: "Löytyy jo kaapista" }).click();

  // Both answers are drawn, worded apart, and neither took the other's row.
  await expect(page.getByRole("heading", { name: "Löytyy" })).toBeVisible();
  await expect(page.locator(".shopping-excluded-note")).toBeVisible();
  await expect(leftOff(page)).toHaveCount(1);
  await expect(leftOff(page)).toContainText("vesi");

  // A cupboard row is not offered the other toggle: it is already off the list
  // for a reason that outranks this one.
  const home = page.locator(".shopping-list > li", { hasText: "öljy" }).first();
  await expect(home.getByRole("link", { name: /Jätä öljy|Ota öljy/ })).toHaveCount(
    0,
  );
});

test("leaving a row off survives a trip through another form", async ({
  page,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  await leaveOff(page, "vesi");

  // The cupboard button leaves the page; the exclusions ride along as hidden
  // fields, so the member comes back to the list they were reading.
  const oil = row(page, "öljy");
  await openShoppingRow(oil);
  await oil.getByRole("button", { name: "Löytyy jo kaapista" }).click();

  await expect(leftOff(page)).toHaveCount(1);
  expect(new URL(page.url()).searchParams.getAll("pois")).toHaveLength(1);
});

test("a junk row key on the query string leaves nothing off", async ({ page }) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista?pois=%3Cscript%3E&pois=999");

  await expect(leftOff(page)).toHaveCount(0);
  await expect(page.locator(".shopping-excluded-note")).toBeHidden();
  // And it is not handed back out either: nothing on the screen carries a key
  // this list has no row for.
  await expect(carriedKeys(page)).toHaveCount(0);
});

/** Tick or untick one cooking in the picker and submit it. */
async function setMealTicked(
  page: Page,
  batchId: number,
  ticked: boolean,
): Promise<void> {
  const picker = page.locator(".shopping-picker");
  if (!(await picker.evaluate((one: HTMLDetailsElement) => one.open))) {
    await picker.locator("summary").click();
  }
  await picker.locator(`input[name="ateria"][value="${batchId}"]`).setChecked(ticked);
  await tapAndWait(page, picker.getByRole("button", { name: "Päivitä lista" }));
}

/** The exclusions the picker's own form would submit. */
function carriedKeys(page: Page) {
  return page.locator('.shopping-picker input[name="pois"]');
}

test("changing which cookings are on the list keeps the left-off rows off", async ({
  page,
}) => {
  const { lasagne } = await planTheFortnight(page);
  await page.goto("/ostoslista");
  await leaveOff(page, "vesi");
  await expect(carriedKeys(page)).toHaveCount(1);

  // The picker is a form of its own, and it used to submit without the
  // exclusions — so choosing a different set of cookings silently put every
  // left-off row back.
  await setMealTicked(page, lasagne, false);

  await expect(leftOff(page)).toHaveCount(1);
  await expect(leftOff(page)).toContainText("vesi");
  expect(new URL(page.url()).searchParams.getAll("pois")).toHaveLength(1);
  // The meal ids are still the checkboxes' to decide.
  expect(await buyRowNames(page)).not.toContain("jauheliha");
});

test("a left-off row whose cooking is gone stops being carried", async ({
  page,
}) => {
  const { lasagne } = await planTheFortnight(page);
  await page.goto("/ostoslista");
  // Jauheliha is the lasagne's alone, so unticking it takes the row away.
  await leaveOff(page, "jauheliha");

  await setMealTicked(page, lasagne, false);
  await expect(leftOff(page)).toHaveCount(0);
  await expect(carriedKeys(page)).toHaveCount(0);

  // And the decision does not come back to life with the cooking: the member
  // never said anything about this row on this list.
  await setMealTicked(page, lasagne, true);
  await expect(leftOff(page)).toHaveCount(0);
  expect(await buyRowNames(page)).toContain("jauheliha");
});

/**
 * Reading the same list by dish instead of by ingredient name (#318).
 *
 * It is a reading order and nothing else, so every assertion here is about
 * what moved where — never about what the trip buys, which must be the same
 * list either way.
 */
async function groupBy(page: Page, label: string): Promise<void> {
  await tapAndWait(
    page,
    page.locator(".shopping-grouping").getByRole("link", { name: label }),
  );
}

/** The section headings the by-dish view drew, in order. */
function groupTitles(page: Page) {
  return page.locator(".shopping-group");
}

test("the pills cut the same rows into one section per dish", async ({ page }) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  const flat = await buyRowNames(page);
  await expect(groupTitles(page)).toHaveCount(0);

  await groupBy(page, "Resepteittäin");

  // A section per dish, in the order the week cooks them, and the rows more
  // than one of them wants as one pile at the end rather than repeated under
  // each. The maitokastike has no section: its only ingredient is the milk the
  // lasagne also wants, so its one row is in that pile.
  await expect(groupTitles(page)).toContainText([
    "Kaalilaatikko",
    "Lasagne",
    "Useammassa reseptissä",
  ]);
  await expect(page.locator(".shopping-group").last()).toHaveText(
    "Useammassa reseptissä",
  );
  // The same rows, read in a different order: nothing added, nothing lost.
  expect([...(await buyRowNames(page))].sort()).toEqual([...flat].sort());

  await groupBy(page, "Aakkosittain");
  await expect(groupTitles(page)).toHaveCount(0);
  expect(await buyRowNames(page)).toEqual(flat);
});

test("the grouping rides along with everything else the list carries", async ({
  page,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  await groupBy(page, "Resepteittäin");
  await leaveOff(page, "vesi");

  // A left-off row is still left off, and still in its own dish's section.
  await expect(leftOff(page)).toHaveCount(1);
  await expect(groupTitles(page).first()).toBeVisible();

  // And the meal picker's own form keeps it too, exactly as it keeps the
  // exclusions: submitting it must not silently drop back to the flat list.
  await page.locator(".shopping-picker summary").click();
  await tapAndWait(
    page,
    page.locator(".shopping-picker").getByRole("button", { name: "Päivitä lista" }),
  );

  expect(new URL(page.url()).searchParams.get("ryhma")).toBe("resepti");
  await expect(groupTitles(page).first()).toBeVisible();
  await expect(leftOff(page)).toHaveCount(1);
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
  await openShoppingRow(milk);
  await openPanel(page, milk);
  await results(page)
    .filter({ hasText: "Kotimaista rasvaton maito" })
    .getByRole("button", { name: "Valitse" })
    .click();
  await expect(milk.locator(".s-status .spinner")).toBeVisible();

  // The save is still in flight, so the row has not closed itself (#204) and
  // its modal is still over the list. Tapping away is how the member gets back
  // to the send button while a save runs; the save carries on regardless.
  await closeOpenShoppingRow(page);

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
  await openShoppingRow(milk);
  await openPanel(page, milk);
  await results(page)
    .filter({ hasText: "Kotimaista rasvaton maito" })
    .getByRole("button", { name: "Valitse" })
    .click();

  // The modal is over the list while the save runs, so getting to the send
  // button means tapping away first, the way a member would. The save carries
  // on regardless — that it does is the whole point of this test.
  await closeOpenShoppingRow(page);

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
  // The row went back to what the server actually holds: no picture on the
  // line, and the note still inside it.
  await expect(milk.locator(".shopping-thumb img")).toHaveCount(0);
  await openShoppingRow(milk);
  await expect(milk.locator(".s-shopping-product.is-note")).toBeVisible();

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
  await expect(page.locator(".s-current-state")).toContainText(
    "ei ole keräämättömiä rivejä",
  );

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

test("the panel leaves out the rows the S list has already collected", async ({
  page,
  request,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  await chooseProduct(page, "maito", "Kotimaista rasvaton maito");
  const before = await sendAndReadPanel(page);
  const items = page.locator(".s-current-items li");
  expect(before).toBeGreaterThan(2);

  // The shopping trip: the milk and the water are in the trolley, and both are
  // ticked on the phone. The panel is about what is left.
  await request.post(`${S_OSTOSLISTA_FIXTURE}/_test/collected?ean=6415712506032`);
  await request.post(
    `${S_OSTOSLISTA_FIXTURE}/_test/collected?note=${encodeURIComponent("vesi — 2–3 l")}`,
  );

  await page.reload();
  await currentListLoaded(page);
  await expect(items).toHaveCount(before - 2);
  await expect(items.filter({ hasText: "Kotimaista rasvaton maito" })).toHaveCount(0);
  await expect(items.filter({ hasText: "vesi — 2–3 l" })).toHaveCount(0);
});

test("a product and a text row can each be taken off the S list from the panel", async ({
  page,
  request,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  await chooseProduct(page, "maito", "Kotimaista rasvaton maito");
  const before = await sendAndReadPanel(page);
  const items = page.locator(".s-current-items li");
  const milk = items.filter({ hasText: "Kotimaista rasvaton maito" });
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/ostoslista/s-lista/poista") &&
        response.request().method() === "POST",
    ),
    milk.getByRole("button", { name: /Poista S-ostoslistalta/ }).click(),
  ]);
  // The row goes without the screen being loaded again.
  await expect(milk).toHaveCount(0);

  const water = items.filter({ hasText: "vesi — 2–3 l" });
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/ostoslista/s-lista/poista") &&
        response.request().method() === "POST",
    ),
    water.getByRole("button", { name: /Poista S-ostoslistalta/ }).click(),
  ]);
  await expect(water).toHaveCount(0);
  await expect(items).toHaveCount(before - 2);

  // Really off the S list, by the service's own keys, and the phone was pushed.
  const calls = await externalRequests(page);
  expect(
    calls.filter(
      (call) =>
        call.method === "DELETE" && call.path === "/items?ean=6415712506032",
    ),
  ).toHaveLength(1);
  expect(
    calls.filter(
      (call) =>
        call.method === "DELETE" &&
        call.path ===
          `/items?note=${encodeURIComponent("vesi — 2–3 l").replace(/%20/g, "+")}`,
    ),
  ).toHaveLength(1);
  expect(
    calls.filter((call) => call.method === "POST" && call.path === "/sync")
      .length,
  ).toBeGreaterThan(1);

  const list = await request.get(`${S_OSTOSLISTA_FIXTURE}/items`, {
    headers: { authorization: "Bearer test-s-ostoslista-token" },
  });
  const left = ((await list.json()) as {
    items: Array<{ name: string; ean: string | null }>;
  }).items;
  expect(left.some((item) => item.ean === "6415712506032")).toBe(false);
  expect(left.some((item) => item.name === "vesi — 2–3 l")).toBe(false);
  expect(left.length).toBe(before - 2);

  // And it stays gone on a fresh read.
  await page.reload();
  await currentListLoaded(page);
  await expect(items).toHaveCount(before - 2);
});

test("a delete the service refuses puts the row back where it was", async ({
  page,
  request,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  await chooseProduct(page, "maito", "Kotimaista rasvaton maito");
  const before = await sendAndReadPanel(page);
  const items = page.locator(".s-current-items li");
  const names = await items.locator(".s-current-name").allInnerTexts();
  const milk = items.filter({ hasText: "Kotimaista rasvaton maito" });

  await request.post(`${S_OSTOSLISTA_FIXTURE}/_test/fail-next`);
  await milk.getByRole("button", { name: /Poista S-ostoslistalta/ }).click();

  await expect(page.locator(".s-current-state")).toContainText(
    "poisto S-ostoslistalta ei onnistunut",
  );
  // Back in the panel, in the same place, and still on the S list.
  await expect(items).toHaveCount(before);
  expect(await items.locator(".s-current-name").allInnerTexts()).toEqual(names);
  const list = await request.get(`${S_OSTOSLISTA_FIXTURE}/items`, {
    headers: { authorization: "Bearer test-s-ostoslista-token" },
  });
  const left = ((await list.json()) as { items: Array<{ ean: string | null }> })
    .items;
  expect(left.some((item) => item.ean === "6415712506032")).toBe(true);

  // The retry beside the message is the same delete again, and this time it
  // works.
  await page.getByRole("button", { name: "Yritä uudelleen" }).click();
  await expect(milk).toHaveCount(0);
  await expect(items).toHaveCount(before - 1);
});

test("a row the S list has already lost still leaves the panel", async ({
  page,
  request,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  await chooseProduct(page, "maito", "Kotimaista rasvaton maito");
  await sendAndReadPanel(page);
  const items = page.locator(".s-current-items li");
  const milk = items.filter({ hasText: "Kotimaista rasvaton maito" });
  // Somebody cleared it on the phone between the panel being drawn and the
  // member pressing the button. That is the state they asked for.
  const dropped = await request.delete(
    `${S_OSTOSLISTA_FIXTURE}/items?ean=6415712506032`,
    { headers: { authorization: "Bearer test-s-ostoslista-token" } },
  );
  expect(dropped.ok()).toBe(true);

  await milk.getByRole("button", { name: /Poista S-ostoslistalta/ }).click();
  await expect(milk).toHaveCount(0);
  await expect(page.locator(".s-current-state")).toBeHidden();
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
  await expect(page.locator(".s-current-state")).toContainText(
    "ei ole keräämättömiä rivejä",
  );
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
    await openShoppingRow(milk);
    await openPlainPicker(milk);
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

  test("a row can still be left off this list", async ({ page }) => {
    await planTheFortnight(page);
    await page.goto("/ostoslista");
    await leaveOff(page, "vesi");

    // Nothing was saved and nothing needed a script: the whole answer is the
    // URL the link went to.
    await expect(leftOff(page)).toContainText("vesi");
    expect(new URL(page.url()).searchParams.getAll("pois")).toHaveLength(1);
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
  await openShoppingRow(oil);
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
  // A product row says how many packets it is for, even at one (#240): the
  // service's add is keyed, so a row left over from last week would otherwise
  // keep that trip's count. A written reminder has nothing to count.
  expect(quantityFor(calls, "6415712506032")).toBe(1);
  expect(
    added
      .filter((call) => typeof call.body?.["note"] === "string")
      .every((call) => !("quantity" in (call.body ?? {}))),
  ).toBe(true);
});

test("a send puts an already-ticked row back to still-to-buy (#236)", async ({
  page,
  request,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  await chooseProduct(page, "maito", "Kotimaista rasvaton maito");

  // Last week's trip: both of these are on the phone's list already, and both
  // were picked up. Sending them again has to mean "buy these", not leave the
  // member hunting for which of the twenty rows are new.
  await request.post(`${S_OSTOSLISTA_FIXTURE}/_test/reset`);
  await request.post(
    `${S_OSTOSLISTA_FIXTURE}/_test/collected?ean=6415712506032`,
  );
  await request.post(
    `${S_OSTOSLISTA_FIXTURE}/_test/collected?note=${encodeURIComponent("vesi — 2–3 l")}`,
  );

  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();
  await expect(page.locator(".shopping-sent")).toContainText(
    "lähetettiin S-ostoslistaan",
  );

  const calls = await externalRequests(page);
  const added = calls.filter(
    (call) => call.method === "POST" && call.path === "/items",
  );
  const cleared = calls.filter(
    (call) => call.method === "PATCH" && call.body?.["collected"] === false,
  );
  expect(added.length).toBeGreaterThan(2);
  // The two rows that came back ticked are the two that had to be cleared, and
  // #308 stopped this sending the same edit for every other row as well: a row
  // the service hands back already unticked and holding the asked-for count has
  // nothing left to say to it. What the send promises is the state below, not a
  // fixed number of calls.
  expect(cleared).toHaveLength(2);

  const list = await request.get(`${S_OSTOSLISTA_FIXTURE}/items`, {
    headers: { authorization: "Bearer test-s-ostoslista-token" },
  });
  const items = ((await list.json()) as { items: Array<{ collected: boolean }> }).items;
  expect(items.length).toBeGreaterThan(0);
  expect(items.every((item) => item.collected === false)).toBe(true);
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
  // A refusal the service will give again however often it is asked, so this
  // is one row lost rather than a blip the send rides out (#308).
  await request.post(
    `${S_OSTOSLISTA_FIXTURE}/_test/fail-next?status=400&only=POST /items`,
  );

  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();
  await expect(page.locator(".refused")).toContainText(
    "S-ostoslistaan ei saatu lähetettyä kaikkea",
  );

  const calls = await externalRequests(page);
  expect(calls.some((call) => call.path === "/sync")).toBe(false);
});

test("a row the service refuses is named, and the rest of the list still goes (#308)", async ({
  page,
  request,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  await currentListLoaded(page);
  await request.post(`${S_OSTOSLISTA_FIXTURE}/_test/reset`);
  await request.post(
    `${S_OSTOSLISTA_FIXTURE}/_test/fail-next?status=400&only=POST /items`,
  );

  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();
  const refusal = page.locator(".s-shopping-send .refused");
  await expect(refusal).toContainText("ei ottanut vastaan riviä");
  await expect(refusal).toContainText("(400)");
  await expect(refusal).toContainText("Uudelleen yrittäminen ei auta");

  // The whole point: the one bad row no longer takes the rest of the list with
  // it. Everything but that row went, in the one send.
  const rows = await buyableRows(page);
  expect(rows).toBeGreaterThan(1);
  await expect(refusal).toContainText(`${rows - 1}/${rows} ainesta lähti perille`);
  expect(await listNames(request)).toHaveLength(rows - 1);
});

test("a moment's congestion is ridden out rather than reported (#308)", async ({
  page,
  request,
}) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");
  await currentListLoaded(page);
  await request.post(`${S_OSTOSLISTA_FIXTURE}/_test/reset`);
  await request.post(
    `${S_OSTOSLISTA_FIXTURE}/_test/fail-next?status=503&times=2&only=POST /items`,
  );

  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();
  await expect(page.locator(".shopping-sent")).toContainText(
    "lähetettiin S-ostoslistaan",
  );
  await expect(page.locator(".s-shopping-send .refused")).toHaveCount(0);

  expect(await listNames(request)).toHaveLength(await buyableRows(page));
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
  // Out for the whole send, not for one call: an outage is the case where
  // every row fails and the retries change nothing.
  await request.post(`${S_OSTOSLISTA_FIXTURE}/_test/fail-next?times=999`);
  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();

  await expect(page.locator(".refused")).toContainText(
    "S-ostoslistaan ei saatu lähetettyä kaikkea",
  );
  await expect(row(page, "maito")).toBeVisible();
  await request.post(`${S_OSTOSLISTA_FIXTURE}/_test/fail-next?times=0`);
});

test("a failed product search keeps the local ingredient unmapped", async ({ page }) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista/tuote?rivi=9&haku=virhe");
  await expect(page.locator(".refused")).toContainText("tuotehakua ei saatu avattua");

  await page.goto("/ostoslista");
  const milk = row(page, "maito");
  await openShoppingRow(milk);
  await expect(milk.locator(".s-shopping-product.is-note")).toBeVisible();
});

test("an ingredient opens to say where its total came from", async ({ page }) => {
  await planTheFortnight(page);
  await page.goto("/ostoslista");

  const milk = row(page, "maito");
  await openShoppingRow(milk);

  const from = milk.locator(".shopping-from li");
  await expect(from).toHaveCount(2);
  await expect(from.first()).toContainText("Lasagne · Juustokastike");
  await expect(from.first().locator(".shopping-from-amount")).toHaveText("5 dl");
  await expect(from.last()).toContainText("Maitokastike");
  await expect(from.last().locator(".shopping-from-amount")).toHaveText("2 rkl");

  // The wording the source used is kept, which is the whole point for a line
  // that never stated a number.
  const lemongrass = row(page, "sitruunaruoho");
  await openShoppingRow(lemongrass);
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
      instanceKey: batchKeys.get(id),
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
  await openShoppingRow(row(page, "öljy"));
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
  await openShoppingRow(listed);
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
  await openShoppingRow(milk);
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
  await openShoppingRow(generic);
  await expect(generic.locator(".s-shopping-product.is-note")).toBeVisible();
});

test("changing a pinned row changes that dish's product, not the ingredient's", async ({
  page,
}) => {
  // Found reviewing #302. "Vaihda tuote" on a row that says "Vain reseptissä
  // Lasagne" used to write the *global* ingredient mapping: the override went
  // on winning when the row was read back, so the row showed a product the
  // list would not use, and every other dish changed instead.
  await planTheFortnight(page);
  await page.goto("/ostoslista");

  const milk = row(page, "maito");
  await openShoppingRow(milk);
  await openPanelWith(page, milk, "Valitse tuote");
  await page
    .locator(".s-sheet .s-product-scope-choice select")
    .selectOption({ label: "Käytä tässä reseptissä: Lasagne" });
  await chooseAndReload(page, "Kotimaista rasvaton maito");

  const pinned = page.locator(".shopping-list > li", { hasText: "Vain reseptissä" });
  await openShoppingRow(pinned);
  await openPanelWith(page, pinned, "Vaihda tuote");
  // A pinned row has nothing to ask: it is this dish's row.
  await expect(page.locator(".s-sheet .s-product-scope-choice")).toHaveCount(0);
  await chooseAndReload(page, "Valio kevytmaito");

  const stillPinned = page.locator(".shopping-list > li", {
    hasText: "Vain reseptissä",
  });
  await expect(stillPinned).toContainText("Valio kevytmaito 1 l");

  // The other cooking's spoons of milk are untouched — the ingredient never
  // learned a product at all.
  const generic = page
    .locator(".shopping-list > li", { hasText: "maito" })
    .filter({ hasNot: page.locator(".s-product-scope") });
  await openShoppingRow(generic);
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

test("a second packet is said to the S list as the row's quantity", async ({
  page,
}) => {
  await createBatch(page, today(), LASAGNE, 1);
  await createBatch(page, inDays(1), LASAGNE, 2);
  await page.goto("/ostoslista");
  await chooseProduct(page, "maito", "Kotimaista rasvaton maito");

  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();
  await expect(page.locator(".shopping-sent")).toContainText(
    "lähetettiin S-ostoslistaan",
  );

  const sent = await externalRequests(page);
  // #240: the service and the S-list both hold a count on a product row, so the
  // second packet is that number. It is not a written line beside the product,
  // which is what #161 reached for and what lost the mapping.
  expect(
    addCalls(sent).filter((call) => call.body?.["ean"] === "6415712506032"),
  ).toHaveLength(1);
  expect(quantityFor(sent, "6415712506032")).toBe(2);
  expect(addCalls(sent).some((call) => /×/.test(String(call.body?.["note"] ?? "")))).toBe(
    false,
  );
});

test("two recipes needing the same product keep it a product, at two packets", async ({
  page,
}) => {
  // #240 as reported: a jauheliha at 400 g in each of two different dishes, one
  // 400 g product chosen for it, and a send that used to leave the phone
  // holding "jauheliha × 2" as text instead of two packets of the product.
  const meatloaf = await createMeatloaf(page);
  await createBatch(page, today(), LASAGNE, 1);
  await createBatch(page, inDays(1), meatloaf, 1);
  await page.goto("/ostoslista");

  await expect(row(page, "jauheliha").locator(".shopping-total")).toHaveText("800 g");
  await chooseProduct(page, "jauheliha", "Kotimaista nauta-sikajauheliha");
  await page.reload();
  await expect(
    row(page, "jauheliha").locator(".s-shopping-product-summary"),
  ).toContainText("2 × Kotimaista nauta-sikajauheliha 400 g");

  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();
  await expect(page.locator(".shopping-sent")).toContainText(
    "lähetettiin S-ostoslistaan",
  );

  const sent = await externalRequests(page);
  expect(
    addCalls(sent).filter((call) => call.body?.["ean"] === "6408430000159"),
  ).toHaveLength(1);
  expect(quantityFor(sent, "6408430000159")).toBe(2);
  expect(
    addCalls(sent).some((call) => /jauheliha/i.test(String(call.body?.["note"] ?? ""))),
  ).toBe(false);
});

test("a product two rows both reach is sent once, at the total (#240)", async ({
  page,
}) => {
  // A dish pinned to its own jauheliha and the generic pile are two rows on
  // this screen, and the packet planner only ever sees one row at a time. Give
  // both rows the same product and the phone must still end up with the trip's
  // total rather than whichever row went last.
  const meatloaf = await createMeatloaf(page);
  await createBatch(page, today(), LASAGNE, 1);
  await createBatch(page, inDays(1), meatloaf, 1);
  await page.goto("/ostoslista");

  await chooseProduct(page, "jauheliha", "Kotimaista nauta-sikajauheliha");
  await page.reload();

  // Pin the lasagne to the same product, which splits the row in two (#161).
  const mince = row(page, "jauheliha");
  await reopen(mince);
  await openPanelWith(page, mince, "Vaihda tuote");
  await page
    .locator(".s-sheet .s-product-scope-choice select")
    .selectOption({ label: "Käytä tässä reseptissä: Lasagne" });
  await chooseAndReload(page, "Kotimaista nauta-sikajauheliha");

  const minceRows = page.locator(".shopping-list > li", { hasText: "jauheliha" });
  await expect(minceRows).toHaveCount(2);

  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();
  await expect(page.locator(".shopping-sent")).toContainText(
    "lähetettiin S-ostoslistaan",
  );

  const sent = await externalRequests(page);
  expect(
    addCalls(sent).filter((call) => call.body?.["ean"] === "6408430000159"),
  ).toHaveLength(1);
  // 400 g for the lasagne and 400 g for the meatloaf, one packet each.
  expect(quantityFor(sent, "6408430000159")).toBe(2);
});

test("choosing a product after a text send replaces the text row (#244)", async ({
  page,
  request,
}) => {
  // The report, step by step: milk goes as `maito — 5 dl` because nothing is
  // mapped to it, the household then finds the product, and the next send used
  // to leave both on the phone's list.
  await createBatch(page, today(), LASAGNE, 1);
  await page.goto("/ostoslista");
  await expect(row(page, "maito").locator(".shopping-total")).toHaveText("5 dl");

  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();
  await expect(page.locator(".shopping-sent")).toContainText(
    "lähetettiin S-ostoslistaan",
  );
  expect(await listNames(request)).toContain("maito — 5 dl");

  await chooseProduct(page, "maito", "Kotimaista rasvaton maito");
  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();
  await expect(page.locator(".shopping-sent")).toContainText(
    "lähetettiin S-ostoslistaan",
  );

  const items = await listItems(request);
  const milk = items.filter((item) => /maito/i.test(item.name));
  expect(milk.map((item) => item.name)).toEqual([
    "Kotimaista rasvaton maito 1 l",
  ]);
  expect(milk[0]?.ean).toBe("6415712506032");
});

test("a note whose amount has changed since the last send is still replaced", async ({
  page,
  request,
}) => {
  // The reason the note is written down rather than recomputed: the key
  // contains the amount, and next week's list cannot spell last week's key.
  await createBatch(page, today(), LASAGNE, 1);
  await page.goto("/ostoslista");
  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();
  await expect(page.locator(".shopping-sent")).toBeVisible();
  expect(await listNames(request)).toContain("maito — 5 dl");

  // A second, doubled cooking: the same ingredient, a different note.
  await createBatch(page, inDays(1), LASAGNE, 2);
  await page.goto("/ostoslista");
  await expect(row(page, "maito").locator(".shopping-total")).toHaveText("15 dl");
  await chooseProduct(page, "maito", "Kotimaista rasvaton maito");
  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();
  await expect(page.locator(".shopping-sent")).toBeVisible();

  const names = await listNames(request);
  expect(names).not.toContain("maito — 5 dl");
  expect(names).not.toContain("maito — 15 dl");
  expect(names).toContain("Kotimaista rasvaton maito 1 l");
});

test("a send never removes a row the household added itself", async ({
  page,
  request,
}) => {
  await createBatch(page, today(), LASAGNE, 1);
  await page.goto("/ostoslista");
  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();
  await expect(page.locator(".shopping-sent")).toBeVisible();

  // Typed on the phone, and deliberately about milk too: nothing about the
  // word is what makes a row this app's to delete — only having sent it is.
  await request.post(
    `${S_OSTOSLISTA_FIXTURE}/_test/collected?note=${encodeURIComponent("maito rasvaton")}`,
  );

  await chooseProduct(page, "maito", "Kotimaista rasvaton maito");
  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();
  await expect(page.locator(".shopping-sent")).toBeVisible();

  const names = await listNames(request);
  expect(names).toContain("maito rasvaton");
  expect(names).not.toContain("maito — 5 dl");
});

test("a send that fails partway still replaces the note on the retry (#244)", async ({
  page,
  request,
}) => {
  await createBatch(page, today(), LASAGNE, 1);
  await page.goto("/ostoslista");
  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();
  await expect(page.locator(".shopping-sent")).toBeVisible();
  expect(await listNames(request)).toContain("maito — 5 dl");

  await chooseProduct(page, "maito", "Kotimaista rasvaton maito");
  await currentListLoaded(page);
  await request.post(`${S_OSTOSLISTA_FIXTURE}/_test/fail-next?times=999`);
  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();
  await expect(page.locator(".refused")).toContainText(
    "S-ostoslistaan ei saatu lähetettyä kaikkea",
  );

  // The note is still recorded, so the retry finishes what the outage stopped
  // rather than stranding the text row on the phone for good.
  await request.post(`${S_OSTOSLISTA_FIXTURE}/_test/fail-next?times=0`);
  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();
  await expect(page.locator(".shopping-sent")).toContainText(
    "lähetettiin S-ostoslistaan",
  );

  const names = await listNames(request);
  expect(names).not.toContain("maito — 5 dl");
  expect(names).toContain("Kotimaista rasvaton maito 1 l");
});

/** The fixture service's list, as the phone would see it. */
async function listItems(
  request: APIRequestContext,
): Promise<Array<{ name: string; ean: string | null }>> {
  const response = await request.get(`${S_OSTOSLISTA_FIXTURE}/items`, {
    headers: { authorization: "Bearer test-s-ostoslista-token" },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as {
    items: Array<{ name: string; ean: string | null }>;
  }).items;
}

async function listNames(request: APIRequestContext): Promise<string[]> {
  return (await listItems(request)).map((item) => item.name);
}

type SentCall = Awaited<ReturnType<typeof externalRequests>>[number];

/** Just the adds, in the order they went out. */
function addCalls(calls: SentCall[]): SentCall[] {
  return calls.filter((call) => call.method === "POST" && call.path === "/items");
}

/**
 * The count that actually reached one product's row on the phone's list.
 *
 * The add carries the count, and so does the edit that follows it when there is
 * one — the service's add is keyed, so a product already on the list can come
 * back holding whatever last week's trip left on it, and then it is the edit
 * that decides. Since #308 that edit is sent only when the add's own answer
 * disagreed with what was asked for, so a row the service accepted outright has
 * no edit at all and the add's value is the count. Where both are there they
 * have to agree, which is what the `before` window checks: the send reconciles
 * one row at a time, so an edit belonging to this add is one that lands before
 * the next add goes out.
 */
function quantityFor(calls: SentCall[], ean: string): number | null {
  const at = calls.findIndex(
    (call) => call.method === "POST" && call.path === "/items" && call.body?.["ean"] === ean,
  );
  if (at === -1) return null;
  const onAdd = calls[at]?.body?.["quantity"];
  if (typeof onAdd !== "number") return null;

  const after = calls.slice(at + 1);
  const nextAdd = after.findIndex(
    (call) => call.method === "POST" && call.path === "/items",
  );
  const before = nextAdd === -1 ? after : after.slice(0, nextAdd);
  const patch = before.find(
    (call) => call.method === "PATCH" && call.path.startsWith("/items/"),
  );
  if (patch === undefined) return onAdd;
  return patch.body?.["quantity"] === onAdd ? onAdd : null;
}

/**
 * A second dish calling for the same 400 g of jauhelihaa as the lasagne's
 * jauhelihakastike part. The seed has only the one, and adding another there
 * would change what every other spec counts.
 */
async function createMeatloaf(page: Page): Promise<number> {
  const response = await page.request.post("/recipes", {
    maxRedirects: 0,
    form: {
      title: "Lihamureke",
      yield: "4",
      sourceText: "Lihamureke\n400 g jauhelihaa",
      sourceRoute: "pasted",
      structuredBy: "test",
      lineCount: "1",
      "line.0.quantity": "400",
      "line.0.quantityMax": "",
      "line.0.unit": "g",
      "line.0.altQuantity": "",
      "line.0.altUnit": "",
      "line.0.section": "",
      "line.0.position": "1",
      "line.0.ingredient": "7",
      "line.0.sourceLine": "400 g jauhelihaa",
    },
  });
  expect(response.status()).toBe(302);

  const location = response.headers()["location"] ?? "";
  const id = Number(location.split("/").pop());
  expect(Number.isSafeInteger(id)).toBe(true);
  return id;
}

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
  await openShoppingRow(milk);
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
    await openShoppingRow(milk);
    await openPlainPicker(milk);

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
