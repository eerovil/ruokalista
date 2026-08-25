import type { Locator, Page } from "@playwright/test";

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

/** The blank rows are folded away until somebody asks to add a line. */
export async function openSpareLines(page: Page): Promise<void> {
  const add = page.locator("details.add-lines");
  if (!(await add.evaluate((el: HTMLDetailsElement) => el.open))) {
    await add.locator("> summary").click();
  }
}
