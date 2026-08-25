import { expect, test, type Page } from "@playwright/test";

import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * The week screen and the picker. Dates are computed the way the app does, so
 * these keep working next Tuesday.
 */

test.beforeAll(reseed);

test.beforeEach(async ({ context }) => {
  await context.addCookies([sessionCookie(1)]);
});

/** The Monday of a fixed week, well away from today's data. */
const MONDAY = "2026-10-05";

test("the week shows seven days, each with both slots", async ({ page }) => {
  await page.goto(`/?week=${MONDAY}`);

  await expect(page.locator(".day")).toHaveCount(7);
  await expect(page.locator(".day h2").first()).toContainText("maanantai");
  await expect(page.locator(".day h2").last()).toContainText("sunnuntai");
  await expect(page.locator(".slot")).toHaveCount(14);
  await expect(page.locator(".slot h3").first()).toHaveText("Lounas");
});

test("empty slots are the invitation", async ({ page }) => {
  await page.goto(`/?week=${MONDAY}`);
  await expect(page.locator(".empty-slot")).toHaveCount(14);
});

test("the arrows move a week at a time", async ({ page }) => {
  await page.goto(`/?week=${MONDAY}`);

  await page.getByRole("link", { name: /Seuraava/ }).click();
  await expect(page).toHaveURL(/week=2026-10-12$/);

  await page.getByRole("link", { name: /Edellinen/ }).click();
  await expect(page).toHaveURL(/week=2026-10-05$/);
});

test("a day in the middle of a week still lands on its Monday", async ({
  page,
}) => {
  // Thursday.
  await page.goto("/?week=2026-10-08");
  await expect(page.locator(".day h2").first()).toContainText("maanantai");
  await expect(page.locator(".day h2").first()).toContainText("5.10.");
});

test("putting a recipe on a day, changing it, and taking it off", async ({
  page,
}) => {
  await page.goto(`/?week=${MONDAY}`);

  // The empty slot leads to the picker for that day and meal.
  await page.locator(".day").first().locator(".empty-slot").first().click();
  await expect(page).toHaveURL(/\/picker\?date=2026-10-05&slot=lunch$/);
  await expect(page.getByRole("heading")).toContainText("Lounas 5.10.");

  // Portions default to the recipe's own yield.
  const row = page.locator(".pick li", { hasText: "Kaalilaatikko" });
  await expect(row.locator("input[name=portions]")).toHaveValue("4");
  await row.getByRole("button", { name: "Lisää" }).click();

  await expect(page).toHaveURL(/\/\?week=2026-10-05$/);
  const entry = page.locator(".day").first().locator(".entry");
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText("Kaalilaatikko");
  await expect(entry).toContainText("4 annosta");

  // The week itself carries no inputs and no delete buttons — the plan is for
  // reading. Everything you can do to a meal is one tap away.
  await expect(entry.locator("input")).toHaveCount(0);
  await expect(entry.getByRole("button")).toHaveCount(0);

  // Re-portion it on the focused surface.
  await entry.locator("a").click();
  await expect(page).toHaveURL(/\/meal-entries\/\d+$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Kaalilaatikko",
  );
  await expect(page.locator(".entry-when")).toContainText("Lounas");

  await page.locator("input[name=portions]").fill("6");
  await page.getByRole("button", { name: "Tallenna" }).click();

  // Back to the week that was being looked at, not to today's.
  await expect(page).toHaveURL(/\/\?week=2026-10-05$/);
  await expect(page.locator(".day").first().locator(".entry")).toContainText(
    "6 annosta",
  );

  // Cooking it opens the recipe at the amounts this meal needs.
  await page.locator(".day").first().locator(".entry a").click();
  await page.getByRole("link", { name: "Avaa resepti" }).click();
  await expect(page).toHaveURL(/\/recipes\/\d+\?portions=6$/);

  // And take it off again, from the same surface.
  await page.goBack();
  await page.getByRole("button", { name: "Poista ruokalistalta" }).click();
  await expect(page).toHaveURL(/\/\?week=2026-10-05$/);
  await expect(page.locator(".day").first().locator(".entry")).toHaveCount(0);
});

test("a nonsense meal entry is a 404, not a crash", async ({ page }) => {
  const response = await page.goto("/meal-entries/999999");
  expect(response?.status()).toBe(404);
});

test("another household's meal entry is a 404 on the screen too", async ({
  page,
  browser,
}) => {
  await addEntry(page, "2026-10-09", "dinner", "Kaalilaatikko");
  const listed = await page.request.get(
    "/api/menu?from=2026-10-09&to=2026-10-09",
  );
  const { entries } = (await listed.json()) as { entries: { id: number }[] };

  const context = await browser.newContext();
  await context.addCookies([sessionCookie(2)]);
  const neighbour = await context.newPage();

  const response = await neighbour.goto(`/meal-entries/${entries[0]!.id}`);
  expect(response?.status()).toBe(404);

  await context.close();
});

test("portions that make no sense keep you on the meal, with the reason", async ({
  page,
}) => {
  await addEntry(page, "2026-10-11", "lunch", "Kaalilaatikko");
  await page.locator(".day").last().locator(".entry a").click();

  await page.locator("input[name=portions]").fill("0");
  await page.getByRole("button", { name: "Tallenna" }).click();

  await expect(page.locator(".refused")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Kaalilaatikko",
  );
  // The refused value itself is handed back, not the stored one — it is
  // precisely what needs to be seen and corrected.
  await expect(page.locator("input[name=portions]")).toHaveValue("0");
});

test("a recipe with no yield falls back to the household default", async ({
  page,
}) => {
  await page.goto(`/picker?date=${MONDAY}&slot=dinner`);
  const row = page.locator(".pick li", { hasText: "Öljykastike" });
  await expect(row.locator("input[name=portions]")).toHaveValue("4");
});

test("a slot can hold more than one recipe", async ({ page }) => {
  await addEntry(page, "2026-10-06", "dinner", "Kaalilaatikko");
  await addEntry(page, "2026-10-06", "dinner", "Öljykastike");

  await page.goto(`/?week=${MONDAY}`);
  const tuesday = page.locator(".day").nth(1);
  await expect(tuesday.locator(".slot").nth(1).locator(".entry")).toHaveCount(2);
});

test("the picker searches, and can find nothing", async ({ page }) => {
  await page.goto(`/picker?date=${MONDAY}&slot=lunch&q=KAALI`);
  await expect(page.locator(".pick li")).toHaveCount(1);

  await page.goto(`/picker?date=${MONDAY}&slot=lunch&q=pizza`);
  await expect(page.locator(".empty")).toContainText("Haku ei löytänyt");
});

test("a picker with a nonsense day or meal is a 404", async ({ page }) => {
  let response = await page.goto("/picker?date=2026-02-31&slot=lunch");
  expect(response?.status()).toBe(404);

  response = await page.goto(`/picker?date=${MONDAY}&slot=brunssi`);
  expect(response?.status()).toBe(404);
});

test.describe("the JSON API", () => {
  test("a menu is a question about dates", async ({ page }) => {
    await addEntry(page, "2026-10-07", "lunch", "Kaalilaatikko");

    const response = await page.request.get(
      "/api/menu?from=2026-10-05&to=2026-10-11",
    );
    const body = (await response.json()) as {
      entries: { date: string; slot: string; title: string; portions: number }[];
    };

    const mine = body.entries.filter((e) => e.date === "2026-10-07");
    expect(mine).toHaveLength(1);
    expect(mine[0]?.slot).toBe("lunch");
    expect(mine[0]?.title).toBe("Kaalilaatikko");
  });

  test("a range that makes no sense is refused", async ({ page }) => {
    let response = await page.request.get("/api/menu?from=eilen&to=huomenna");
    expect(response.status()).toBe(400);

    response = await page.request.get(
      "/api/menu?from=2026-10-11&to=2026-10-05",
    );
    expect(response.status()).toBe(400);
  });

  test("portions must be a real count", async ({ page }) => {
    const response = await page.request.post("/api/meal-entries", {
      data: { date: "2026-10-09", slot: "lunch", recipeId: 1, portions: 0 },
    });
    expect(response.status()).toBe(400);
  });

  test("another household's recipe cannot be put on this menu", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await context.addCookies([sessionCookie(2)]);

    // Recipe 1 belongs to household 1, not to the neighbour.
    const response = await context.request.post("/api/meal-entries", {
      data: { date: "2026-10-09", slot: "lunch", recipeId: 1, portions: 2 },
    });
    expect(response.status()).toBe(400);

    await context.close();
  });

  test("another household's entry cannot be changed or removed", async ({
    page,
    browser,
  }) => {
    await addEntry(page, "2026-10-10", "dinner", "Kaalilaatikko");
    const listed = await page.request.get(
      "/api/menu?from=2026-10-10&to=2026-10-10",
    );
    const { entries } = (await listed.json()) as { entries: { id: number }[] };
    const id = entries[0]!.id;

    const context = await browser.newContext();
    await context.addCookies([sessionCookie(2)]);

    const patched = await context.request.patch(`/api/meal-entries/${id}`, {
      data: { portions: 99 },
    });
    expect(patched.status()).toBe(404);

    const deleted = await context.request.delete(`/api/meal-entries/${id}`);
    expect(deleted.status()).toBe(404);

    await context.close();
  });
});

async function addEntry(
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
