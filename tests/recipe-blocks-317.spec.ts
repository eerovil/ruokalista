import { expect, test } from "@playwright/test";

import {
  closeEditBlock,
  focusRing,
  openEditBlock,
  tabTo,
} from "./support/blocks";
import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * The recipe editor and the recipe screen, read as lines rather than as
 * controls (#317).
 *
 * Every block here is the same bargain #315 struck for an ingredient row: one
 * read-only line saying what the block holds, and everything editable behind
 * `Muokkaa` in a modal that needs no JavaScript. What these tests are really
 * about is that the line keeps telling the truth — on arrival, while the modal
 * is open, and after the save.
 */

test.beforeEach(reseed);

test.beforeEach(async ({ context }) => {
  await context.addCookies([sessionCookie(1)]);
});

test("the editor is the picture, then the name", async ({ page }) => {
  await page.goto("/recipes/1/edit");

  // The picture's own controls are not on the screen at all until it is tapped.
  await expect(page.locator(".recipe-image-editor .recipe-image")).toBeVisible();
  await expect(page.locator("#recipe-image")).toBeHidden();
  await expect(page.locator(".recipe-image-editor .edit-modal-card")).toBeHidden();

  // And the name is the next thing under it, which is what the card asks for.
  const order = await page.evaluate(() => {
    const picture = document.querySelector(".recipe-image-editor");
    const name = document.querySelector("#title");
    if (picture === null || name === null) return "missing";
    return picture.compareDocumentPosition(name) &
      Node.DOCUMENT_POSITION_FOLLOWING
      ? "name after picture"
      : "name before picture";
  });
  expect(order).toBe("name after picture");

  // The picture is the only thing to tap: there is no button beside it, and
  // nothing in the block is printed on the screen.
  const summary = page.locator(".recipe-image-editor .edit-summary");
  await expect(summary.locator(".edit-trigger")).toHaveCount(0);
  // It still says what tapping it does, to anything that reads rather than
  // looks — and those words take up no room on the screen.
  const name = summary.locator("label.picture-tap > .off-screen");
  await expect(name).toHaveText("Lisää kuva");
  const box = await name.boundingBox();
  expect(box?.width ?? 0).toBeLessThanOrEqual(2);

  // Tapping the picture is what opens them.
  await openEditBlock(page, "recipe-image-open");
  await expect(page.locator("#recipe-image")).toBeVisible();
  await expect(
    page.getByText("JPEG, PNG tai WebP. Iso kuva pienennetään ennen lähetystä."),
  ).toBeVisible();
});

test("a recipe with no method at all says so", async ({ page }) => {
  // The quick save (#211) is how a recipe with nothing in it comes to exist,
  // which is the only way to reach this state through the screens.
  await page.goto("/intake");
  await page.getByLabel("Reseptin nimi").fill("Mummin lihapullat");
  await page.getByRole("button", { name: "Tallenna keskeneräisenä" }).click();
  await expect(page).toHaveURL(/\/recipes\/\d+$/);
  const recipe = new URL(page.url()).pathname;

  await page.goto(`${recipe}/edit`);
  await expect(page.locator("#step-summary li")).toHaveCount(0);
  await expect(page.locator(".step-summary-empty")).toBeVisible();
  await expect(page.locator(".step-summary-empty")).toHaveText("Ei vaiheita");

  // And it stops saying it the moment a step is written, without a round trip.
  await openEditBlock(page, "steps-open");
  await page.locator('textarea[name="step.0"]').fill("Pyörittele pullat.");
  await expect(page.locator(".step-summary-empty")).toBeHidden();
  await expect(page.locator("#step-summary li")).toHaveText(["Pyörittele pullat."]);

  // …and says it again when the step is taken back out.
  await page.locator('textarea[name="step.0"]').fill("");
  await expect(page.locator(".step-summary-empty")).toBeVisible();
});

test("the source's portion count is off the editor but not thrown away", async ({
  page,
}) => {
  await page.goto("/recipes/1/edit");
  await expect(page.getByText("Annoksia lähteen mukaan")).toHaveCount(0);
  await expect(page.locator("#yield")).toBeHidden();
  await expect(page.locator("#yield")).toHaveValue("4");

  // An ordinary save through the editor must not quietly erase it.
  await page.locator("#title").fill("Kaalilaatikko illalla");
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();
  await expect(page).toHaveURL(/\/recipes\/1$/);
  await expect(page.locator(".source-yield")).toContainText("Lähteessä 4 annosta");
});

test("the categories read as a line that follows the ticks", async ({ page }) => {
  await page.goto("/recipes/1/edit");
  const line = page.locator("#chosen-categories");
  await expect(line).toHaveText("Ei kategoriaa");
  // Eleven checkboxes are not on the screen; one line and a button are.
  await expect(page.locator(".category-choices")).toBeHidden();

  await openEditBlock(page, "categories-open");
  await page.locator(".category-choices").getByLabel("Salaatti").check();
  await page.locator(".category-choices").getByLabel("Keitto").check();
  // The line is honest before the save, not one round trip behind it.
  await expect(line).toHaveText("Keitto, Salaatti");

  await closeEditBlock(page, "categories-open");
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();
  await expect(page.locator(".category-tags")).toContainText("Salaatti");

  await page.goto("/recipes/1/edit");
  await expect(page.locator("#chosen-categories")).toHaveText("Keitto, Salaatti");
});

test("the method reads as a numbered list that follows an edit", async ({
  page,
}) => {
  await page.goto("/recipes/1/edit");
  const summary = page.locator("#step-summary li");
  await expect(summary.first()).toHaveText("Kuullota kaali öljyssä.");
  await expect(page.locator(".edit-steps")).toBeHidden();
  const before = await summary.count();

  await openEditBlock(page, "steps-open");
  await page.locator('textarea[name="step.0"]').fill("Kuullota kaali voissa.");
  await expect(summary.first()).toHaveText("Kuullota kaali voissa.");

  // A spare step filled in appears on the list as soon as it is written.
  await page.locator(`textarea[name="step.${before}"]`).fill("Tarjoa kuumana.");
  await expect(summary).toHaveCount(before + 1);

  await closeEditBlock(page, "steps-open");
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();
  // The saved step still carries its ingredient mention, so the wording it
  // reads back as has the amount folded into it.
  await expect(page.locator(".steps")).toContainText("kaali voissa.");
  await expect(page.locator(".steps")).toContainText("Tarjoa kuumana.");
});

test("the household's own settings are two lines and two modals", async ({
  page,
}) => {
  await page.goto("/recipes/1");
  const sharing = page.locator(".recipe-sharing");

  await expect(sharing.locator(".preference-value")).toHaveText(
    "Resepti sellaisenaan",
  );
  await expect(sharing).toContainText("näkyy vain omalle taloudelle");
  // Neither form is on the screen until it is asked for.
  await expect(page.locator(".multiplier-choice")).toBeHidden();
  await expect(page.locator(".sharing-form")).toBeHidden();

  await openEditBlock(page, "preference-open");
  await page.locator(".multiplier-choice").getByRole("button", { name: "2×" }).click();
  await expect(sharing.locator(".preference-value")).toHaveText("2×");

  // And the line under the title still opens the sharing modal in one tap.
  await page
    .locator(".sharing-shortcut")
    .getByRole("link", { name: "Muuta" })
    .click();
  await expect(page.locator(".sharing-form")).toBeVisible();
  await page.getByLabel("Julkinen").check();
  await page.getByRole("button", { name: "Tallenna jako" }).click();
  await expect(sharing).toContainText("näkyy kaikille kirjautuneille talouksille");
  await expect(page.locator(".sharing-form")).toBeHidden();
});

/**
 * Both modal openers, worked without a pointer (#317 review).
 *
 * #317 put two things on screen that open a modal but were not controls: the
 * editor's picture, whose checkbox had focus but nothing visible drawing it,
 * and the sharing line's `Muuta`, a `<label>` the tab order skipped outright.
 * These tests press the keys rather than calling `focus()`, so a launcher that
 * falls out of the tab order again fails here rather than in somebody's hands.
 */
test("the editor's picture takes focus visibly, and opens with a key", async ({
  page,
}) => {
  await page.goto("/recipes/1/edit");
  await expect(page.locator("#recipe-image")).toBeHidden();

  await tabTo(page, "#recipe-image-open");

  // The focus is on a 1px control, so the picture is what has to show it.
  expect(await focusRing(page, ".recipe-image-editor label.picture-tap")).toBe(
    "solid 2px",
  );

  await page.keyboard.press("Space");
  await expect(page.locator(".recipe-image-editor .edit-modal-card"))
    .toBeVisible();
  await expect(page.locator("#recipe-image")).toBeVisible();
});

test("the sharing shortcut is in the tab order, and opens with a key", async ({
  page,
}) => {
  await page.goto("/recipes/1");
  await expect(page.locator(".sharing-form")).toBeHidden();

  const shortcut = ".sharing-shortcut a";
  // A link, not a label: the thing the keyboard can reach and press.
  await expect(page.locator(".sharing-shortcut").getByRole("link", { name: "Muuta" }))
    .toBeVisible();
  await expect(page.locator(".sharing-shortcut label")).toHaveCount(0);

  await tabTo(page, shortcut);
  expect(await focusRing(page, shortcut)).not.toBe("none 0px");

  await page.keyboard.press("Enter");
  await expect(page.locator(".sharing-form")).toBeVisible();
  await expect(page.getByLabel("Julkinen")).toBeInViewport();

  // And Valmis takes it away again without a pointer either.
  await page.locator(".edit-block#sharing-open .edit-done").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".sharing-form")).toBeHidden();
});

test("the sharing block's own Muokkaa still opens the same modal", async ({
  page,
}) => {
  await page.goto("/recipes/1");

  // Two openers a screen apart, one modal: opening from the block itself has
  // to keep working now that the shortcut drives it through a fragment.
  await openEditBlock(page, "sharing-open");
  await expect(page.locator(".sharing-form")).toBeVisible();
  await closeEditBlock(page, "sharing-open");
  await expect(page.locator(".sharing-form")).toBeHidden();
});
