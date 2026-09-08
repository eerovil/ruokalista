import { expect, test } from "@playwright/test";

import { executeLocalSql, reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

test.beforeEach(async ({ context }) => {
  reseed();
  await context.addCookies([sessionCookie(1)]);
});

test("an editor save refuses a category change made after the form opened", async ({
  page,
}) => {
  await page.goto("/recipes/1/edit");
  await page.locator("#title").fill("Vanha muokkaus");

  // Category bulk edits intentionally do not advance recipe.revision. The edit
  // form's snapshot has to carry this child-table state separately or this save
  // would silently overwrite the category somebody added after the form opened.
  executeLocalSql(
    "INSERT INTO recipe_category (recipe_id, category) VALUES (1, 'pasta')",
  );

  await page.getByRole("button", { name: "Tallenna muutokset" }).click();

  await expect(page.locator(".refused")).toContainText(
    "Reseptin kategoriat ovat muuttuneet",
  );
  // The refusal keeps the member's edit in front of them rather than discarding
  // it, while the database keeps the concurrently changed recipe untouched.
  await expect(page.locator("#title")).toHaveValue("Vanha muokkaus");

  await page.goto("/recipes/1");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Kaalilaatikko");
});
