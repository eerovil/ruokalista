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

/**
 * On the recipe screen, `preference-open` and `sharing-open` are no longer
 * lines of the page but rows of its ⋯ modal (#354), each opening a modal of
 * its own at `#<id>-auki`. Opening one goes through ⋯ as a person would;
 * closing it goes back out through ⋯ too, so the page underneath is usable.
 */
function settingsModal(page: Page, id: string) {
  return page.locator(`.top-modal#${id}-auki`);
}

async function openSettingsModal(page: Page, id: string): Promise<void> {
  const card = settingsModal(page, id).locator(".edit-modal-card");
  if (!(await card.isVisible())) {
    await page.getByRole("link", { name: "Lisää valintoja" }).click();
    await page.locator(`#lisavalinnat a[href="#${id}-auki"]`).click();
  }
  await expect(card).toBeVisible();
}

async function closeSettingsModal(page: Page, id: string): Promise<void> {
  const card = settingsModal(page, id).locator(".edit-modal-card");
  if (await card.isVisible()) await card.locator(".edit-done").click();
  const more = page.locator("#lisavalinnat .edit-modal-card");
  if (await more.isVisible()) await more.locator(".edit-done").click();
  await expect(card).toBeHidden();
  await expect(more).toBeHidden();
}

export async function openEditBlock(page: Page, id: string): Promise<void> {
  if ((await settingsModal(page, id).count()) > 0) return openSettingsModal(page, id);
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
  if ((await settingsModal(page, id).count()) > 0) return closeSettingsModal(page, id);
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

/**
 * The recipe screen's size (#364): the button beside Lisää kokattaviin opens
 * the Koko modal, and a size there reloads the page at that size.
 */
export async function chooseSize(page: Page, size: string): Promise<void> {
  await page.locator(".recipe-top-size").click();
  await page.locator("#koko .size-choice").getByText(size, { exact: true }).click();
  await expect(page.locator(".recipe-top-size")).toContainText(size);
}

/** And Lisää kokattaviin at that size. */
export async function addAtSize(page: Page, size: string): Promise<void> {
  await chooseSize(page, size);
  await page.getByRole("button", { name: /Lisää kokattaviin/ }).click();
}

/**
 * The recipe screen's Näytä tuotevalinnat switch, a row of its ⋯ modal since
 * #354: open ⋯, set it, and close ⋯ again so the rows underneath can be used.
 */
export async function setProductPicks(page: Page, on: boolean): Promise<void> {
  await page.getByRole("link", { name: "Lisää valintoja" }).click();
  await page.getByLabel("Näytä tuotevalinnat").setChecked(on);
  await page.locator("#lisavalinnat .edit-done").click();
  await expect(page.locator("#lisavalinnat .edit-modal-card")).toBeHidden();
}
