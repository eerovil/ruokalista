import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The correction screen and the editor show a line's common fields — how much,
 * of what — and keep the uncommon ones behind a disclosure. A test that wants a
 * range, a second measurement, a source line, a position or the remove box has
 * to open it, exactly as a person does.
 */
export async function openMore(line: Locator): Promise<void> {
  const more = line.locator("> details.line-more");
  if (!(await more.evaluate((el: HTMLDetailsElement) => el.open))) {
    await more.locator("> summary").click();
  }
}

/**
 * The recipe editor has no blank rows at all (issue #128). Its list ends in a
 * button that asks the server for exactly one, so a test that wants a new
 * ingredient presses it, as a person does.
 */
export async function addIngredientRow(page: Page): Promise<void> {
  const before = await page.locator(".edit-lines .line").count();
  await page.getByRole("button", { name: "+ Lisää aines" }).click();
  await expect(page.locator(".edit-lines .line")).toHaveCount(before + 1);
}

/** The intake screen's blank rows are folded away until somebody asks. */
export async function openSpareLines(page: Page): Promise<void> {
  const add = page.locator("details.add-lines");
  if (!(await add.evaluate((el: HTMLDetailsElement) => el.open))) {
    await add.locator("> summary").click();
  }
}

/**
 * The import screen is a read view; the editable form is one disclosure down.
 * A test that means to change the draft has to open it, as a person does.
 */
export async function openDraftEditor(page: Page): Promise<void> {
  const editor = page.locator("details.edit-draft");
  if (!(await editor.evaluate((el: HTMLDetailsElement) => el.open))) {
    await editor.locator("> summary").click();
  }
}
