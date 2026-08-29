import { expect, test, type Locator, type Page } from "@playwright/test";

import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * The shopping row's summary line, on the narrowest phone this app expects
 * (#213).
 *
 * The complaint was one row: an ingredient whose total added up to
 * `1 + 1 kpl + määrä reseptin mukaan`. The total sized itself from its own
 * text while the name was told to take whatever was left, so the name got a
 * few pixels, broke mid-word, and drew `sipuli` as a column of single letters
 * about ten lines tall.
 *
 * These tests are about the geometry rather than the words, because the words
 * were never wrong. They run at 320 px — narrower than the suite's Pixel 7 —
 * since that is where the line runs out first.
 */

const NARROW = { width: 320, height: 720 };

/** An ingredient name long enough to be the other half of the squeeze. */
const LONG_NAME = "kirsikkatomaattisäilykepurkki";

/** The total from the issue, and what makes it: unitless, kpl, and unstated. */
const LONG_TOTAL = "1 + 1 kpl + määrä reseptin mukaan";

const SHOTS = "docs/screenshots";
const writeScreenshots = process.env["PLAYWRIGHT_SCREENSHOTS"] === "1";

async function capture(
  page: Page,
  options: Parameters<Page["screenshot"]>[0],
): Promise<void> {
  if (writeScreenshots) await page.screenshot(options);
}

test.beforeEach(async ({ context }) => {
  reseed();
  await context.addCookies([sessionCookie(1)]);
});

function row(page: Page, name: string): Locator {
  return page.locator(".shopping-list > li", { hasText: name }).first();
}

interface Line {
  quantity: string;
  unit: string;
  ingredient: string;
  newName?: string;
}

/** Save a recipe of bare ingredient lines, and hand back its id. */
async function createRecipe(
  page: Page,
  title: string,
  lines: Line[],
): Promise<number> {
  const form: Record<string, string> = {
    title,
    yield: "2",
    sourceText: [title, ...lines.map((line) => sourceLineOf(line))].join("\n"),
    sourceRoute: "pasted",
    structuredBy: "test",
    lineCount: String(lines.length),
  };
  lines.forEach((line, index) => {
    form[`line.${index}.quantity`] = line.quantity;
    form[`line.${index}.quantityMax`] = "";
    form[`line.${index}.unit`] = line.unit;
    form[`line.${index}.altQuantity`] = "";
    form[`line.${index}.altUnit`] = "";
    form[`line.${index}.section`] = "";
    form[`line.${index}.position`] = String(index + 1);
    form[`line.${index}.ingredient`] = line.ingredient;
    form[`line.${index}.newName`] = line.newName ?? "";
    form[`line.${index}.sourceLine`] = sourceLineOf(line);
  });

  const response = await page.request.post("/recipes", {
    maxRedirects: 0,
    form,
  });
  expect(response.status()).toBe(302);
  const id = Number((response.headers()["location"] ?? "").split("/").pop());
  expect(Number.isSafeInteger(id)).toBe(true);
  return id;
}

function sourceLineOf(line: Line): string {
  const name = line.newName ?? `aines ${line.ingredient}`;
  return [line.quantity, line.unit, name].filter((part) => part !== "").join(" ");
}

async function createBatch(
  page: Page,
  recipeId: number,
  date: string,
): Promise<void> {
  const response = await page.request.post("/api/batches", {
    data: { date, slot: "dinner", recipeId, multiplier: 1 },
  });
  expect(response.status()).toBe(201);
}

/** Today in Helsinki, which is what the Worker means by today. */
function today(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Helsinki",
  }).format(new Date());
}

async function idOf(page: Page, name: string): Promise<string> {
  const response = await page.request.get("/api/ingredients");
  expect(response.ok()).toBe(true);
  const { ingredients } = (await response.json()) as {
    ingredients: Array<{ id: number; name: string }>;
  };
  const found = ingredients.find((one) => one.name === name);
  expect(found, `no ingredient named ${name}`).toBeTruthy();
  return String(found?.id);
}

/**
 * Two rows whose totals are the issue's: an ordinary short name and a long
 * one, each adding up over three lines the list cannot combine into one
 * number.
 */
async function planTheLongTotals(page: Page): Promise<void> {
  const first = await createRecipe(page, "Pitkä summa I", [
    { quantity: "1", unit: "", ingredient: "new", newName: "sipuli" },
    { quantity: "1", unit: "", ingredient: "new", newName: LONG_NAME },
  ]);
  const onion = await idOf(page, "sipuli");
  const jar = await idOf(page, LONG_NAME);
  const second = await createRecipe(page, "Pitkä summa II", [
    { quantity: "1", unit: "kpl", ingredient: onion },
    { quantity: "", unit: "", ingredient: onion },
    { quantity: "1", unit: "kpl", ingredient: jar },
    { quantity: "", unit: "", ingredient: jar },
  ]);
  await createBatch(page, first, today());
  await createBatch(page, second, today());
}

interface RowShape {
  summaryHeight: number;
  summaryWidth: number;
  nameWidth: number;
  nameHeight: number;
  nameLineHeight: number;
  totalRight: number;
}

/** What the row actually drew, in pixels. */
async function shapeOf(item: Locator): Promise<RowShape> {
  return item.evaluate((li) => {
    const summary = li.querySelector("summary") as HTMLElement;
    const name = li.querySelector(".shopping-name") as HTMLElement;
    const total = li.querySelector(".shopping-total") as HTMLElement;
    const box = summary.getBoundingClientRect();
    const nameBox = name.getBoundingClientRect();
    const style = window.getComputedStyle(name);
    const lineHeight = Number.parseFloat(style.lineHeight);
    return {
      summaryHeight: box.height,
      summaryWidth: box.width,
      nameWidth: nameBox.width,
      nameHeight: nameBox.height,
      nameLineHeight: Number.isFinite(lineHeight)
        ? lineHeight
        : Number.parseFloat(style.fontSize) * 1.5,
      totalRight: box.right - total.getBoundingClientRect().right,
    };
  });
}

/**
 * The four things the issue asks for, in one place: the name keeps a real
 * share of the line, it does not stack itself vertically, the row stays a row,
 * and the total still ends where the chevron begins.
 */
function expectReadable(shape: RowShape): void {
  expect(shape.nameWidth).toBeGreaterThan(shape.summaryWidth * 0.4);
  expect(shape.nameHeight).toBeLessThanOrEqual(shape.nameLineHeight * 2 + 2);
  expect(shape.summaryHeight).toBeLessThanOrEqual(96);
  // Right-aligned under the chevron's reserved column, not adrift in the row.
  expect(shape.totalRight).toBeLessThanOrEqual(24);
}

test("a long total does not squeeze the ingredient's name", async ({ page }) => {
  await page.setViewportSize(NARROW);
  await planTheLongTotals(page);
  await page.goto("/ostoslista");

  const onion = row(page, "sipuli");
  await expect(onion.locator(".shopping-total")).toHaveText(LONG_TOTAL);
  expectReadable(await shapeOf(onion));

  await capture(page, {
    path: `${SHOTS}/101-shopping-long-total.png`,
    fullPage: true,
  });
});

test("a long name and a long total share the row", async ({ page }) => {
  await page.setViewportSize(NARROW);
  await planTheLongTotals(page);
  await page.goto("/ostoslista");

  const jar = row(page, LONG_NAME);
  await expect(jar.locator(".shopping-total")).toHaveText(LONG_TOTAL);

  const shape = await shapeOf(jar);
  // A name this long is allowed a second line; it is not allowed a column.
  expect(shape.nameWidth).toBeGreaterThan(shape.summaryWidth * 0.4);
  expect(shape.nameHeight).toBeLessThanOrEqual(shape.nameLineHeight * 2 + 2);
  expect(shape.summaryHeight).toBeLessThanOrEqual(120);
});

test("an ordinary row is unchanged", async ({ page }) => {
  await page.setViewportSize(NARROW);
  await planTheLongTotals(page);
  await createBatch(page, 1, today());
  await page.goto("/ostoslista");

  const oil = row(page, "öljy");
  await expect(oil.locator(".shopping-total")).toHaveText("½ dl");
  const shape = await shapeOf(oil);
  // Name and total still on one line together, as they always were.
  expect(shape.nameHeight).toBeLessThanOrEqual(shape.nameLineHeight + 2);
  expect(shape.summaryHeight).toBeLessThanOrEqual(56);
  expect(shape.totalRight).toBeLessThanOrEqual(24);
});

test("a row with a product picture holds the same shape", async ({ page }) => {
  await page.setViewportSize(NARROW);
  await planTheLongTotals(page);
  // Milk already adds up in two units; a third line it cannot combine makes it
  // the picture-carrying version of the same long total.
  const milkId = await idOf(page, "maito");
  const extra = await createRecipe(page, "Maitoa lisää", [
    { quantity: "1", unit: "kpl", ingredient: milkId },
    { quantity: "", unit: "", ingredient: milkId },
  ]);
  await createBatch(page, extra, today());
  await createBatch(page, 3, today());
  await page.goto("/ostoslista");

  const milk = row(page, "maito");
  await expect(milk.locator(".shopping-total")).toContainText(
    "määrä reseptin mukaan",
  );

  await milk.locator("summary").click();
  await milk.getByRole("button", { name: /Valitse tuote|Vaihda tuote/ }).click();
  await expect(page.locator(".s-sheet")).toBeVisible();
  await expect(page.locator(".s-sheet .spinner")).toHaveCount(0);
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/ostoslista/tuote"),
  );
  await page
    .locator(".s-sheet .s-product-results > li")
    .filter({ hasText: "Kotimaista rasvaton maito" })
    .getByRole("button", { name: "Valitse" })
    .click();
  await saved;
  await expect(milk.locator(".s-status .spinner")).toHaveCount(0);

  await expect(milk.locator(".shopping-thumb img")).toHaveCount(1);
  expectReadable(await shapeOf(milk));

  await capture(page, {
    path: `${SHOTS}/102-shopping-long-total-with-picture.png`,
    fullPage: true,
  });
});
