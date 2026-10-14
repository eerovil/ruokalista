import { expect, type Page } from "@playwright/test";

import { executeLocalSql } from "./seed";

/**
 * Put a dish on the signed-in household's to-do list (#345), through the same
 * JSON API every test uses, and hand back its identity.
 */
export async function listDish(
  page: Page,
  recipeId: number,
  multiplier = 1,
): Promise<{ id: number; instanceKey: string }> {
  const response = await page.request.post("/api/batches", {
    data: { recipeId, multiplier },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as { id: number; instanceKey: string };
}

/**
 * A dish this household cooked on `date`. The app only ever ticks a dish as
 * cooked today, so a past day is written straight into the local database —
 * which is the one thing cooking history needs and no screen can make.
 */
export async function cookedOn(
  page: Page,
  recipeId: number,
  date: string,
): Promise<number> {
  const { id } = await listDish(page, recipeId);
  executeLocalSql(`UPDATE planned_batch SET cooked_on = '${date}' WHERE id = ${id}`);
  return id;
}
