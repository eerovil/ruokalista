import { expect, test } from "@playwright/test";

import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

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

test("a recipe with a known yield shows it", async ({ page }) => {
  await page.goto("/recipes/1");
  await expect(page.locator(".yield")).toContainText("4 annosta");
});

test("a recipe with no yield says it cannot be scaled", async ({ page }) => {
  await page.goto("/recipes/2");
  await expect(page.locator(".yield")).toContainText("ei voi skaalata");
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

test("the neighbour sees only their own ingredients", async ({ browser }) => {
  const context = await browser.newContext();
  await context.addCookies([sessionCookie(2)]);

  const response = await context.request.get("/api/ingredients");
  const body = (await response.json()) as {
    ingredients: { name: string }[];
  };
  expect(body.ingredients.map((i) => i.name)).toEqual(["naapurin suola"]);

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
