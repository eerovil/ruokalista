import { expect, test, type Page } from "@playwright/test";

import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * The cupboard: what the household keeps in, how it gets there from the
 * shopping list, and what the list looks like once it has (#125).
 *
 * The seed holds no pantry rows on purpose, so every test starts from an empty
 * cupboard — which is where a household actually starts.
 */

test.beforeEach(async ({ context }) => {
  reseed();
  await context.addCookies([sessionCookie(1)]);
});

const KAALILAATIKKO = 1;

/** Today in Helsinki, which is what the Worker means by today. */
function today(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Helsinki",
  }).format(new Date());
}

async function planKaalilaatikko(page: Page): Promise<void> {
  const response = await page.request.post("/api/batches", {
    data: { date: today(), slot: "dinner", recipeId: KAALILAATIKKO, multiplier: 1 },
  });
  expect(response.status()).toBe(201);
}

function row(page: Page, name: string) {
  return page.locator(".shopping-list > li", { hasText: name }).first();
}

/** The section a row is in, read from the screen the way a person reads it. */
async function sectionOf(page: Page, name: string): Promise<string> {
  return page.evaluate((wanted) => {
    const rows = Array.from(document.querySelectorAll(".shopping-list > li"));
    const found = rows.find((one) => one.textContent?.includes(wanted));
    if (!found) return "missing";
    let heading = found.closest("ul")?.previousElementSibling ?? null;
    while (heading !== null && heading.tagName !== "H2") {
      heading = heading.previousElementSibling;
    }
    return heading?.textContent?.trim() ?? "single";
  }, name);
}

/** Move a row into or out of the cupboard from the list, as a person would. */
async function useRowButton(page: Page, name: string, label: string) {
  const item = row(page, name);
  await item.locator("summary").click();
  await item.getByRole("button", { name: label }).click();
}

test("a shopping-list row can be put in the cupboard from the list", async ({
  page,
}) => {
  await planKaalilaatikko(page);
  await page.goto("/ostoslista");

  // With an empty cupboard there is one plain list and no section headings.
  await expect(page.locator(".shopping-section")).toHaveCount(0);
  expect(await sectionOf(page, "öljy")).toBe("single");

  await useRowButton(page, "öljy", "Löytyy jo kaapista");

  // It has not disappeared; it has moved.
  expect(await sectionOf(page, "öljy")).toBe("Löytyy");
  expect(await sectionOf(page, "valkokaali")).toBe("Ostettavat");
});

test("a row in the Löytyy section keeps its total and its breakdown", async ({
  page,
}) => {
  await planKaalilaatikko(page);
  await page.goto("/ostoslista");
  await useRowButton(page, "öljy", "Löytyy jo kaapista");

  const oil = row(page, "öljy");
  await expect(oil.locator(".shopping-total")).toHaveText("½ dl");
  await oil.locator("summary").click();
  await expect(oil.locator(".shopping-from li")).toHaveCount(1);
  await expect(oil.locator(".shopping-from li").first()).toContainText(
    "Kaalilaatikko",
  );
});

test("the selected cookings survive a trip through the cupboard", async ({
  page,
}) => {
  await planKaalilaatikko(page);
  // A second cooking, unticked, so the selection is something other than the
  // default and a lost one would show.
  await page.request.post("/api/batches", {
    data: { date: today(), slot: "lunch", recipeId: 3, multiplier: 1 },
  });

  await page.goto("/ostoslista");
  await page.locator(".shopping-picker > summary").click();
  await page.locator(".shopping-meals input").last().uncheck();
  await page.getByRole("button", { name: "Päivitä lista" }).click();
  await expect(page.locator(".shopping-picker > summary")).toContainText(
    "1/2 valittu",
  );

  await useRowButton(page, "öljy", "Löytyy jo kaapista");

  await expect(page.locator(".shopping-picker > summary")).toContainText(
    "1/2 valittu",
  );
  expect(await sectionOf(page, "öljy")).toBe("Löytyy");
});

test("taking it back out puts the row back among the things to buy", async ({
  page,
}) => {
  await planKaalilaatikko(page);
  await page.goto("/ostoslista");
  await useRowButton(page, "öljy", "Löytyy jo kaapista");
  await useRowButton(page, "öljy", "Poista kaapista");

  await expect(page.locator(".shopping-section")).toHaveCount(0);
  expect(await sectionOf(page, "öljy")).toBe("single");
});

test("the cupboard page shows what is in it and nothing else", async ({
  page,
}) => {
  await planKaalilaatikko(page);
  await page.goto("/ostoslista");
  await useRowButton(page, "öljy", "Löytyy jo kaapista");

  await page.goto("/kaappi");
  // Not a catalogue: the household has ten ingredients and one of them is in
  // the cupboard.
  await expect(page.locator(".pantry li")).toHaveCount(1);
  await expect(page.locator(".pantry .ingredient-name")).toHaveText("öljy");
});

test("an empty cupboard says so and points at the list", async ({ page }) => {
  await page.goto("/kaappi");

  await expect(page.locator(".pantry")).toHaveCount(0);
  await expect(page.locator(".nothing")).toContainText("Kaappi on tyhjä");
  await expect(page.getByRole("link", { name: "Avaa ostoslista" })).toBeVisible();
});

test("a staple that ran out is removed on the cupboard page", async ({
  page,
}) => {
  await planKaalilaatikko(page);
  await page.goto("/ostoslista");
  await useRowButton(page, "öljy", "Löytyy jo kaapista");

  await page.goto("/kaappi");
  await page.getByRole("button", { name: "Loppui" }).click();
  await expect(page.locator(".nothing")).toContainText("Kaappi on tyhjä");

  // And it is wanted again on the next list.
  await page.goto("/ostoslista");
  expect(await sectionOf(page, "öljy")).toBe("single");
});

test("an ingredient with no pantry entry is bought as normal", async ({
  page,
}) => {
  await planKaalilaatikko(page);
  await page.goto("/ostoslista");
  await useRowButton(page, "öljy", "Löytyy jo kaapista");

  for (const name of ["vesi", "valkokaali", "sitruunaruoho"]) {
    expect(await sectionOf(page, name)).toBe("Ostettavat");
  }
});

test("the cupboard is one household's own", async ({ page, browser }) => {
  await planKaalilaatikko(page);
  await page.goto("/ostoslista");
  await useRowButton(page, "öljy", "Löytyy jo kaapista");

  const neighbour = await browser.newContext();
  await neighbour.addCookies([sessionCookie(2)]);
  const theirs = await neighbour.newPage();
  await theirs.goto("/kaappi");
  await expect(theirs.locator(".pantry li")).toHaveCount(0);
  await neighbour.close();
});

test("an ingredient nobody ever coined is not this household's to keep", async ({
  page,
}) => {
  // This used to be ingredient 6, on the grounds that it belonged to household
  // 2. The dictionary is global since #143 — a cupboard has to be able to hold
  // an ingredient a published recipe names, whoever first typed it — so the only
  // ingredient left to refuse is one that does not exist. The refusal says
  // nothing about which, exactly as before.
  const response = await page.request.post("/ostoslista/kaappi", {
    form: { aines: "999999" },
    maxRedirects: 0,
  });

  expect(response.status()).toBe(400);
  expect(await response.text()).toContain("Tuntematon aines");

  const removal = await page.request.post("/kaappi/999999/poista", {
    maxRedirects: 0,
  });
  expect(removal.status()).toBe(400);
  expect(await removal.text()).toContain("Tuntematon aines");
});

test("a cupboard may hold an ingredient another household coined", async ({
  page,
}) => {
  // Ingredient 6 is household 2's `naapurin suola`, and it is on the recipe
  // they published. Household 1 planning that recipe has to be able to say it
  // already has the salt in — which is the whole reason the dictionary went
  // global (#143). The cupboard row is still household 1's own.
  const added = await page.request.post("/ostoslista/kaappi", {
    form: { aines: "6" },
    maxRedirects: 0,
  });
  expect(added.status()).toBe(303);

  await page.goto("/kaappi");
  await expect(page.locator(".pantry li")).toContainText("naapurin suola");
});

test("putting the same staple in twice is not an error", async ({ page }) => {
  await planKaalilaatikko(page);
  await page.goto("/ostoslista");
  await useRowButton(page, "öljy", "Löytyy jo kaapista");

  const again = await page.request.post("/ostoslista/kaappi", {
    form: { aines: "1", valittu: "1" },
    maxRedirects: 0,
  });
  expect(again.status()).toBe(303);

  await page.goto("/kaappi");
  await expect(page.locator(".pantry li")).toHaveCount(1);
});
