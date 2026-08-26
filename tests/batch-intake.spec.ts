import { execFileSync } from "node:child_process";

import { expect, test, type Page } from "@playwright/test";

import { AGENTDECK_BATCH, batchCopy } from "./support/batch";
import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

test.beforeEach(async ({ context }) => {
  reseed();
  await context.addCookies([sessionCookie(1)]);
});

test("imports plain and multipart drafts through the shared save path", async ({ page }) => {
  await review(page, AGENTDECK_BATCH, true);

  await expect(page.getByRole("heading", { name: "Tarkista reseptinippu" })).toBeVisible();
  await expect(page.locator(".batch-titles li")).toHaveText([
    "AgentDeck-keitto",
    "AgentDeck-piirakka",
  ]);
  await expect(page.locator(".batch-ingredients label")).toHaveCount(1);
  await expect(page.locator(".batch-ingredients label")).toContainText("kikherne");
  await expect(page.locator('select[data-proposed-index="0"]')).toHaveAttribute(
    "name",
    "ingredient.0",
  );
  await expect(page.locator('input[name="ingredientKey.0"]')).toHaveValue(
    "kikherne",
  );
  await expect(page.locator(".batch-preview")).toHaveCount(2);
  await expect(page.locator(".needs-answer")).toContainText(
    "Veden lämpötilaa ei kerrottu",
  );

  const multipart = page.locator(".batch-preview").nth(1);
  await multipart.evaluate((details) => ((details as HTMLDetailsElement).open = true));
  await expect(multipart.getByRole("heading", { name: "Täyte" })).toBeVisible();
  await expect(multipart.getByRole("heading", { name: "Täyte" })).toHaveCount(1);
  const preview = (await multipart.textContent()) ?? "";
  expect(preview.indexOf("Voitele vuoka")).toBeLessThan(preview.indexOf("Täyte"));
  expect(preview.indexOf("Täyte")).toBeLessThan(preview.indexOf("Kokoa piirakka"));

  await page.getByRole("button", { name: "Tuo 2 reseptiä" }).click();
  await expect(page.getByRole("heading", { name: "Reseptit tuotu" })).toBeVisible();
  await expect(page.getByRole("link", { name: "AgentDeck-keitto" })).toBeVisible();
  await expect(page.getByRole("link", { name: "AgentDeck-piirakka" })).toBeVisible();

  const ingredients = await ingredientNames(page);
  expect(ingredients.filter((name) => name === "kikherne")).toHaveLength(1);
  expect(ingredients.filter((name) => name === "vesi")).toHaveLength(1);

  await page.getByRole("link", { name: "AgentDeck-piirakka" }).click();
  const content = await page.locator("main").innerText();
  expect(content.indexOf("Voitele vuoka")).toBeLessThan(content.indexOf("Täyte"));
  expect(content.indexOf("Täyte")).toBeLessThan(content.indexOf("Kokoa piirakka"));

  expect(provenanceRows()).toEqual([
    { title: "AgentDeck-keitto", source_route: "pasted", structured_by: "agentdeck/codex/gpt-5.6" },
    { title: "AgentDeck-piirakka", source_route: "pasted", structured_by: "agentdeck/codex/gpt-5.6" },
  ]);
});

test("repoints one proposed name everywhere to an existing ingredient", async ({ page }) => {
  const bundle = batchCopy();
  bundle.recipes = [bundle.recipes[0]];
  await review(page, bundle);

  await page.locator('select[data-proposed-index="0"]').selectOption({ label: "Käytä olemassa olevaa: ananas" });
  await page.getByRole("button", { name: "Tuo 1 reseptiä" }).click();
  await page.getByRole("link", { name: "AgentDeck-keitto" }).click();
  await expect(page.locator(".lines")).toContainText("ananas");
  expect(await ingredientNames(page)).not.toContain("kikherne");
});

test("refuses a reviewed repoint when exact-name resolution changed", async ({ page }) => {
  const bundle = batchCopy();
  bundle.recipes = [bundle.recipes[0]];
  await review(page, bundle);

  await page.locator('select[data-proposed-index="0"]').selectOption({
    label: "Käytä olemassa olevaa: ananas",
  });
  createIngredient("kikherne");
  await page.getByRole("button", { name: "Tuo 1 reseptiä" }).click();

  expect(await page.locator("main").textContent()).toContain(
    "Talouden ainekset muuttuivat tarkistamisen jälkeen",
  );
  expect(provenanceRows()).toEqual([]);
});

test("refuses duplicate titles within a bundle and in the household", async ({ page }) => {
  const within = batchCopy();
  within.recipes[1].title = "  agentdeck-KEITTO ";
  await review(page, within);
  await expect(page.locator(".refused")).toContainText("sama reseptin nimi kahdesti");

  const existing = batchCopy();
  existing.recipes = [existing.recipes[0]];
  existing.recipes[0].title = "kaalilaatikko";
  await review(page, existing);
  await expect(page.locator(".refused")).toContainText("on jo olemassa");
});

test("refuses malformed drafts and supplied production ingredient ids", async ({ page }) => {
  const malformed = batchCopy() as any;
  malformed.recipes[0].lines[0].quantity = "1";
  await review(page, malformed);
  await expect(page.locator(".refused")).toContainText("quantity must be a number or null");

  const incompleteAlternative = batchCopy();
  incompleteAlternative.recipes[0].lines[0].alt_quantity = 2;
  await review(page, incompleteAlternative);
  await expect(page.locator(".refused")).toContainText(
    "alt_quantity and alt_unit must both be set or both be null",
  );

  const incompleteAlternativeUnit = batchCopy();
  incompleteAlternativeUnit.recipes[0].lines[0].alt_unit = "g";
  await review(page, incompleteAlternativeUnit);
  await expect(page.locator(".refused")).toContainText(
    "alt_quantity and alt_unit must both be set or both be null",
  );

  const alternativeWithoutPrimary = batchCopy();
  alternativeWithoutPrimary.recipes[0].lines[0].quantity = null;
  alternativeWithoutPrimary.recipes[0].lines[0].alt_quantity = 2;
  alternativeWithoutPrimary.recipes[0].lines[0].alt_unit = "dl";
  await review(page, alternativeWithoutPrimary);
  await expect(page.locator(".refused")).toContainText(
    "alternative measurement requires quantity",
  );

  const supplied = batchCopy();
  supplied.recipes[0].lines[0].ingredient_id = 2;
  await review(page, supplied);
  await expect(page.locator(".refused")).toContainText("ingredient_id-arvojen pitää olla null");

  const invalidAmount = batchCopy();
  invalidAmount.recipes[0].lines[0].quantity = 0;
  await review(page, invalidAmount);
  await expect(page.locator(".refused")).toContainText(
    "Ainesmäärien pitää olla suurempia kuin nolla",
  );
});

test("refuses a generated source line that is not verbatim source text", async ({ page }) => {
  const bundle = batchCopy();
  bundle.recipes[0].lines[0].source_line = "1 litra vettä";
  await review(page, bundle);
  await expect(page.locator(".refused")).toContainText("ei löydy sanatarkasti");
});

test("caps collection counts and a tampered confirmation body", async ({ page }) => {
  const bundle = batchCopy() as any;
  const recipe = bundle.recipes[0];
  bundle.recipes = Array.from({ length: 101 }, (_, index) => ({
    ...recipe,
    title: `AgentDeck-keitto ${index + 1}`,
  }));
  await review(page, bundle);
  await expect(page.locator(".refused")).toContainText("enintään 100 reseptiä");

  const response = await page.request.post("/intake/batch/import", {
    form: { bundle: "x".repeat(2_000_001) },
  });
  expect(response.status()).toBe(413);

  const tooManyLines = batchCopy() as any;
  const line = tooManyLines.recipes[0].lines[0];
  tooManyLines.recipes = Array.from({ length: 6 }, (_, recipeIndex) => ({
    ...tooManyLines.recipes[0],
    title: `AgentDeck-rivit ${recipeIndex + 1}`,
    lines: Array.from({ length: 200 }, () => ({ ...line })),
  }));
  await review(page, tooManyLines);
  await expect(page.locator(".refused")).toContainText(
    "yhteensä enintään 1000 ainesriviä",
  );
});

test("a near-limit bundle survives review and confirmation encoding", async ({ page }) => {
  const bundle = batchCopy();
  bundle.recipes = [bundle.recipes[0]];
  bundle.recipes[0].source_text += `\n${"ä".repeat(400_000)}`;
  await review(page, bundle);

  await expect(page.locator('form[action="/intake/batch/import"]')).toHaveAttribute(
    "enctype",
    "multipart/form-data",
  );
  await page.getByRole("button", { name: "Tuo 1 reseptiä" }).click();
  await expect(page.getByRole("heading", { name: "Reseptit tuotu" })).toBeVisible();
});

async function review(page: Page, bundle: unknown, asFile = false) {
  await page.goto("/intake/batch");
  const json = JSON.stringify(bundle);
  if (asFile) {
    await page.getByLabel("JSON-tiedosto").setInputFiles({
      name: "recipes.json",
      mimeType: "application/json",
      buffer: Buffer.from(json),
    });
  } else {
    await page.getByLabel("…tai JSON tekstinä").fill(json);
  }
  await page.getByRole("button", { name: "Tarkista nippu" }).click();
}

async function ingredientNames(page: Page): Promise<string[]> {
  const response = await page.request.get("/api/ingredients");
  const body = (await response.json()) as { ingredients: { name: string }[] };
  return body.ingredients.map((ingredient) => ingredient.name);
}

function provenanceRows(): Array<Record<string, string>> {
  const output = execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "ruokalista",
      "--local",
      "--command",
      "SELECT title, source_route, structured_by FROM recipe WHERE parent_id IS NULL AND title LIKE 'AgentDeck-%' ORDER BY title",
      "--json",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  const result = JSON.parse(output) as Array<{ results: Array<Record<string, string>> }>;
  return result[0]?.results ?? [];
}

function createIngredient(name: string): void {
  execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "ruokalista",
      "--local",
      "--command",
      `INSERT INTO ingredient (household_id, name, created_by) VALUES (1, '${name.replaceAll("'", "''")}', 1)`,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
}
