import { expect, test, type Page } from "@playwright/test";

import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

const MONDAY = "2026-12-07";

test.beforeAll(reseed);

test.beforeEach(async ({ context }) => {
  await context.addCookies([sessionCookie(1)]);
});

test("multi-day rails join at day boundaries and overlapping batches use separate lanes", async ({
  page,
}) => {
  const lunches = await createBatch(page, MONDAY, "lunch", 1);
  await setCoverage(page, lunches, [
    ["2026-12-07", "lunch"],
    ["2026-12-08", "dinner"],
    ["2026-12-09", "lunch"],
  ]);

  const dinners = await createBatch(page, MONDAY, "dinner", 2);
  await setCoverage(page, dinners, [
    ["2026-12-07", "dinner"],
    ["2026-12-08", "dinner"],
    ["2026-12-09", "dinner"],
  ]);

  await page.goto(`/?week=${MONDAY}`);

  const lunchRails = page.locator(
    `.batch-rail[data-batch-id="${lunches}"]`,
  );
  const dinnerRails = page.locator(
    `.batch-rail[data-batch-id="${dinners}"]`,
  );
  await expect(lunchRails).toHaveCount(3);
  await expect(dinnerRails).toHaveCount(3);

  await expect(lunchRails.nth(0)).toHaveClass(/is-start/);
  await expect(lunchRails.nth(1)).toHaveClass(/continues-before/);
  await expect(lunchRails.nth(1)).toHaveClass(/continues-after/);
  await expect(lunchRails.nth(2)).toHaveClass(/is-end/);

  const lunchColumns = await lunchRails.evaluateAll((elements) =>
    elements.map((element) => getComputedStyle(element).gridColumnStart),
  );
  const dinnerColumns = await dinnerRails.evaluateAll((elements) =>
    elements.map((element) => getComputedStyle(element).gridColumnStart),
  );
  expect(new Set(lunchColumns).size).toBe(1);
  expect(new Set(dinnerColumns).size).toBe(1);
  expect(lunchColumns[0]).not.toBe(dinnerColumns[0]);

  const lineBoxes = await lunchRails
    .locator(".batch-rail-line")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom };
      }),
    );

  expect(Math.abs(lineBoxes[0]!.bottom - lineBoxes[1]!.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(lineBoxes[1]!.bottom - lineBoxes[2]!.top)).toBeLessThanOrEqual(1);
});

test("rails stay open when the batch crosses either visible week edge", async ({
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

  const openStart = page.locator(
    `.batch-rail[data-batch-id="${fromPreviousWeek}"]`,
  ).first();
  await expect(openStart).toHaveClass(/continues-before/);
  await expect(openStart).not.toHaveClass(/is-start/);
  await expect(openStart.locator(".is-start")).toHaveCount(0);

  const openEnd = page.locator(
    `.batch-rail[data-batch-id="${intoNextWeek}"]`,
  ).last();
  await expect(openEnd).toHaveClass(/continues-after/);
  await expect(openEnd).not.toHaveClass(/is-end/);
  await expect(openEnd.locator(".is-end")).toHaveCount(0);
});

test("dense overlapping rails preserve usable phone-width cards", async ({ page }) => {
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
