import { expect, type Page } from "@playwright/test";

/**
 * A block of the recipe editor or the recipe screen is one read-only line with
 * `Muokkaa` beside it, and everything editable is in the modal behind that
 * button (#317). A test that means to change something opens it first, exactly
 * as a person does.
 *
 * The ids are the ones `html.ts::editBlock` was given: `recipe-image-open`,
 * `categories-open`, `steps-open`, `preference-open`, `sharing-open`. Most are
 * the id of the checkbox beside the block; `sharing-open` is the id of the
 * block itself, because it opens from a fragment rather than a checkbox so that
 * the shortcut under the recipe's title can open it too (#317 review). Both
 * shapes are one line with an opener in it, so these helpers take either.
 */
function editBlockLocator(page: Page, id: string) {
  return page.locator(`.edit-block#${id}, .edit-block:has(> #${id})`);
}

export async function openEditBlock(page: Page, id: string): Promise<void> {
  const block = editBlockLocator(page, id);
  const modal = block.locator(".edit-modal-card");
  if (!(await modal.isVisible())) {
    await block
      .locator(`.edit-summary label, .edit-summary a.edit-trigger`)
      .first()
      .click();
  }
  await expect(modal).toBeVisible();
}

/** And closes it again, so the screen underneath can be read or clicked. */
export async function closeEditBlock(page: Page, id: string): Promise<void> {
  const block = editBlockLocator(page, id);
  const modal = block.locator(".edit-modal-card");
  if (await modal.isVisible()) {
    await block.locator(".edit-done").click();
  }
  await expect(modal).toBeHidden();
}

/**
 * Tab forward until `selector` holds the focus, failing if it never does.
 *
 * An opener a finger can use has to be reachable without one, and the way #317
 * first drew these — a `<label>` for a checkbox elsewhere on the page — was
 * skipped by the keyboard entirely (#317 review). Pressing the key rather than
 * calling `focus()` is the point twice over: it proves the control is in the
 * tab order, and it is what makes `:focus-visible` apply, so the ring a sighted
 * keyboard user needs can be asserted right after.
 */
export async function tabTo(
  page: Page,
  selector: string,
  presses = 40,
): Promise<void> {
  for (let i = 0; i < presses; i += 1) {
    await page.keyboard.press("Tab");
    const here = await page
      .locator(selector)
      .evaluate((el) => el === document.activeElement);
    if (here) return;
  }
  throw new Error(`${selector} was never focused in ${presses} Tab presses`);
}

/** The focus ring the browser actually computed, as `style width`. */
export async function focusRing(page: Page, selector: string): Promise<string> {
  return page.locator(selector).evaluate((el) => {
    const drawn = getComputedStyle(el);
    return `${drawn.outlineStyle} ${drawn.outlineWidth}`;
  });
}
