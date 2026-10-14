import { expect, test, type Page } from "@playwright/test";

import { reseed } from "./support/seed";
import { addAtSize } from "./support/blocks";
import { sessionCookie } from "./support/session";

/**
 * The dish to-do list at `/`, which replaced the meal calendar (#345). A dish
 * gets on it from its recipe page, leaves it when somebody taps Kokattu, and
 * the shopping list is worked out from the dishes on it.
 */

test.beforeEach(async ({ context }) => {
  await reseed();
  await context.addCookies([sessionCookie(1)]);
});

// The size beside the button, then the button (#364).
async function addFromRecipe(page: Page, recipeId: number, size: string): Promise<void> {
  await page.goto(`/recipes/${recipeId}`);
  await addAtSize(page, size);
  await expect(page).toHaveURL(/\/$/);
}

function row(page: Page, title: string) {
  return page.locator(".cook-item", { hasText: title });
}

test("an empty list says how a dish gets there", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Kokattavat", exact: true })).toBeVisible();
  await expect(page.locator(".cook-item")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Selaa reseptejä" })).toHaveAttribute("href", "/recipes");
  // No calendar left anywhere on it.
  await expect(page.locator(".week-block, .day, .slot-actions")).toHaveCount(0);
  await expect(page.locator("nav.tabs a").first()).toHaveText("Kokattavat");
});

test("a dish goes on the list from its recipe page, at the size tapped", async ({ page }) => {
  await addFromRecipe(page, 1, "1,5×");
  await addFromRecipe(page, 3, "1×");

  await expect(page.locator(".cook-item .cook-title")).toHaveText(["Kaalilaatikko", "Lasagne"]);
  await expect(row(page, "Kaalilaatikko").locator(".cook-size")).toHaveText("1,5×");

  // The row's own tap is the recipe, at this dish's size.
  await row(page, "Kaalilaatikko").locator(".cook-dish").click();
  await expect(page).toHaveURL(/\/recipes\/1\?multiplier=1\.5$/);
  await expect(page.locator(".recipe-top-size")).toContainText("1,5×");
});

test("one tap on the recipe page adds the dish at its usual size (#354)", async ({ page }) => {
  await page.goto("/recipes/1");
  await page.getByRole("button", { name: "Lisää kokattaviin" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(row(page, "Kaalilaatikko").locator(".cook-size")).toHaveText("1×");
});

test("the same dish twice is two cookings", async ({ page }) => {
  await addFromRecipe(page, 1, "1×");
  await addFromRecipe(page, 1, "2×");
  await expect(row(page, "Kaalilaatikko")).toHaveCount(2);
});

test("a part has nothing to add, it is cooked as part of its dish", async ({ page }) => {
  await page.goto("/recipes/4");
  await expect(page.getByRole("button", { name: /Lisää kokattaviin/ })).toHaveCount(0);
  const response = await page.request.post("/recipes/4/kokattaviin", {
    form: { preset: "1" },
  });
  expect(response.status()).toBe(404);
});

test("a nonsense size is shown as the usual one, and never added", async ({ page }) => {
  // Typed into the size box it is ignored rather than obeyed (#364)...
  await page.goto("/recipes/1#koko");
  const typed = page.locator("#koko input[name=multiplier]");
  await typed.fill("0");
  await typed.press("Enter");
  await expect(page.locator(".recipe-top-size")).toContainText("1×");

  // ...and posted straight at the add route it is refused.
  const response = await page.request.post("/recipes/1/kokattaviin", {
    form: { preset: "0" },
  });
  expect(response.status()).toBe(400);

  await page.goto("/");
  await expect(page.locator(".cook-item")).toHaveCount(0);
});

test("Muokkaa changes the size, or takes the dish off uncooked", async ({ page }) => {
  await addFromRecipe(page, 1, "1×");
  await row(page, "Kaalilaatikko").getByRole("link", { name: "Muokkaa: Kaalilaatikko" }).click();
  await page.locator(".multiplier-choice").getByRole("button", { name: "2×", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(row(page, "Kaalilaatikko").locator(".cook-size")).toHaveText("2×");

  await row(page, "Kaalilaatikko").getByRole("link", { name: "Muokkaa: Kaalilaatikko" }).click();
  await page.getByRole("button", { name: "Poista listalta kokkaamatta" }).click();
  await expect(page.locator(".cook-item")).toHaveCount(0);

  // Never cooked, so the history has nothing to say about it.
  await page.goto("/recipes");
  await expect(
    page.locator(".recipes li", { hasText: "Kaalilaatikko" }).locator(".meta").first(),
  ).toContainText("Ei vielä kokattu");
});

test("a refused size on Muokkaa hands back what was typed", async ({ page }) => {
  await addFromRecipe(page, 1, "1×");
  await row(page, "Kaalilaatikko").getByRole("link", { name: "Muokkaa: Kaalilaatikko" }).click();
  await page.locator(".multiplier-choice input").fill("0");
  await page.locator(".multiplier-choice").getByRole("button", { name: "Tallenna" }).click();
  await expect(page.locator(".refused")).toBeVisible();
  await expect(page.locator(".multiplier-choice input")).toHaveValue("0");
});

test("Kokattu takes the dish off and counts it as cooked", async ({ page }) => {
  await addFromRecipe(page, 1, "1×");
  await addFromRecipe(page, 3, "1×");
  await row(page, "Kaalilaatikko").getByRole("button", { name: "Kokattu: Kaalilaatikko" }).click();

  await expect(page.locator(".cook-item .cook-title")).toHaveText(["Lasagne"]);
  await page.goto("/recipes");
  await expect(
    page.locator(".recipes li", { hasText: "Kaalilaatikko" }).locator(".meta").first(),
  ).toContainText("Kokattu 1×");
});

test("the shopping list starts from every dish on the list, and can leave one out", async ({ page }) => {
  await addFromRecipe(page, 1, "1×");
  await addFromRecipe(page, 3, "1×");

  await page.goto("/ostoslista");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Ostoslista: Kaalilaatikko + Lasagne",
  );
  await expect(page.locator(".shopping-picker > summary")).toContainText("2/2 valittu");

  await page.locator(".shopping-picker > summary").click();
  await page.locator(".shopping-meals li", { hasText: "Lasagne" }).locator("input").uncheck();
  await page.getByRole("button", { name: "Päivitä lista" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ostoslista: Kaalilaatikko");
  await expect(page.locator(".shopping-picker > summary")).toContainText("1/2 valittu");

  // A cooked dish is no longer anything to shop for.
  await page.goto("/");
  await row(page, "Kaalilaatikko").getByRole("button", { name: "Kokattu: Kaalilaatikko" }).click();
  await page.goto("/ostoslista");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ostoslista: Lasagne");
});

test("an empty list leaves the shopping list nothing to add up", async ({ page }) => {
  await page.goto("/ostoslista");
  await expect(page.locator(".nothing .empty")).toHaveText("Kokattavien listalla ei ole yhtään ruokaa.");
});

test("the calendar's screens are gone", async ({ page }) => {
  for (const path of ["/picker?date=2026-10-05&slot=dinner", "/api/menu?from=2026-10-05&to=2026-10-05"]) {
    const response = await page.request.get(path);
    expect(response.status(), path).toBe(404);
  }
  // `?week=` is just ignored now: the list has no weeks.
  await page.goto("/?week=2026-10-05");
  await expect(page.getByRole("heading", { name: "Kokattavat", exact: true })).toBeVisible();
});

test("another household's dish is a 404, on the screen and on every action", async ({ page, browser }) => {
  const created = await page.request.post("/api/batches", { data: { recipeId: 1, multiplier: 1 } });
  expect(created.status()).toBe(201);
  const { id, instanceKey } = (await created.json()) as { id: number; instanceKey: string };

  const context = await browser.newContext();
  await context.addCookies([sessionCookie(2)]);
  const neighbour = await context.newPage();
  expect((await neighbour.goto(`/batches/${id}`))?.status()).toBe(404);
  for (const action of ["cooked", "delete", "multiplier"]) {
    const response = await neighbour.request.post(`/batches/${id}/${action}`, {
      form: { instanceKey, preset: "2" },
    });
    expect(response.status(), action).toBe(404);
  }
  await context.close();

  await page.goto("/");
  await expect(row(page, "Kaalilaatikko").locator(".cook-size")).toHaveText("1×");
});

test("the API lists, resizes, ticks and removes a dish", async ({ page }) => {
  const created = await page.request.post("/api/batches", { data: { recipeId: 3, multiplier: 2 } });
  const { id, instanceKey } = (await created.json()) as { id: number; instanceKey: string };

  const listed = await (await page.request.get("/api/batches")).json() as {
    batches: { id: number; title: string; multiplier: number }[];
  };
  expect(listed.batches.map(({ id, title, multiplier }) => ({ id, title, multiplier }))).toEqual([
    { id, title: "Lasagne", multiplier: 2 },
  ]);

  expect((await page.request.patch(`/api/batches/${id}`, { data: { instanceKey, multiplier: 1.5 } })).status()).toBe(204);
  expect((await page.request.patch(`/api/batches/${id}`, { data: { instanceKey, multiplier: 2, cooked: true } })).status()).toBe(400);
  expect((await page.request.patch(`/api/batches/${id}`, { data: { instanceKey, cooked: true } })).status()).toBe(204);
  expect((await page.request.patch(`/api/batches/${id}`, { data: { instanceKey, cooked: true } })).status()).toBe(404);

  const second = await page.request.post("/api/batches", { data: { recipeId: 1, multiplier: 1 } });
  const added = (await second.json()) as { id: number; instanceKey: string };
  expect((await page.request.delete(`/api/batches/${added.id}?instanceKey=${added.instanceKey}`)).status()).toBe(204);
  const empty = await (await page.request.get("/api/batches")).json() as { batches: unknown[] };
  expect(empty.batches).toEqual([]);
});
