import { expect, test, type Page } from "@playwright/test";

import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * Categorising a recipe, and browsing by it (#196).
 *
 * Nothing in `dev/seed.sql` carries a category, which is deliberate here: every
 * recipe in it is exactly what a recipe stored before this change looks like,
 * so the "old recipes still work" case is the starting state of every test
 * below rather than a fixture somebody has to remember to keep.
 *
 * Categories are set through the editor rather than through SQL, because the
 * picker is half the feature.
 */

test.beforeEach(reseed);

async function signIn(page: Page, memberId: number): Promise<void> {
  await page.context().clearCookies();
  await page.context().addCookies([sessionCookie(memberId)]);
}

/** Tick categories on a recipe's editor and save, as a person does. */
async function categorise(
  page: Page,
  recipeId: number,
  labels: string[],
): Promise<void> {
  await page.goto(`/recipes/${recipeId}/edit`);
  const picker = page.locator(".category-choices");
  for (const label of labels) await picker.getByLabel(label).check();
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();
  await expect(page).toHaveURL(new RegExp(`/recipes/${recipeId}$`));
}

test("a recipe with no category reads and lists exactly as before", async ({
  page,
}) => {
  await signIn(page, 1);
  await page.goto("/recipes");
  await expect(page.locator(".recipes li")).toHaveCount(3);
  // Nothing is categorised, so there is nothing to filter by and no chip row.
  await expect(page.locator(".category-filter")).toHaveCount(0);

  await page.goto("/recipes/1");
  await expect(page.locator("h1")).toHaveText("Kaalilaatikko");
  await expect(page.locator(".category-tags")).toHaveCount(0);
});

test("a recipe can be given several categories, and they stick", async ({
  page,
}) => {
  await signIn(page, 1);
  await categorise(page, 1, ["Uuniruoka", "Lisuke"]);

  await expect(page.locator(".category-tags")).toContainText("Uuniruoka");
  await expect(page.locator(".category-tags")).toContainText("Lisuke");

  // Stored, not just rendered from what was posted.
  await page.goto("/recipes/1/edit");
  const picker = page.locator(".category-choices");
  await expect(picker.getByLabel("Uuniruoka")).toBeChecked();
  await expect(picker.getByLabel("Lisuke")).toBeChecked();
  await expect(picker.getByLabel("Keitto")).not.toBeChecked();
});

test("a category can be taken off again later", async ({ page }) => {
  await signIn(page, 1);
  await categorise(page, 1, ["Uuniruoka", "Lisuke"]);

  await page.goto("/recipes/1/edit");
  await page.locator(".category-choices").getByLabel("Lisuke").uncheck();
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();

  await expect(page.locator(".category-tags")).toContainText("Uuniruoka");
  await expect(page.locator(".category-tags")).not.toContainText("Lisuke");
});

test("the list filters to one category and back again", async ({ page }) => {
  await signIn(page, 1);
  await categorise(page, 1, ["Uuniruoka"]);
  await categorise(page, 2, ["Lisuke"]);

  await page.goto("/recipes");
  await expect(page.locator(".recipes li")).toHaveCount(3);

  const filter = page.locator(".category-filter");
  // Only the two categories something actually has, plus the way back.
  await expect(filter.getByRole("link")).toHaveText([
    "Kaikki",
    "Uuniruoka",
    "Lisuke",
  ]);

  await filter.getByRole("link", { name: "Uuniruoka" }).click();
  await expect(page.locator(".recipes li")).toHaveCount(1);
  await expect(page.locator(".recipes li")).toContainText("Kaalilaatikko");

  await page.locator(".category-filter").getByRole("link", { name: "Kaikki" }).click();
  await expect(page.locator(".recipes li")).toHaveCount(3);
});

test("a name search made inside a category stays inside it", async ({ page }) => {
  await signIn(page, 1);
  await categorise(page, 1, ["Uuniruoka"]);
  await categorise(page, 3, ["Uuniruoka"]);

  await page.goto("/recipes?kategoria=uuniruoka");
  await expect(page.locator(".recipes li")).toHaveCount(2);

  await page.getByLabel("Hae nimellä").fill("kaali");
  await page.getByRole("button", { name: "Hae" }).click();

  await expect(page).toHaveURL(/kategoria=uuniruoka/);
  await expect(page.locator(".recipes li")).toHaveCount(1);
  await expect(page.locator(".recipes li")).toContainText("Kaalilaatikko");
});

test("an empty category says so and offers the way back", async ({ page }) => {
  await signIn(page, 1);
  await categorise(page, 1, ["Uuniruoka"]);

  await page.goto("/recipes?kategoria=keitto");
  await expect(page.locator(".nothing .empty")).toContainText("Keitto");
  await page.getByRole("link", { name: "Näytä kaikki reseptit" }).click();
  await expect(page.locator(".recipes li")).toHaveCount(3);
});

test("a category from a stale link shows the recipes rather than an error", async ({
  page,
}) => {
  await signIn(page, 1);
  await page.goto("/recipes?kategoria=wellington");
  await expect(page.locator(".recipes li")).toHaveCount(3);
});

test("a shared recipe carries its owner's categories into the other household", async ({
  page,
}) => {
  // Naapurin uunikala is household 2's and ships published, so this is the one
  // place a category crosses a household boundary — and it should, because it
  // is a fact about the dish rather than about the kitchen reading it.
  await signIn(page, 2);
  await categorise(page, 6, ["Uuniruoka"]);

  await signIn(page, 1);
  await page.goto("/recipes/julkiset");
  await expect(page.locator(".recipes li")).toContainText("Uuniruoka");

  await page.locator(".category-filter").getByRole("link", { name: "Uuniruoka" }).click();
  await expect(page.locator(".recipes li")).toHaveCount(1);
  await expect(page.locator(".recipes li")).toContainText("Naapurin uunikala");

  // Still not editable from here: sharing widened reading, and nothing else.
  await page.goto("/recipes/6/edit");
  await expect(page.locator("h1")).toHaveText("Ei löytynyt");
});

test("a part of a dish is not categorised", async ({ page }) => {
  await signIn(page, 1);
  // Recipe 5 is the lasagne's Juustokastike — a recipe row, but not a dish.
  await page.goto("/recipes/5/edit");
  await expect(page.locator(".category-choices")).toHaveCount(0);

  await page.goto("/recipes/3/edit");
  await expect(page.locator(".category-choices")).toHaveCount(1);
});
