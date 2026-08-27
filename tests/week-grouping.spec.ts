import { expect, test, type Page } from "@playwright/test";

import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * The grouped week: one card per cooked batch however many meals it feeds,
 * no left-hand timeline rail, and today made obvious in the current week.
 *
 * "Today" is today in Helsinki, the same way `src/dates.ts` decides it, so
 * these keep working whichever day they are run on.
 */

const MONDAY = "2026-12-07";

test.beforeAll(reseed);

test.beforeEach(async ({ context }) => {
  await context.addCookies([sessionCookie(1)]);
});

test("a batch spanning three days is one card with three occurrence rows", async ({
  page,
}) => {
  const spanning = await createBatch(page, MONDAY, "lunch", 1);
  await setCoverage(page, spanning, [
    ["2026-12-07", "lunch"],
    ["2026-12-08", "dinner"],
    ["2026-12-09", "lunch"],
    ["2026-12-09", "dinner"],
  ]);
  const alongside = await createBatch(page, MONDAY, "dinner", 2);
  await setCoverage(page, alongside, [
    ["2026-12-07", "dinner"],
    ["2026-12-08", "lunch"],
  ]);

  await page.goto(`/?week=${MONDAY}`);

  const card = page.locator(`.batch-card[data-batch-id="${spanning}"]`);
  await expect(card).toHaveCount(1);
  await expect(card.locator(".entry-title")).toHaveText("Kaalilaatikko");
  await expect(card.locator(".batch-start")).toHaveText("Kokataan · 4 annosta");
  await expect(card.locator(".batch-when-date")).toHaveText([
    "ma 7.12.",
    "ti 8.12.",
    "ke 9.12.",
  ]);
  await expect(card.locator(".batch-when-slots")).toHaveText([
    "Lounas",
    "Päivällinen",
    "Lounas · Päivällinen",
  ]);
  await expect(card.locator(".batch-end")).toHaveText("viimeinen annos");

  // Both cards are anchored on Monday, and neither reappears further down.
  const days = page.locator(".day");
  await expect(days.nth(0).locator(".batch-card")).toHaveCount(2);
  await expect(days.nth(1).locator(".batch-card")).toHaveCount(0);
  await expect(days.nth(2).locator(".batch-card")).toHaveCount(0);
  await expect(page.locator(".batch-card")).toHaveCount(2);

  // The card is still the way into everything you can do to the batch.
  await card.locator(".entry a").click();
  await expect(page).toHaveURL(new RegExp(`/batches/${spanning}$`));
  await expect(page.getByRole("link", { name: "Jatkuu…" })).toBeVisible();
});

test("the left-hand timeline rail is gone", async ({ page }) => {
  const id = await createBatch(page, MONDAY, "lunch", 1);
  await setCoverage(page, id, [
    ["2026-12-07", "lunch"],
    ["2026-12-08", "lunch"],
  ]);

  await page.goto(`/?week=${MONDAY}`);
  await expect(page.locator(".batch-rail")).toHaveCount(0);
  await expect(page.locator(".batch-track")).toHaveCount(0);
  await expect(page.locator(".batch-rail-line")).toHaveCount(0);
});

test("a batch open at either visible edge says so instead of ending", async ({
  page,
}) => {
  const fromPreviousWeek = await createBatch(page, "2026-12-06", "dinner", 1);
  await setCoverage(page, fromPreviousWeek, [
    ["2026-12-06", "dinner"],
    ["2026-12-07", "lunch"],
    ["2026-12-08", "dinner"],
  ]);
  const intoNextWeek = await createBatch(page, "2026-12-11", "lunch", 2);
  await setCoverage(page, intoNextWeek, [
    ["2026-12-11", "lunch"],
    ["2026-12-12", "lunch"],
    ["2026-12-13", "dinner"],
    ["2026-12-14", "lunch"],
  ]);

  await page.goto(`/?week=${MONDAY}`);

  const carried = page.locator(`.batch-card[data-batch-id="${fromPreviousWeek}"]`);
  await expect(carried.locator(".batch-carried")).toHaveText("Kokattu 6.12. · 4 annosta");
  await expect(carried.locator(".batch-start")).toHaveCount(0);
  await expect(carried.locator(".batch-end")).toHaveText("viimeinen annos");

  const onward = page.locator(`.batch-card[data-batch-id="${intoNextWeek}"]`);
  await expect(onward.locator(".batch-start")).toHaveText("Kokataan · 4 annosta");
  await expect(onward.locator(".batch-onward")).toHaveText("jatkuu ensi viikolle");
  await expect(onward.locator(".batch-end")).toHaveCount(0);
});

test("every day keeps its own add action, with no duplicated wording", async ({
  page,
}) => {
  const id = await createBatch(page, MONDAY, "lunch", 1);
  await setCoverage(page, id, [
    ["2026-12-07", "lunch"],
    ["2026-12-08", "lunch"],
  ]);

  await page.goto(`/?week=${MONDAY}`);
  await expect(page.locator(".slot-actions a")).toHaveCount(14);
  await expect(page.getByRole("link", { name: "+ Lisää toinen" })).toHaveCount(0);
  const monday = page.locator(".day").first();
  await expect(monday.locator(".slot-actions a")).toHaveText([
    "+ Lounas",
    "+ Päivällinen",
  ]);
  await monday.locator(".slot-actions a").first().click();
  await expect(page).toHaveURL(/\/picker\?date=2026-12-07&slot=lunch$/);
});

test("the current week marks today and opens on it", async ({ page }) => {
  const now = helsinkiToday();
  const id = await createBatch(page, now, "lunch", 1);
  await setCoverage(page, id, [
    [now, "lunch"],
    [addDays(now, 1), "lunch"],
  ]);

  await page.goto("/");

  const today = page.locator(".day.is-today");
  await expect(today).toHaveCount(1);
  await expect(today).toHaveAttribute("id", "tanaan");
  await expect(today.locator(".today-badge")).toHaveText("Tänään");
  await expect(today.locator(`.batch-card[data-batch-id="${id}"]`)).toHaveCount(1);

  // Today's section is in view when the week opens, wherever in the week it is.
  const box = await today.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeLessThan(viewport.height);

  // And there is a way back to it after scrolling away.
  await page.getByRole("link", { name: "Tänään" }).first().click();
  await expect(page).toHaveURL(/#tanaan$/);
});

test("browsing another week neither marks nor jumps to a day", async ({
  page,
}) => {
  const id = await createBatch(page, MONDAY, "lunch", 1);
  await setCoverage(page, id, [
    ["2026-12-07", "lunch"],
    ["2026-12-08", "lunch"],
  ]);

  await page.goto(`/?week=${MONDAY}`);
  await expect(page.locator(".day.is-today")).toHaveCount(0);
  await expect(page.locator("#tanaan")).toHaveCount(0);
  await expect(page.locator("nav.weeks")).toContainText("Tämä viikko");
  expect(await page.evaluate(() => window.pageYOffset)).toBe(0);
});

test("a week of grouped cards keeps usable phone-width cards", async ({
  page,
}) => {
  for (let index = 0; index < 10; index += 1) {
    const id = await createBatch(
      page,
      MONDAY,
      index % 2 === 0 ? "lunch" : "dinner",
      index % 2 === 0 ? 1 : 2,
    );
    await setCoverage(page, id, [
      ["2026-12-07", index % 2 === 0 ? "lunch" : "dinner"],
      ["2026-12-08", index % 2 === 0 ? "dinner" : "lunch"],
      ["2026-12-09", index % 2 === 0 ? "lunch" : "dinner"],
    ]);
  }

  await page.goto(`/?week=${MONDAY}`);

  const dimensions = await page.evaluate(() => ({
    cardWidth: document.querySelector(".entry a")!.getBoundingClientRect().width,
    pageWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(dimensions.pageWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
  expect(dimensions.cardWidth).toBeGreaterThanOrEqual(270);
});

function helsinkiToday(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Helsinki",
  }).format(new Date());
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const at = new Date(Date.UTC(year, month - 1, day));
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

async function createBatch(
  page: Page,
  date: string,
  slot: "lunch" | "dinner",
  recipeId: number,
): Promise<number> {
  const response = await page.request.post("/api/batches", {
    data: { date, slot, recipeId, portions: 4 },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { id: number }).id;
}

async function setCoverage(
  page: Page,
  id: number,
  occurrences: Array<[string, "lunch" | "dinner"]>,
): Promise<void> {
  const response = await page.request.patch(`/api/batches/${id}`, {
    data: {
      occurrences: occurrences.map(([date, slot]) => ({ date, slot })),
    },
  });
  expect(response.status()).toBe(204);
}
