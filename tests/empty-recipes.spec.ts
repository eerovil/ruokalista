import { expect, test, type Page } from "@playwright/test";

import { openEditBlock } from "./support/blocks";
import { executeLocalSql, reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * Empty recipes (#340).
 *
 * A dish with no ingredient or no step — on itself or any of its parts — is
 * empty. It is marked on the list, can be found with one switch, cannot be
 * published or shared, and another household never sees one even when it was
 * published before it was emptied.
 *
 * Member 1 is Koti's and member 2 Naapuri's, as in `dev/seed.sql`. Every seeded
 * recipe has both ingredients and steps, so the empty ones are made here.
 */

test.beforeEach(() => {
  reseed();
  executeLocalSql(`
    INSERT INTO recipe
      (id, household_id, title, source_text, source_route, created_by, updated_by)
    VALUES
      (50, 1, 'Mummon pulla', '', 'pasted', 1, 1);
    INSERT INTO recipe
      (id, household_id, title, source_text, source_route, created_by, updated_by,
       published_at, published_by)
    VALUES
      (51, 1, 'Vanha julkinen', '', 'pasted', 1, 1, '2026-08-01 09:00:00', 1);
    INSERT INTO ingredient_line
      (recipe_id, position, quantity, unit, ingredient_id, source_line)
    VALUES (51, 1, 1, 'dl', 1, '1 dl öljyä')
  `);
});

async function signIn(page: Page, memberId: number): Promise<void> {
  await page.context().clearCookies();
  await page.context().addCookies([sessionCookie(memberId)]);
}

test("an empty recipe is marked on the list, and the switch finds only those", async ({
  page,
}) => {
  await signIn(page, 1);
  await page.goto("/recipes");

  const empty = page.locator(".recipes li", { hasText: "Mummon pulla" });
  await expect(empty.locator(".badge.is-empty")).toHaveText(/Tyhjä/);
  // Ingredients and no method is still empty.
  await expect(
    page.locator(".recipes li", { hasText: "Vanha julkinen" }).locator(".badge.is-empty"),
  ).toBeVisible();
  await expect(
    page.locator(".recipes li", { hasText: "Kaalilaatikko" }).locator(".badge.is-empty"),
  ).toHaveCount(0);

  await page.getByRole("checkbox", { name: "Näytä vain tyhjät" }).click();
  await expect(page).toHaveURL(/tyhjat=vain/);
  await expect(page.locator(".recipes li")).toHaveCount(2);
  await expect(page.locator(".recipes")).not.toContainText("Kaalilaatikko");

  // A search keeps the switch on: its form carries it.
  await expect(
    page.locator('.browse-search input[name="tyhjat"]'),
  ).toHaveValue("vain");
  await page.getByLabel("Hae nimellä").fill("pulla");
  await expect(page.locator(".recipes li:visible")).toHaveCount(1);

  await page.getByRole("checkbox", { name: "Näytä vain tyhjät" }).click();
  await expect(page).not.toHaveURL(/tyhjat/);
  await expect(
    page.getByRole("checkbox", { name: "Näytä vain tyhjät" }),
  ).toHaveAttribute("aria-checked", "false");
});

test("an empty recipe cannot be published from the list", async ({ page }) => {
  await signIn(page, 1);
  await page.goto("/recipes");

  await page.getByLabel("Valitse Mummon pulla").check();
  await page.getByLabel("Valitse Kaalilaatikko").check();
  await page.getByRole("button", { name: "Julkaise valitut" }).click();

  await expect(page.locator("p.refused")).toContainText("Mummon pulla on tyhjä");
  // The one with something in it was published all the same.
  await expect(
    page.locator(".recipes li", { hasText: "Kaalilaatikko" }),
  ).toContainText("Julkinen");
  await expect(
    page.locator(".recipes li", { hasText: "Mummon pulla" }),
  ).not.toContainText("Julkinen");
});

test("an empty recipe cannot be made public or shared from its own screen", async ({
  page,
}) => {
  await signIn(page, 1);
  await page.goto("/recipes/50");
  await openEditBlock(page, "sharing-open");
  await expect(page.locator(".sharing-form")).toContainText("Resepti on tyhjä");

  await page.getByLabel("Julkinen").check();
  await page.getByRole("button", { name: "Tallenna jako" }).click();
  await expect(page.locator("p.refused")).toContainText("ei voi julkaista eikä jakaa");

  await page.goto("/recipes/50");
  await openEditBlock(page, "sharing-open");
  await page.getByLabel("Valituille").check();
  await page.locator(".recipient-picker").getByLabel("Naapuri").check();
  await page.getByRole("button", { name: "Tallenna jako" }).click();
  await expect(page.locator("p.refused")).toContainText("ei voi julkaista eikä jakaa");
});

test("another household never sees an empty recipe, even a published one", async ({
  page,
}) => {
  await signIn(page, 2);
  await page.goto("/recipes");
  await expect(page.locator(".recipes")).not.toContainText("Vanha julkinen");

  const response = await page.goto("/recipes/51");
  expect(response?.status()).toBe(404);

  // Given a method, it is a dish again and reaches them.
  executeLocalSql(`
    INSERT INTO recipe_step (recipe_id, position, text) VALUES (51, 1, 'Sekoita.')
  `);
  await page.goto("/recipes");
  await expect(page.locator(".recipes")).toContainText("Vanha julkinen");
});
