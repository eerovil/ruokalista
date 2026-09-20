import { expect, type Page } from "@playwright/test";

/**
 * A block of the recipe editor or the recipe screen is one read-only line with
 * `Muokkaa` beside it, and everything editable is in the modal behind that
 * button (#317). A test that means to change something opens it first, exactly
 * as a person does.
 *
 * The ids are the ones `html.ts::editBlock` was given: `recipe-image-open`,
 * `categories-open`, `steps-open`, `preference-open`, `sharing-open`.
 */
export async function openEditBlock(page: Page, id: string): Promise<void> {
  const block = page.locator(`.edit-block:has(> #${id})`);
  if (!(await page.locator(`#${id}`).isChecked())) {
    await block.locator(`.edit-summary label[for="${id}"]`).first().click();
  }
  await expect(block.locator(".edit-modal-card")).toBeVisible();
}

/** And closes it again, so the screen underneath can be read or clicked. */
export async function closeEditBlock(page: Page, id: string): Promise<void> {
  const block = page.locator(`.edit-block:has(> #${id})`);
  if (await page.locator(`#${id}`).isChecked()) {
    await block.locator(".edit-done").click();
  }
  await expect(block.locator(".edit-modal-card")).toBeHidden();
}
