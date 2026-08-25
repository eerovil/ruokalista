import { expect, test, type Page } from "@playwright/test";

import { openMore, openSpareLines } from "./support/lines";
import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/** Editing a saved recipe, deleting one, and renaming an ingredient. */

test.beforeAll(reseed);

test.beforeEach(async ({ context }) => {
  await context.addCookies([sessionCookie(1)]);
});

test("the editor opens from the recipe with its fields filled in", async ({
  page,
}) => {
  await page.goto("/recipes/1");
  await page.getByRole("link", { name: "Muokkaa reseptiä" }).click();

  await expect(page).toHaveURL(/\/recipes\/1\/edit$/);
  await expect(page.locator("#title")).toHaveValue("Kaalilaatikko");
  await expect(page.locator("#yield")).toHaveValue("4");
  // Four stored lines plus the spare rows.
  await expect(page.locator(".line")).toHaveCount(7);
});

test("the ingredient picker is preselected from the stored line", async ({
  page,
}) => {
  await page.goto("/recipes/1/edit");
  const first = page.locator(".line").first();
  await expect(first.locator("select")).toHaveValue("1"); // öljy
  await expect(first.locator("input[name$=unit]").first()).toHaveValue("dl");
});

test("source text is shown but not editable", async ({ page }) => {
  await page.goto("/recipes/1/edit");

  await expect(page.locator(".source-text")).toContainText("Kaalilaatikko");
  // No form field carries it, so a save cannot rewrite the record of what
  // arrived.
  await expect(page.locator('[name="sourceText"]')).toHaveCount(0);
});

test("editing a title and a quantity keeps the source text", async ({ page }) => {
  await page.goto("/recipes/1/edit");

  await page.locator("#title").fill("Uunikaalilaatikko");
  await page.locator(".line").first().locator("input[name$=quantity]").first()
    .fill("1,5");
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();

  await expect(page).toHaveURL(/\/recipes\/1$/);
  await expect(page.getByRole("heading", { name: "Uunikaalilaatikko" })).toBeVisible();
  await expect(page.locator(".lines li").first()).toContainText("1½ dl");
  // Untouched, because it is the record of what actually arrived.
  await expect(page.locator(".source-text")).toContainText("½ dl öljyä");
});

test("changing an amount needs no advanced controls opened", async ({
  page,
}) => {
  await page.goto("/recipes/1/edit");

  // Only the two lines that actually hold something rare are open — the range
  // and the second measurement. The ordinary ones are folded.
  await expect(page.locator("details.line-more[open]")).toHaveCount(2);
  await expect(
    page.locator(".line").nth(0).locator("details.line-more"),
  ).not.toHaveAttribute("open", "");

  await page.locator(".line").first().locator("input[name$=quantity]").fill("2");
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();

  await expect(page).toHaveURL(/\/recipes\/1$/);
  await expect(page.locator(".lines li").first()).toContainText("2 dl");
});

test("lines can be reordered by their position boxes", async ({ page }) => {
  await page.goto("/recipes/1/edit");

  // Reordering is a line-management action, so it lives under Lisätiedot.
  await openMore(page.locator(".line").nth(0));
  await openMore(page.locator(".line").nth(1));

  const positions = page.locator(".line input[name$=position]");
  await positions.nth(0).fill("2");
  await positions.nth(1).fill("1");
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();

  const lines = page.locator(".lines li");
  await expect(lines.nth(0)).toContainText("vesi");
  await expect(lines.nth(1)).toContainText("öljy");
});

test("a line can be removed", async ({ page }) => {
  await page.goto("/recipes/1/edit");
  const before = await page.locator(".lines li").count().catch(() => 0);
  expect(before).toBe(0); // we are on the editor, not the recipe

  await openMore(page.locator(".line").first());
  await page.locator(".line").first().locator('input[type=checkbox]').check();
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();

  await expect(page.locator(".lines li")).toHaveCount(3);
});

test("the approval gate applies to the editor too", async ({ page }) => {
  await page.goto("/recipes/1/edit");

  // A spare row with an amount but no ingredient answered. Spares are folded
  // away until asked for.
  await openSpareLines(page);
  const spare = page.locator(".line").nth(4);
  await spare.locator("input[name$=quantity]").first().fill("2");
  await spare.locator("input[name$=unit]").first().fill("rkl");
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();

  await expect(page.locator(".refused")).toContainText(
    "Jokaiselle uudelle ainekselle pitää vastata",
  );
});

test("deleting a dish says what goes with it", async ({ page }) => {
  // Recipe 3 is a lasagne: two parts, and deleting it takes them too.
  await page.goto("/recipes/3/delete");

  await expect(page.locator(".plain")).toContainText("Jauhelihakastike");
  await expect(page.locator(".plain")).toContainText("Juustokastike");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Poistetaanko",
  );
});

test("a recipe on the menu cannot be deleted", async ({ page }) => {
  await putOnMenu(page, "2026-11-02", "lunch", "Kaalilaatikko");

  await page.goto("/recipes/1/edit");
  await page.getByRole("link", { name: "Poista resepti" }).click();

  // Refused at the confirmation, before anything is asked of the reader.
  await expect(page.getByRole("heading", { name: "Ei voi poistaa" })).toBeVisible();
  await expect(page.locator(".refused")).toContainText("ruokalistalla");

  const api = await page.request.delete("/api/recipes/1");
  expect(api.status()).toBe(409);
});

test("deleting a recipe asks first", async ({ page }) => {
  await page.goto("/recipes/2/edit");
  await page.getByRole("link", { name: "Poista resepti" }).click();

  // Nothing is gone yet: this is a question, and it can be walked away from.
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Poistetaanko",
  );
  await page.getByRole("link", { name: "Peruuta" }).click();
  await expect(page).toHaveURL(/\/recipes\/2$/);

  const survived = await page.request.get("/api/recipes/2");
  expect(survived.status()).toBe(200);
});

test("a recipe that is on no menu can be deleted", async ({ page }) => {
  await page.goto("/recipes/2/edit");
  await page.getByRole("link", { name: "Poista resepti" }).click();
  await page.getByRole("button", { name: "Poista lopullisesti" }).click();

  await expect(page).toHaveURL(/\/recipes$/);
  const response = await page.request.get("/api/recipes/2");
  expect(response.status()).toBe(404);
});

test("another household cannot open or delete this editor", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await context.addCookies([sessionCookie(2)]);
  const page = await context.newPage();

  const response = await page.goto("/recipes/1/edit");
  expect(response?.status()).toBe(404);

  const api = await page.request.delete("/api/recipes/1");
  expect(api.status()).toBe(404);

  await context.close();
});

test.describe("ingredients", () => {
  test("the list is alphabetical with usage counts", async ({ page }) => {
    await page.goto("/ingredients");

    const rows = page.locator(".ingredients li");
    await expect(rows.first().locator(".ingredient-name")).toHaveText("ananas");
    await expect(rows.first()).toContainText("ei käytössä");
    await expect(rows.last().locator(".ingredient-name")).toHaveText("öljy");

    // The list reads; it does not sit there looking half-edited.
    await expect(rows.first().locator("input")).toBeHidden();
  });

  test("renaming an ingredient renames it everywhere", async ({ page }) => {
    await page.goto("/ingredients");
    const row = page.locator(".ingredients li", { hasText: "sitruunaruoho" });
    await row.locator("summary").click();
    await row.locator("input").fill("sitruunaruohoa");
    await row.getByRole("button", { name: "Tallenna" }).click();

    await expect(
      page.locator(".ingredients li", { hasText: "sitruunaruohoa" }),
    ).toHaveCount(1);

    await page.goto("/recipes/1");
    await expect(page.locator(".lines")).toContainText("sitruunaruohoa");
  });

  test("renaming onto a name that exists is refused, not merged", async ({
    page,
  }) => {
    await page.goto("/ingredients");
    const row = page.locator(".ingredients li", { hasText: "ananas" });
    await row.locator("summary").click();
    await row.locator("input").fill("Vesi");
    await row.getByRole("button", { name: "Tallenna" }).click();

    await expect(page.locator(".refused")).toContainText("on jo olemassa");
    // Both are still there, unmerged.
    await expect(
      page.locator(".ingredients li", { hasText: "ananas" }),
    ).toHaveCount(1);
  });

  test("an empty name is refused", async ({ page }) => {
    const response = await page.request.patch("/api/ingredients/1", {
      data: { name: "   " },
    });
    expect(response.status()).toBe(400);
  });

  test("another household cannot rename these", async ({ browser }) => {
    const context = await browser.newContext();
    await context.addCookies([sessionCookie(2)]);

    const response = await context.request.patch("/api/ingredients/1", {
      data: { name: "kaapattu" },
    });
    expect(response.status()).toBe(400);

    await context.close();
  });
});

async function putOnMenu(
  page: Page,
  date: string,
  slot: string,
  title: string,
): Promise<void> {
  await page.goto(`/picker?date=${date}&slot=${slot}`);
  await page
    .locator(".pick li", { hasText: title })
    .getByRole("button", { name: "Lisää" })
    .click();
  await expect(page).toHaveURL(/\/\?week=/);
}
