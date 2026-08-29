import { expect, test } from "@playwright/test";

import { DRAFT_FIXTURE, stubStructuring } from "./support/draft";
import { flatPng } from "./support/png";
import { reseed } from "./support/seed";
import { captureReview } from "./support/review-capture";
import { sessionCookie } from "./support/session";

const TARGET = {
  id: 1,
  title: "Kaalilaatikko",
  yieldPortions: 4,
  sourceText: "Kaalilaatikko\n½ dl öljyä\n1–1 ja ½ l vettä\n½ (500 g) valkokaali\nhieman sitruunaruohoa",
  sourceRoute: "pasted",
  sourceUrl: null,
  revision: 0,
  categories: [],
  parts: [],
  parentId: null,
  householdId: 1,
  householdName: "Koti",
  createdAt: "",
  createdBy: "Eero",
  yield: 4,
  imageKey: null,
  publishedAt: null,
  shareCount: 0,
  lines: [],
  steps: [],
};

test.describe.configure({ mode: "serial" });
test.beforeAll(reseed);

test.beforeEach(async ({ context }) => {
  await context.addCookies([sessionCookie(1)]);
});

test("an owned recipe opens the shared intake screen and updates in place", async ({
  page,
}) => {
  const calls = await stubStructuring(page, DRAFT_FIXTURE, { targetRecipe: TARGET });

  await page.goto("/recipes/1/edit");
  await page.getByRole("link", { name: "Täydennä AI:lla" }).click();
  await expect(page).toHaveURL(/\/intake\?recipe=1$/);
  await expect(page.getByRole("heading", { name: "Täydennä reseptiä" })).toBeVisible();
  await expect(page.getByText("Kaalilaatikko", { exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Täydennä nykyistä" })).toBeChecked();
  await captureReview(page, "docs/screenshots/103-intake-edit.png");

  await page.getByLabel("Kirjoita muutospyyntö tai liitä uutta reseptiaineistoa")
    .fill("Lisää puuttuva lisuke.");
  await page.getByRole("button", { name: "Muodosta resepti" }).click();

  expect(calls[0]?.body).toMatchObject({
    sourceText: "Lisää puuttuva lisuke.",
    recipeId: "1",
    mode: "extend",
  });
  await expect(page.getByRole("heading", { name: "Tarkista reseptin muutokset" }))
    .toBeVisible();
  await expect(page.getByText(/tallennus päivittää nykyisen reseptin/)).toBeVisible();
  await captureReview(page, "docs/screenshots/104-intake-edit-review.png");

  await page.locator('input[name="targetRecipeId"]').evaluate((input) => {
    (input as HTMLInputElement).value = "2";
  });
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();
  await expect(page.getByText("Muokattava resepti ei vastaa tarkistettua tuontia."))
    .toBeVisible();
  await page.locator('input[name="targetRecipeId"]').evaluate((input) => {
    (input as HTMLInputElement).value = "1";
  });
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();

  await expect(page).toHaveURL(/\/recipes\/1$/);
  await expect(page.getByRole("heading", { name: DRAFT_FIXTURE.title })).toBeVisible();
});

test("replace and photographed input use the same edit intake job", async ({ page }) => {
  const calls = await stubStructuring(page, DRAFT_FIXTURE, { targetRecipe: TARGET });
  await page.goto("/intake?recipe=1");
  await page.getByRole("radio", { name: "Korvaa resepti" }).check();
  await page.locator("#photo").setInputFiles({
    name: "resepti.png",
    mimeType: "image/png",
    buffer: flatPng(40, 40, [120, 80, 30]),
  });
  await page.getByRole("button", { name: "Muodosta resepti" }).click();

  await expect(page.getByRole("heading", { name: "Tarkista reseptin muutokset" }))
    .toBeVisible({ timeout: 15_000 });
  expect(calls[0]?.body.recipeId).toBe("1");
  expect(calls[0]?.body.mode).toBe("replace");
  expect(calls[0]?.body.images).toHaveLength(1);
  await expect(page.getByText(/Korvaa resepti/)).toBeVisible();
});

test("a web address is available in the same existing-recipe mode", async ({ page }) => {
  const calls = await stubStructuring(page, DRAFT_FIXTURE, {
    targetRecipe: TARGET,
    linkedText: "Uusi reseptiaineisto",
    linkedUrl: "https://example.com/resepti",
  });
  await page.goto("/intake?recipe=1");
  await page.getByLabel("…tai hae resepti nettiosoitteesta")
    .fill("https://example.com/resepti");
  await page.getByRole("button", { name: "Muodosta resepti" }).click();

  expect(calls[0]?.body).toMatchObject({
    recipeId: "1",
    mode: "extend",
    url: "https://example.com/resepti",
  });
  await expect(page.getByRole("heading", { name: "Tarkista reseptin muutokset" }))
    .toBeVisible();
});

test("another household's readable recipe cannot enter edit intake", async ({ page }) => {
  await page.goto("/recipes/6");
  await expect(page.getByRole("link", { name: "Täydennä AI:lla" })).toHaveCount(0);
  const response = await page.goto("/intake?recipe=6");
  expect(response?.status()).toBe(404);
  const started = await page.request.post("/api/intake/imports", {
    data: { sourceText: "Muuta tämä", recipeId: 6, mode: "extend" },
  });
  expect(started.status()).toBe(400);
});
