import { expect, test } from "@playwright/test";

import { recipeWire } from "../src/recipe-prompt-edit";
import { DRAFT_FIXTURE, stubStructuring } from "./support/draft";
import {
  JAUHELIHAKASTIKE,
  KAALILAATIKKO as TARGET,
  LASAGNE,
} from "./support/edit-targets";
import { flatPng } from "./support/png";
import { executeLocalSql, reseed } from "./support/seed";
import { captureReview } from "./support/review-capture";
import { sessionCookie } from "./support/session";

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

for (const mode of ["extend", "replace"] as const) {
  const article = mode === "extend" ? "an" : "a";
  test(`${article} ${mode} edit cannot give a recipe part another nested part`, async ({
    page,
  }) => {
    const nestedDraft = {
      title: "Jauhelihakastike",
      yield_portions: null,
      source_text: "Jauhelihakastike\nPaistopohja\n1 rkl öljyä",
      steps: [
        {
          text: "Kuumenna öljy.",
          section: "Paistopohja",
          phase: null,
          ingredient_refs: [
            { line: 0, matched_text: "öljy", approx_position: 8 },
          ],
        },
      ],
      lines: [
        {
          quantity: 1,
          quantity_max: null,
          unit: "rkl",
          alt_quantity: null,
          alt_unit: null,
          ingredient_id: 1,
          ingredient_name: "öljy",
          source_line: "1 rkl öljyä",
          section: "Paistopohja",
          phase: null,
          note: "Mallin ehdottama uusi osa.",
        },
      ],
    };
    await stubStructuring(page, nestedDraft, {
      targetRecipe: JAUHELIHAKASTIKE,
    });

    await page.goto("/intake?recipe=4");
    if (mode === "replace") {
      await page.getByRole("radio", { name: "Korvaa resepti" }).check();
    }
    await page.getByLabel("Kirjoita muutospyyntö tai liitä uutta reseptiaineistoa")
      .fill("Lisää paistopohja.");
    await page.getByRole("button", { name: "Muodosta resepti" }).click();
    await expect(page.getByRole("heading", { name: "Tarkista reseptin muutokset" }))
      .toBeVisible();
    await expect(page.locator('input[name="line.0.section"]'))
      .toHaveValue("Paistopohja");

    await page.getByRole("button", { name: "Tallenna muutokset" }).click();

    await expect(page.locator(".refused")).toContainText(
      "Reseptin osalle ei voi lisätä omia osia",
    );
    await expect(page.locator('input[name="line.0.section"]'))
      .toHaveValue("Paistopohja");
    await expect(page.locator('input[name="line.0.note"]'))
      .toHaveValue("Mallin ehdottama uusi osa.");
    if (mode === "extend") {
      await captureReview(page, "docs/screenshots/116-nested-part-refused.png");
    }

    await page.goto("/recipes/4");
    await expect(page.locator("main")).toContainText("400 g");
    await expect(page.locator("main")).toContainText("Ruskista jauheliha.");
    await expect(page.locator(".part")).toHaveCount(0);
  });
}

test("a valid top-level multipart AI edit still saves every part", async ({
  page,
}) => {
  await stubStructuring(page, recipeWire(LASAGNE), { targetRecipe: LASAGNE });

  await page.goto("/intake?recipe=3");
  await page.getByLabel("Kirjoita muutospyyntö tai liitä uutta reseptiaineistoa")
    .fill("Pidä osat ennallaan.");
  await page.getByRole("button", { name: "Muodosta resepti" }).click();
  await expect(page.getByRole("heading", { name: "Tarkista reseptin muutokset" }))
    .toBeVisible();
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();

  await expect(page).toHaveURL(/\/recipes\/3$/);
  const parts = page.locator(".part");
  await expect(parts).toHaveCount(2);
  await expect(parts.nth(0)).toContainText("400 g");
  await expect(parts.nth(0)).toContainText("Ruskista jauheliha.");
  await expect(parts.nth(1)).toContainText("5 dl");
  await expect(parts.nth(1)).toContainText("Kuumenna maito");
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

test("case variants replace one existing part without losing children", async ({
  page,
}) => {
  // #258's preceding multipart edit deliberately advances this same recipe.
  // Restore #257's baseline so this case exercises section identity, not a
  // stale revision left by another regression scenario in the merged file.
  reseed();

  const proposal = {
    title: "Lasagne",
    yield_portions: 6,
    source_text: "",
    steps: [
      { text: "Kokoa vuokaan.", section: null, phase: "after_parts", ingredient_refs: [] },
      {
        text: "Kuumenna maito ja juusto.",
        section: " juustokastike ",
        phase: null,
        ingredient_refs: [
          { line: 1, matched_text: "maito", approx_position: 9 },
          { line: 2, matched_text: "juusto", approx_position: 18 },
        ],
      },
      { text: "Sekoita tasaiseksi.", section: "JUUSTOKASTIKE", phase: null, ingredient_refs: [] },
    ],
    lines: [
      {
        quantity: 12, quantity_max: null, unit: "kpl",
        alt_quantity: null, alt_unit: null,
        ingredient_id: 10, ingredient_name: "lasagnelevy",
        source_line: "12 lasagnelevyä", section: null,
        phase: "after_parts", alternative_group: null, note: null,
      },
      {
        quantity: 5, quantity_max: null, unit: "dl",
        alt_quantity: null, alt_unit: null,
        ingredient_id: 9, ingredient_name: "maito",
        source_line: "5 dl maitoa", section: "Juustokastike",
        phase: null, alternative_group: 3, note: null,
      },
      {
        quantity: 2, quantity_max: null, unit: "dl",
        alt_quantity: null, alt_unit: null,
        ingredient_id: 8, ingredient_name: "juusto",
        source_line: "2 dl juustoa", section: " juustokastike ",
        phase: null, alternative_group: 3, note: null,
      },
    ],
  };

  await stubStructuring(page, proposal, { targetRecipe: LASAGNE });
  await page.goto("/intake?recipe=3");
  await page.getByRole("radio", { name: "Korvaa resepti" }).check();
  await page.getByLabel("Kirjoita muutospyyntö tai liitä uutta reseptiaineistoa")
    .fill("Yhdistä kastikkeen kirjoitusasut.");
  await page.getByRole("button", { name: "Muodosta resepti" }).click();
  const reviewedSauce = page.locator("section.part", { hasText: "Juustokastike" });
  await expect(reviewedSauce).toHaveCount(1);
  await expect(reviewedSauce).toContainText("Kuumenna maito ja juusto.");
  await expect(reviewedSauce).toContainText("Sekoita tasaiseksi.");
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();

  await expect(page).toHaveURL("/recipes/3");
  const sauce = page.locator(".part", { hasText: "Juustokastike" });
  await expect(sauce).toHaveCount(1);
  await expect(sauce.locator("h2")).toHaveText("Juustokastike");
  await expect(sauce.locator(".lines li")).toHaveCount(1);
  await expect(sauce.locator(".lines")).toContainText("5 dl maito tai 2 dl juusto");
  await expect(sauce.locator(".steps li")).toHaveCount(2);
  await expect(sauce.locator(".steps li").first())
    .toContainText("Kuumenna");
  await expect(sauce).toContainText("Sekoita tasaiseksi.");
  await expect(sauce.locator(".mention")).toHaveCount(2);

  await page.goto("/recipes/5/edit");
  await expect(page.locator('input[name="revision"]')).toHaveValue("1");

  const today = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Helsinki",
  }).format(new Date());
  const planned = await page.request.post("/api/batches", {
    data: { date: today, slot: "dinner", recipeId: 3, multiplier: 1 },
  });
  expect(planned.status()).toBe(201);
  await page.goto("/ostoslista");
  await expect(
    page.locator(".shopping-list > li", { hasText: "maito" })
      .locator(".shopping-total"),
  ).toHaveText("5 dl");
  await expect(
    page.locator(".shopping-list .shopping-name", { hasText: /^juusto$/ }),
  ).toHaveCount(0);
});

test("ambiguous existing part titles refuse and preserve the proposal", async ({
  page,
}) => {
  const proposal = {
    title: "Lasagne",
    yield_portions: 6,
    source_text: "",
    steps: [
      {
        text: "Kuumenna maito.",
        section: "Juustokastike",
        phase: null,
        ingredient_refs: [],
      },
    ],
    lines: [
      {
        quantity: 5, quantity_max: null, unit: "dl",
        alt_quantity: null, alt_unit: null,
        ingredient_id: 9, ingredient_name: "maito",
        source_line: "5 dl maitoa", section: "Juustokastike",
        phase: null, alternative_group: null, note: null,
      },
    ],
  };

  await stubStructuring(page, proposal, { targetRecipe: LASAGNE });
  await page.goto("/intake?recipe=3");
  await page.getByLabel("Kirjoita muutospyyntö tai liitä uutta reseptiaineistoa")
    .fill("Päivitä kastike.");
  await page.getByRole("button", { name: "Muodosta resepti" }).click();

  executeLocalSql(`
    INSERT INTO recipe
      (id, household_id, title, yield_portions, source_text, source_route,
       created_by, updated_by, parent_id, part_position)
    VALUES (50, 1, 'juustokastike', NULL, 'Lasagne', 'pasted', 1, 1, 3, 3)
  `);

  await page.getByRole("button", { name: "Tallenna muutokset" }).click();
  await expect(page.locator(".refused")).toContainText(
    "Reseptin osia ei voi tunnistaa yksiselitteisesti.",
  );
  await expect(page.locator('input[name="line.0.section"]'))
    .toHaveValue("Juustokastike");
  await expect(page.locator('textarea[name="step.0"]'))
    .toHaveValue("Kuumenna maito.");

  reseed();
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
