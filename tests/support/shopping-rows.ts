import { expect, type Locator, type Page } from "@playwright/test";

/**
 * A shopping-list row opens into a modal rather than expanding in place
 * (#321). Everything behind the row line — where its total came from, the
 * product it buys, the cupboard button — is in there, so a test that means to
 * read or press any of it opens the row first, exactly as a person does.
 *
 * The modal covers the list while it is open, so a row already open would
 * swallow the tap meant for this one. Tapping the dimmed area is how a person
 * gets out of it, so that is what this does — rather than reaching in and
 * unchecking the box, which would prove a thing no member can do.
 */
export async function openShoppingRow(item: Locator): Promise<void> {
  await closeOpenShoppingRow(item.page());
  await item.locator(".shopping-summary").click();
  await expect(item.locator(".line-modal-card")).toBeVisible();
}

/** And closes it again, by the button that says so. */
export async function closeShoppingRow(item: Locator): Promise<void> {
  if (await item.locator("input.row-open").isChecked()) {
    await item.locator(".line-done").click();
  }
  await expect(item.locator(".line-modal-card")).toBeHidden();
}

/** Whichever row is open, if any, tapped away. */
export async function closeOpenShoppingRow(page: Page): Promise<void> {
  const backdrop = page.locator(".shopping-item .line-modal-back:visible");
  if ((await backdrop.count()) > 0) {
    // Near the corner: the backdrop fills the viewport and the card sits in
    // the middle of it, so the middle is the one part of it nobody can tap.
    await backdrop.first().click({ position: { x: 4, y: 4 } });
    await expect(backdrop).toHaveCount(0);
  }
}
