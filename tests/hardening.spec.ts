import { expect, test, type Page } from "@playwright/test";

import { DRAFT_FIXTURE, stubStructuring } from "./support/draft";
import {
  addIngredientRow,
  openDraftEditor,
  openMore,
  openSpareLines,
} from "./support/lines";
import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/** Regression coverage for the cross-cutting failures found in code review. */

test.beforeAll(reseed);

test.beforeEach(async ({ context }) => {
  // These cases delete and rewrite the same seeded rows, so each starts from a
  // genuinely fresh database rather than depending on another test's leftovers.
  reseed();
  await context.addCookies([sessionCookie(1)]);
});

test("a rejected edit keeps every value the member submitted", async ({ page }) => {
  await page.goto("/recipes/1/edit");

  await page.locator("#title").fill("Nimi joka ei saa kadota");
  const first = page.locator(".line").first();
  await first.locator('input[name$=".quantity"]').fill("ei-numero");
  await openMore(first);
  await first.locator('input[name$=".source"]').fill("oma lähderivi");

  await page.getByRole("button", { name: "Tallenna muutokset" }).click();

  await expect(page.locator(".refused")).toContainText("Kelvoton luku");
  await expect(page.locator("#title")).toHaveValue("Nimi joka ei saa kadota");
  await expect(page.locator(".line").first().locator('input[name$=".quantity"]'))
    .toHaveValue("ei-numero");
  await expect(page.locator(".line").first().locator('input[name$=".source"]'))
    .toHaveValue("oma lähderivi");
});

test("an added editor row can create a genuinely new ingredient", async ({ page }) => {
  await page.goto("/recipes/1/edit");

  await addIngredientRow(page);
  const spare = page.locator(".line").nth(4);
  await spare.locator('input[name$=".quantity"]').fill("1");
  await openMore(spare);
  await spare.getByLabel("Yksikkö", { exact: true }).fill("tl");
  await spare.getByLabel("Uuden aineksen nimi").fill("sinappi");
  await spare.getByLabel("Lähderivi").fill("1 tl sinappia");
  await spare.getByLabel("Aines").selectOption("new");

  await page.getByRole("button", { name: "Tallenna muutokset" }).click();

  await expect(page).toHaveURL(/\/recipes\/1$/);
  await expect(page.locator(".lines")).toContainText("sinappi");

  const response = await page.request.get("/api/ingredients");
  const body = (await response.json()) as { ingredients: { name: string }[] };
  expect(body.ingredients.map((ingredient) => ingredient.name)).toContain("sinappi");
});

test("an editor opened before another save cannot overwrite it", async ({ page }) => {
  await page.goto("/recipes/1/edit");
  const newer = await page.context().newPage();
  await newer.goto("/recipes/1/edit");

  await newer.locator("#title").fill("Uudempi tallennus");
  await newer.locator(".line").first().locator('input[name$=".quantity"]').fill("2");
  await newer.getByRole("button", { name: "Tallenna muutokset" }).click();
  await expect(newer).toHaveURL(/\/recipes\/1$/);

  await page.locator("#title").fill("Vanhentunut tallennus");
  await page.locator(".line").first().locator('input[name$=".quantity"]').fill("3");
  const responsePromise = page.waitForResponse(
    (response) => response.url().endsWith("/recipes/1") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();
  expect((await responsePromise).status()).toBe(409);

  await expect(page.locator(".refused")).toContainText("muuttunut");
  await expect(page.locator("#title")).toHaveValue("Vanhentunut tallennus");

  const stored = await page.request.get("/api/recipes/1");
  const body = (await stored.json()) as {
    recipe: { title: string; lines: { quantity: number | null }[] };
  };
  expect(body.recipe.title).toBe("Uudempi tallennus");
  expect(body.recipe.lines[0]?.quantity).toBe(2);

  await newer.close();
});

test("a recipe part cannot be put on the menu through the JSON API", async ({
  page,
}) => {
  const response = await page.request.post("/api/batches", {
    data: {
      date: "2026-12-08",
      slot: "dinner",
      recipeId: 4,
      multiplier: 1,
    },
  });

  expect(response.status()).toBe(400);
});

test("deleting a multipart dish deletes its parts first", async ({ page }) => {
  const removed = await page.request.delete("/api/recipes/3");
  expect(removed.status()).toBe(204);

  for (const id of [3, 4, 5]) {
    const response = await page.request.get(`/api/recipes/${id}`);
    expect(response.status()).toBe(404);
  }
});

test("a photographed import keeps its route when it is saved", async ({ page }) => {
  await stubStructuring(page);
  await page.goto("/intake");
  await choosePhoto(page);

  await page.getByRole("button", { name: "Jäsennä" }).click();
  await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toBeVisible();
  await openDraftEditor(page);
  await page.locator(".line.is-new select").selectOption("new");
  await page.getByRole("button", { name: "Tallenna resepti" }).click();
  await expect(page).toHaveURL(/\/recipes\/\d+$/);

  const pathname = new URL(page.url()).pathname;
  const response = await page.request.get(`/api${pathname}`);
  const body = (await response.json()) as {
    recipe: { sourceRoute: string; sourceText: string };
  };
  expect(body.recipe.sourceRoute).toBe("photographed");
  // HTML form submission canonicalizes line endings to CRLF. The transcription
  // itself must be unchanged once line endings are compared canonically.
  expect(body.recipe.sourceText.replace(/\r\n/g, "\n")).toBe(
    DRAFT_FIXTURE.source_text,
  );
});

test("a forged line count is capped before it can consume the Worker", async ({
  page,
}) => {
  const response = await page.request.post("/recipes", {
    form: {
      title: "Liian monta riviä",
      yield: "4",
      sourceText: "Liian monta riviä",
      sourceRoute: "pasted",
      structuredBy: "test",
      lineCount: "999999999",
    },
  });

  expect(response.status()).toBe(400);
  expect(await response.text()).toContain("enintään 200");
});

test("deleting the highest old id does not let a new recipe reuse it", async ({
  page,
}) => {
  const removed = await page.request.delete("/api/recipes/2");
  expect(removed.status()).toBe(204);

  const saved = await page.request.post("/recipes", {
    maxRedirects: 0,
    form: {
      title: "Uusi resepti",
      yield: "2",
      sourceText: "Uusi resepti\n1 dl öljyä",
      sourceRoute: "pasted",
      structuredBy: "test",
      lineCount: "1",
      "line.0.quantity": "1",
      "line.0.quantityMax": "",
      "line.0.unit": "dl",
      "line.0.altQuantity": "",
      "line.0.altUnit": "",
      "line.0.section": "",
      "line.0.ingredient": "1",
      "line.0.newName": "öljy",
      "line.0.source": "1 dl öljyä",
    },
  });

  expect(saved.status()).toBe(302);
  const location = saved.headers()["location"];
  expect(location).toMatch(/^\/recipes\/\d+$/);
  expect(location).not.toBe("/recipes/2");
});

async function choosePhoto(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    canvas.getContext("2d")!.fillRect(0, 0, 10, 10);
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((value) => resolve(value!), "image/png"),
    );
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "sivu.png", { type: "image/png" }));
    const input = document.getElementById("photo") as HTMLInputElement;
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
