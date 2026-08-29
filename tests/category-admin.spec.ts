import { expect, test, type Page } from "@playwright/test";

import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * Curating the category vocabulary from the admin panel (#199).
 *
 * The vocabulary is a table since this change, so these tests are about the two
 * halves that were previously a release: an admin edits the list, and every
 * ordinary screen says the new thing on its next render. Member 3 is Koti's
 * admin; member 1 is an ordinary member and is what the boundary is checked
 * against.
 */

test.beforeEach(reseed);

async function signIn(page: Page, memberId: number): Promise<void> {
  await page.context().clearCookies();
  await page.context().addCookies([sessionCookie(memberId)]);
}

/**
 * The row of a category, found by its slug.
 *
 * By slug rather than by label on purpose: the label lives in an input's value
 * and is not text a locator can filter on, and the slug is printed in the row's
 * meta line. It is also the thing that does not move when a rename happens.
 */
function row(page: Page, slug: string) {
  return page.locator(".category-admin li").filter({ hasText: slug });
}

/** Every category's name box, in the order the screen draws them. */
function labelBoxes(page: Page) {
  return page.locator('.category-admin li input[name="label"]');
}

test("the two categories #199 asks for ship with the migration", async ({
  page,
}) => {
  await signIn(page, 1);
  await page.goto("/recipes/1/edit");
  const picker = page.locator(".category-choices");
  await expect(picker.getByLabel("Kastike")).toHaveCount(1);
  await expect(picker.getByLabel("Pizza/piirakka")).toHaveCount(1);
  // And the seven #196 shipped are all still there.
  await expect(picker.locator("input")).toHaveCount(9);
});

test("an admin adds a category and a member can use it at once", async ({
  page,
}) => {
  await signIn(page, 3);
  await page.goto("/admin/kategoriat");
  await page.getByLabel("Uusi kategoria").fill("Wokki");
  await page.getByRole("button", { name: "Lisää kategoria" }).click();
  await expect(page.locator(".done")).toContainText("Wokki");
  // The slug is derived, and it is what a recipe will store.
  await expect(row(page, "wokki").locator("input[name=\"label\"]")).toHaveValue(
    "Wokki",
  );

  await signIn(page, 1);
  await page.goto("/recipes/1/edit");
  await page.locator(".category-choices").getByLabel("Wokki").check();
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();
  await expect(page.locator(".category-tags")).toContainText("Wokki");

  await page.goto("/recipes?kategoria=wokki");
  await expect(page.locator(".recipes li")).toHaveCount(1);
});

test("a Finnish name becomes an ASCII slug", async ({ page }) => {
  await signIn(page, 3);
  await page.goto("/admin/kategoriat");
  await page.getByLabel("Uusi kategoria").fill("Äyriäiset");
  await page.getByRole("button", { name: "Lisää kategoria" }).click();
  await expect(row(page, "ayriaiset").locator("input[name=\"label\"]")).toHaveValue(
    "Äyriäiset",
  );
});

test("a duplicate is refused, by slug and by name", async ({ page }) => {
  await signIn(page, 3);
  await page.goto("/admin/kategoriat");

  await page.getByLabel("Uusi kategoria").fill("keitto");
  await page.getByRole("button", { name: "Lisää kategoria" }).click();
  await expect(page.locator(".refused")).toContainText("on jo olemassa");

  await page.getByLabel("Uusi kategoria").fill("///");
  await page.getByRole("button", { name: "Lisää kategoria" }).click();
  await expect(page.locator(".refused")).toContainText("kirjain tai numero");

  // Nothing was added by either attempt.
  await expect(page.locator(".category-admin li")).toHaveCount(9);
});

test("renaming changes the word everywhere and no recipe row", async ({
  page,
}) => {
  await signIn(page, 1);
  await page.goto("/recipes/1/edit");
  await page.locator(".category-choices").getByLabel("Uuniruoka").check();
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();
  await expect(page.locator(".category-tags")).toContainText("Uuniruoka");

  await signIn(page, 3);
  await page.goto("/admin/kategoriat");
  await row(page, "uuniruoka").locator('input[name="label"]').fill("Uunissa");
  await row(page, "uuniruoka").getByRole("button", { name: "Tallenna" }).click();
  await expect(page.locator(".done")).toContainText("Nimi tallennettiin");

  await signIn(page, 1);
  // The recipe still carries it: the slug never moved, so the link survived.
  await page.goto("/recipes/1");
  await expect(page.locator(".category-tags")).toContainText("Uunissa");
  await expect(page.locator(".category-tags")).not.toContainText("Uuniruoka");
  // And the filter still finds it under the same slug.
  await page.goto("/recipes?kategoria=uuniruoka");
  await expect(page.locator(".recipes li")).toHaveCount(1);
});

test("the order an admin sets is the order the picker draws", async ({
  page,
}) => {
  await signIn(page, 3);
  await page.goto("/admin/kategoriat");
  await expect(labelBoxes(page).first()).toHaveValue("Pasta");

  // Keitto is second; one press up puts it first.
  await row(page, "keitto")
    .getByRole("button", { name: "Siirrä Keitto ylös" })
    .click();
  await expect(labelBoxes(page).first()).toHaveValue("Keitto");

  await signIn(page, 1);
  await page.goto("/recipes/1/edit");
  const picker = page.locator(".category-choices label");
  await expect(picker.first()).toContainText("Keitto");
});

test("removing a category says which recipes it will change, then does it", async ({
  page,
}) => {
  await signIn(page, 1);
  await page.goto("/recipes/1/edit");
  await page.locator(".category-choices").getByLabel("Keitto").check();
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();

  await signIn(page, 3);
  await page.goto("/admin/kategoriat");
  await expect(row(page, "keitto")).toContainText("1 resepti");
  await row(page, "keitto").getByRole("link", { name: "Poista" }).click();

  // The impact, before anything happens: the recipe is named, not just counted.
  await expect(page.locator(".refused")).toContainText("yhdeltä reseptiltä");
  await expect(page.locator(".recipes li")).toContainText("Kaalilaatikko");

  await page.getByRole("button", { name: "Poista kategoria" }).click();
  await expect(page.locator(".done")).toContainText("yhdeltä reseptiltä");
  await expect(page.locator(".category-admin li")).toHaveCount(8);

  await signIn(page, 1);
  // The recipe is still there, and has simply lost the category.
  await page.goto("/recipes/1");
  await expect(page.locator("h1")).toHaveText("Kaalilaatikko");
  await expect(page.locator(".category-tags")).toHaveCount(0);
  await page.goto("/recipes/1/edit");
  await expect(page.locator(".category-choices").getByLabel("Keitto")).toHaveCount(0);
});

test("removing an unused category says so rather than warning", async ({
  page,
}) => {
  await signIn(page, 3);
  await page.goto("/admin/kategoriat/leivonta/poista");
  await expect(page.locator(".empty")).toContainText("Yksikään resepti");
  await expect(page.locator(".refused")).toHaveCount(0);
  await page.getByRole("button", { name: "Poista kategoria" }).click();
  await expect(page.locator(".done")).toContainText("poistettiin.");
});

test("an ordinary member cannot reach any of it", async ({ page }) => {
  await signIn(page, 1);
  for (const path of ["/admin/kategoriat", "/admin/kategoriat/keitto/poista"]) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(404);
  }

  const added = await page.request.post("/admin/kategoriat", {
    form: { action: "add", label: "Salakategoria" },
  });
  expect(added.status()).toBe(404);

  const removed = await page.request.post("/admin/kategoriat/keitto/poista", {
    form: {},
  });
  expect(removed.status()).toBe(404);

  // And nothing moved.
  await signIn(page, 3);
  await page.goto("/admin/kategoriat");
  await expect(page.locator(".category-admin li")).toHaveCount(9);
});

test("an empty vocabulary hides the picker instead of breaking", async ({
  page,
}) => {
  await signIn(page, 3);
  for (const slug of [
    "pasta",
    "keitto",
    "salaatti",
    "uuniruoka",
    "kastike",
    "pizza-piirakka",
    "leivonta",
    "jalkiruoka",
    "lisuke",
  ]) {
    const response = await page.request.post(`/admin/kategoriat/${slug}/poista`, {
      form: {},
    });
    expect(response.status()).toBe(200);
  }

  await signIn(page, 1);
  await page.goto("/recipes/1/edit");
  await expect(page.locator(".category-choices")).toHaveCount(0);
  await page.goto("/recipes");
  await expect(page.locator(".bulk-categories")).toHaveCount(0);
  await expect(page.locator(".recipes li")).toHaveCount(3);
});
