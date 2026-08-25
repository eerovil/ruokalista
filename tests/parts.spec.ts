import { expect, test } from "@playwright/test";

import { DRAFT_FIXTURE, stubStructuring } from "./support/draft";
import { openDraftEditor } from "./support/lines";
import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * A dish written in named parts. See docs/adr/0002-a-part-is-a-recipe.md — a
 * part is not a new kind of record, it is a recipe with a parent.
 */

test.beforeAll(reseed);

test.beforeEach(async ({ context }) => {
  await context.addCookies([sessionCookie(1)]);
});

test("a dish shows each part with its own ingredients and method", async ({
  page,
}) => {
  await page.goto("/recipes/3");

  const parts = page.locator(".part");
  await expect(parts).toHaveCount(2);
  await expect(parts.nth(0).locator("h2")).toHaveText("Jauhelihakastike");
  await expect(parts.nth(1).locator("h2")).toHaveText("Juustokastike");

  // Each part's quantities belong to it, not to a pooled list.
  await expect(parts.nth(0)).toContainText("400 g");
  await expect(parts.nth(0)).toContainText("jauheliha");
  await expect(parts.nth(1)).toContainText("5 dl");
  await expect(parts.nth(1)).toContainText("maito");
  await expect(parts.nth(0)).not.toContainText("maito");

  await expect(parts.nth(0)).toContainText("Ruskista jauheliha.");
  await expect(parts.nth(1)).toContainText("sulata juusto");
});

test("what belongs to the dish itself stays on the dish", async ({ page }) => {
  await page.goto("/recipes/3");
  // The assembly step is the lasagne's, not either sauce's.
  await expect(page.locator(".part").first()).not.toContainText("Kokoa vuokaan");
  await expect(page.locator("body")).toContainText("Kokoa vuokaan");
});

test("parts are not dishes, so they are not listed or plannable", async ({
  page,
}) => {
  await page.goto("/recipes");
  await expect(page.locator(".recipes li")).toHaveCount(3);
  await expect(page.locator(".recipes")).not.toContainText("Jauhelihakastike");

  await page.goto("/picker?date=2026-12-07&slot=lunch");
  await expect(page.locator(".pick li")).toHaveCount(3);
  await expect(page.locator(".pick")).not.toContainText("Juustokastike");
});

test("a part can still be opened and edited on its own", async ({ page }) => {
  await page.goto("/recipes/4");
  await expect(page.getByRole("heading", { name: "Jauhelihakastike" })).toBeVisible();

  await page.goto("/recipes/4/edit");
  await expect(page.locator("#title")).toHaveValue("Jauhelihakastike");
  // A part's own lines carry no part of their own — one level only.
  await expect(page.locator(".line input[name$=section]")).toHaveCount(0);
});

test("a plain recipe renders exactly as before", async ({ page }) => {
  await page.goto("/recipes/1");
  await expect(page.locator(".part")).toHaveCount(0);
  await expect(page.locator(".lines li")).toHaveCount(4);
});

test("importing a page with sub-headings creates the parts", async ({ page }) => {
  const draft = {
    title: "Lasagne",
    yield_portions: 6,
    source_text: "Lasagne\nJauhelihakastike\n400 g jauhelihaa\nJuustokastike\n5 dl maitoa",
    steps: [
      { text: "Ruskista jauheliha.", section: "Jauhelihakastike" },
      { text: "Kuumenna maito.", section: "Juustokastike" },
      { text: "Kokoa vuokaan.", section: null },
    ],
    lines: [
      {
        quantity: 400, quantity_max: null, unit: "g",
        alt_quantity: null, alt_unit: null,
        ingredient_id: 7, ingredient_name: "jauheliha",
        source_line: "400 g jauhelihaa", section: "Jauhelihakastike",
      },
      {
        quantity: 5, quantity_max: null, unit: "dl",
        alt_quantity: null, alt_unit: null,
        ingredient_id: 9, ingredient_name: "maito",
        source_line: "5 dl maitoa", section: "Juustokastike",
      },
    ],
  };

  await stubStructuring(page, draft);
  await page.goto("/intake");
  await page.getByLabel("Liitä reseptin teksti").fill("Lasagne");
  await page.getByRole("button", { name: "Jäsennä" }).click();
  await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toBeVisible();

  // The correction screen shows which part the model put each line in.
  const sections = page.locator(".line input[name$=section]");
  await expect(sections.nth(0)).toHaveValue("Jauhelihakastike");
  await expect(sections.nth(1)).toHaveValue("Juustokastike");

  await page.getByRole("button", { name: "Tallenna resepti" }).click();
  await expect(page).toHaveURL(/\/recipes\/\d+$/);

  const parts = page.locator(".part");
  await expect(parts).toHaveCount(2);
  await expect(parts.nth(0).locator("h2")).toHaveText("Jauhelihakastike");
  await expect(parts.nth(0)).toContainText("400 g");
  await expect(parts.nth(1)).toContainText("5 dl");
  // The step that belonged to no part stayed with the dish.
  await expect(page.locator("body")).toContainText("Kokoa vuokaan.");
  await expect(parts.nth(0)).not.toContainText("Kokoa vuokaan.");

  // And the dish is listed while its parts are not.
  await page.goto("/recipes");
  await expect(page.locator(".recipes")).toContainText("Lasagne");
});

test("correcting a part name before saving moves the lines", async ({ page }) => {
  await stubStructuring(page, {
    ...DRAFT_FIXTURE,
    lines: DRAFT_FIXTURE.lines.map((line, index) => ({
      ...line,
      ingredient_id: index === 4 ? 1 : line.ingredient_id,
      section: index < 2 ? "Kastike" : null,
    })),
  });

  await page.goto("/intake");
  await page.getByLabel("Liitä reseptin teksti").fill("Uunikaali");
  await page.getByRole("button", { name: "Jäsennä" }).click();

  // Rename the part on both of its lines.
  await openDraftEditor(page);
  const sections = page.locator(".line input[name$=section]");
  await sections.nth(0).fill("Öljykastike");
  await sections.nth(1).fill("Öljykastike");

  await page.getByRole("button", { name: "Tallenna resepti" }).click();
  await expect(page).toHaveURL(/\/recipes\/\d+$/);

  await expect(page.locator(".part")).toHaveCount(1);
  await expect(page.locator(".part h2")).toHaveText("Öljykastike");
  await expect(page.locator(".part")).toContainText("öljy");
  await expect(page.locator(".part")).toContainText("vesi");
});

test("a dish with no sub-headings makes no parts", async ({ page }) => {
  await stubStructuring(page);
  await page.goto("/intake");
  await page.getByLabel("Liitä reseptin teksti").fill("Uunikaali");
  await page.getByRole("button", { name: "Jäsennä" }).click();
  await page.getByRole("button", { name: "Tallenna resepti" }).click();

  await expect(page).toHaveURL(/\/recipes\/\d+$/);
  await expect(page.locator(".part")).toHaveCount(0);
  await expect(page.locator(".lines li")).toHaveCount(5);
});
