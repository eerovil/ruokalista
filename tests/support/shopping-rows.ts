import { expect, type Locator, type Page } from "@playwright/test";

/**
 * A shopping-list row opens the S-ostoslista product sheet straight away
 * (#358); the in-row window it used to open (#321) is gone. Where the amount
 * comes from, the cupboard button and a dish's own product are on that sheet
 * now, drawn from the row's hidden `.row-data`. So a test that means to read
 * or press any of it opens the row first, exactly as a person does.
 *
 * Only a buy row of the household with the S-ostoslista opens anything. A
 * cupboard row has its one action — "Osta" — on the row itself.
 */

/** The product sheet, as opposed to the send warning that shares its class. */
export function productSheet(page: Page): Locator {
  return page.locator(".s-sheet:not(.s-warn)");
}

/** The sheet's results, without the grey rows a running search draws. */
export function sheetResults(page: Page): Locator {
  return page.locator(".s-sheet:not(.s-warn) .s-product-results > li:not(.is-placeholder)");
}

/**
 * Tap the row and wait for its sheet, with its first search answered.
 *
 * A sheet already open covers the list, so it is closed first by its own
 * button — the way a person gets out of it.
 */
export async function openShoppingRow(item: Locator): Promise<void> {
  const page = item.page();
  await closeOpenShoppingRow(page);
  await item.locator(".shopping-summary").click();
  await expect(productSheet(page)).toBeVisible();
  await searchSettled(page);
}

/** Wait until the sheet's search has answered, one way or the other. */
export async function searchSettled(page: Page): Promise<void> {
  const sheet = productSheet(page);
  await expect(sheet.locator(".is-placeholder")).toHaveCount(0);
  await expect(sheet.locator(".s-product-panel-results.is-loading")).toHaveCount(0);
  await expect(sheet.locator(".spinner")).toHaveCount(0);
}

/** And closes it again, by the button that says so. */
export async function closeShoppingRow(item: Locator): Promise<void> {
  await closeOpenShoppingRow(item.page());
}

/** Whichever sheet is open, if any, closed by its "Sulje". */
export async function closeOpenShoppingRow(page: Page): Promise<void> {
  const sheet = productSheet(page);
  if (await sheet.isVisible()) {
    await sheet.getByRole("button", { name: "Sulje" }).click();
    await expect(sheet).toBeHidden();
  }
}

/**
 * Open the row and tap its amount, which unfolds where the amount came from.
 * Returns the breakdown's entries.
 */
export async function openBreakdown(item: Locator): Promise<Locator> {
  const page = item.page();
  await openShoppingRow(item);
  const sheet = productSheet(page);
  await sheet.locator(".s-sheet-amount").click();
  const breakdown = sheet.locator(".s-sheet-breakdown");
  await expect(breakdown).toBeVisible();
  return breakdown.locator(".shopping-from li");
}

/** Put a buy row's ingredient in the cupboard, from its sheet. Reloads. */
export async function putInCupboard(item: Locator): Promise<void> {
  const page = item.page();
  await openShoppingRow(item);
  await Promise.all([
    page.waitForEvent("load"),
    productSheet(page)
      .locator(".s-sheet-foot")
      .getByRole("button", { name: "Löytyy jo kaapista" })
      .click(),
  ]);
}

/**
 * Take a cupboard row back onto the list, by the "Osta" on the row itself.
 * `item` is the row's `<li>`, where that form sits beside the row. Reloads.
 */
export async function takeOutOfCupboard(item: Locator): Promise<void> {
  const page = item.page();
  const buy = item.locator("form.row-unpantry button");
  await expect(buy).toHaveText("Osta");
  await Promise.all([page.waitForEvent("load"), buy.click()]);
}

/**
 * Press "Lähetä S-ostoslistaan", and when it first warns about rows that would
 * go as text, say "Lähetä silti" (#358). Works without a script too: there the
 * form simply posts.
 */
export async function sendList(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Lähetä S-ostoslistaan" }).click();
  const warning = page.locator(".s-warn");
  if ((await warning.count()) > 0) {
    await warning.getByRole("button", { name: "Lähetä silti" }).click();
    await expect(warning).toHaveCount(0);
  }
}

/**
 * Go to the plain product screen a row's hidden opener form points at —
 * `korvaa` to choose its product, `lisaa` to add a second packet size.
 *
 * The sheet no longer offers a second size (#358), but the server still keeps
 * and counts them, and the plain screen is the way to reach that arithmetic.
 * Built from the form rather than by submitting it, so it is the same address
 * with or without a script.
 */
export async function openPlainProductScreen(
  item: Locator,
  tapa: "korvaa" | "lisaa" = "korvaa",
): Promise<void> {
  const page = item.page();
  const form = item.locator(`form.s-product-open[data-tapa="${tapa}"]`).first();
  const action = (await form.getAttribute("action")) ?? "";
  const params = new URLSearchParams();
  for (const field of await form.locator('input[type="hidden"]').all()) {
    params.append(
      (await field.getAttribute("name")) ?? "",
      (await field.getAttribute("value")) ?? "",
    );
  }
  await page.goto(`${action}?${params.toString()}`);
}
