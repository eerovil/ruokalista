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
    ["2026-12-08", "lunch"],
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
