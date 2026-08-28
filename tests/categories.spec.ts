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

/**
 * Changing a category on several recipes at once (#199).
 *
 * The selection is the one the list already had for publishing, so these tests
 * tick rows exactly as a person does rather than posting the form directly.
 */

/** Tick the rows of the named recipes on `/recipes`. */
async function pick(page: Page, titles: string[]): Promise<void> {
  for (const title of titles) {
    await page.getByLabel(`Valitse ${title}`).check();
  }
}

test("a category is added to several recipes in one press", async ({ page }) => {
  await signIn(page, 1);
  await page.goto("/recipes");

  await pick(page, ["Kaalilaatikko", "Öljykastike"]);
  await expect(page.locator(".selection-count")).toHaveText("2 reseptiä valittuna.");

  await page.locator(".bulk-categories select").selectOption({ label: "Keitto" });
  await page.getByRole("button", { name: "Lisää valituille" }).click();

  await expect(page.locator(".done")).toContainText("Keitto");
  await expect(page.locator(".done")).toContainText("2 reseptille");

  // Stored on both, and on nothing else.
  await page.goto("/recipes?kategoria=keitto");
  await expect(page.locator(".recipes li")).toHaveCount(2);

  await page.goto("/recipes/1/edit");
  await expect(page.locator(".category-choices").getByLabel("Keitto")).toBeChecked();
});

test("a bulk add leaves the categories a recipe already had alone", async ({
  page,
}) => {
  await signIn(page, 1);
  await categorise(page, 1, ["Uuniruoka"]);

  await page.goto("/recipes");
  await pick(page, ["Kaalilaatikko"]);
  await page.locator(".bulk-categories select").selectOption({ label: "Lisuke" });
  await page.getByRole("button", { name: "Lisää valituille" }).click();

  await page.goto("/recipes/1/edit");
  const picker = page.locator(".category-choices");
  await expect(picker.getByLabel("Uuniruoka")).toBeChecked();
  await expect(picker.getByLabel("Lisuke")).toBeChecked();
});

test("a category is taken off several recipes in one press", async ({ page }) => {
  await signIn(page, 1);
  await categorise(page, 1, ["Uuniruoka"]);
  await categorise(page, 3, ["Uuniruoka"]);

  await page.goto("/recipes");
  await pick(page, ["Kaalilaatikko", "Lasagne"]);
  await page.locator(".bulk-categories select").selectOption({ label: "Uuniruoka" });
  await page.getByRole("button", { name: "Poista valituilta" }).click();

  await expect(page.locator(".done")).toContainText("2 reseptiltä");
  await expect(page.locator(".category-filter")).toHaveCount(0);
});

test("the notice separates what moved from what was already there", async ({
  page,
}) => {
  await signIn(page, 1);
  await categorise(page, 1, ["Keitto"]);

  await page.goto("/recipes");
  await pick(page, ["Kaalilaatikko", "Öljykastike"]);
  await page.locator(".bulk-categories select").selectOption({ label: "Keitto" });
  await page.getByRole("button", { name: "Lisää valituille" }).click();

  await expect(page.locator(".done")).toContainText("yhdelle reseptille");
  await expect(page.locator(".done")).toContainText("1 reseptillä se oli jo.");
});

test("pressing with nothing ticked refuses and changes nothing", async ({
  page,
}) => {
  await signIn(page, 1);
  await page.goto("/recipes");

  await expect(page.locator(".selection-count")).toHaveText(
    "Ei yhtään reseptiä valittuna.",
  );
  await page.locator(".bulk-categories select").selectOption({ label: "Keitto" });
  await page.getByRole("button", { name: "Lisää valituille" }).click();

  await expect(page.locator(".refused")).toContainText("Valitse ainakin yksi");
  await expect(page.locator(".recipes li")).toHaveCount(3);
  await expect(page.locator(".category-filter")).toHaveCount(0);
  // The refusal keeps what the member chose, so only the ticking is redone.
  await expect(page.locator(".bulk-categories select")).toHaveValue("keitto");
});

test("a bulk edit comes back to the same search and category", async ({ page }) => {
  await signIn(page, 1);
  await categorise(page, 1, ["Uuniruoka"]);
  await categorise(page, 3, ["Uuniruoka"]);

  await page.goto("/recipes?q=lasagne&kategoria=uuniruoka");
  await pick(page, ["Lasagne"]);
  await page.locator(".bulk-categories select").selectOption({ label: "Lisuke" });
  await page.getByRole("button", { name: "Lisää valituille" }).click();

  await expect(page.locator(".done")).toContainText("Lisuke");
  await expect(page.locator(".recipes li")).toHaveCount(1);
  await expect(page.locator(".recipes li")).toContainText("Lasagne");
  await expect(page.getByLabel("Hae nimellä")).toHaveValue("lasagne");
});

test("another household's recipe cannot be bulk categorised", async ({ page }) => {
  await signIn(page, 1);
  // Recipe 6 is household 2's published dish: readable here, never writable.
  // It has no row on this list, so the id has to be posted by hand — which is
  // the case worth testing.
  const response = await page.request.post("/recipes/kategoriat", {
    form: { action: "add", bulkCategory: "keitto", recipeId: "6" },
  });
  expect(response.status()).toBe(400);
  expect(await response.text()).toContain("Valitse ainakin yksi resepti");

  await signIn(page, 2);
  await page.goto("/recipes/6");
  await expect(page.locator(".category-tags")).toHaveCount(0);
});

test("a part of a dish cannot be bulk categorised either", async ({ page }) => {
  await signIn(page, 1);
  // Recipe 5 is the lasagne's Juustokastike — owned, but a part (ADR-0002).
  const response = await page.request.post("/recipes/kategoriat", {
    form: { action: "add", bulkCategory: "keitto", recipeId: "5" },
  });
  expect(response.status()).toBe(400);
  expect(await response.text()).toContain("Valitse ainakin yksi resepti");
});

test("a part of a dish is not categorised", async ({ page }) => {
  await signIn(page, 1);
  // Recipe 5 is the lasagne's Juustokastike — a recipe row, but not a dish.
  await page.goto("/recipes/5/edit");
  await expect(page.locator(".category-choices")).toHaveCount(0);

  await page.goto("/recipes/3/edit");
  await expect(page.locator(".category-choices")).toHaveCount(1);
});
