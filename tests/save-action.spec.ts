import { expect, test, type Page } from "@playwright/test";

import { DRAFT_FIXTURE, stubStructuring } from "./support/draft";
import { openDraftEditor } from "./support/lines";
import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * The save action, in the three places a recipe is written (issue #217).
 *
 * What each test here asserts is the same thing in a different screen: the one
 * save is on screen without hunting for it, it says when there are changes not
 * yet saved, and neither of those states moves anything under the member's
 * thumb.
 */

/**
 * The project already runs as a Pixel 7, so this is that device's viewport
 * rather than a size of this file's choosing. Stated because two of the tests
 * below have to compare the page's height against the screen's.
 */
const PHONE = { width: 412, height: 915 };

test.beforeAll(reseed);

test.beforeEach(async ({ context }) => {
  await context.addCookies([sessionCookie(1)]);
});

/** Import the sample draft and stop on the review screen. */
async function reviewAnImport(page: Page): Promise<void> {
  await stubStructuring(page);
  await page.goto("/intake");
  await page.getByLabel("Liitä reseptin teksti").fill(DRAFT_FIXTURE.source_text);
  await page.getByRole("button", { name: "Muodosta resepti" }).click();
  await expect(page.getByRole("heading", { name: "Tarkista resepti" }))
    .toBeVisible();
}

test("A. saving a new recipe stays on screen after the draft is edited", async ({
  page,
}) => {
  await reviewAnImport(page);

  const save = page.getByRole("button", { name: "Tallenna resepti" });
  const bar = page.locator(".save-bar");

  // Before anything is touched the bar already says what saving does here:
  // this recipe is new and nothing about it is stored yet.
  await expect(bar).toContainText("Uusi resepti — ei vielä tallennettu");
  await expect(save).toBeInViewport();

  // Now the case the card is about. Opening the draft for editing makes the
  // page much longer than the phone, and it used to put the save above the
  // fold, in the one situation where somebody certainly has changes to save.
  await openDraftEditor(page);
  const tall = await page.evaluate(() => document.body.scrollHeight);
  expect(tall).toBeGreaterThan(PHONE.height);

  await page.locator("#title").fill("Uunikaali ja juustokastike");
  await expect(save).toBeInViewport();
  await expect(bar).toContainText("Tallentamattomia muutoksia");

  // Scrolled to the end of the ingredient rows, it is still there.
  await page.mouse.wheel(0, tall);
  await expect(save).toBeInViewport();

  // Clear of the fixed tab strip, which would otherwise cover it.
  const barBox = await bar.boundingBox();
  const tabsBox = await page.locator(".tabs").boundingBox();
  expect(barBox).not.toBeNull();
  expect(tabsBox).not.toBeNull();
  expect(barBox!.y + barBox!.height).toBeLessThanOrEqual(tabsBox!.y + 1);

  await save.click();
  await expect(page).toHaveURL(/\/recipes\/\d+$/);
  await expect(page.getByRole("heading", { name: "Uunikaali ja juustokastike" }))
    .toBeVisible();
});

test("A. the review's save bar keeps its height through every state", async ({
  page,
}) => {
  await reviewAnImport(page);

  const bar = page.locator(".save-bar");
  const resting = (await bar.boundingBox())!.height;

  await openDraftEditor(page);
  await page.locator("#title").fill("Toinen nimi");
  await expect(bar).toContainText("Tallentamattomia muutoksia");
  expect((await bar.boundingBox())!.height).toBe(resting);

  // And while the save is running. The submit event is raised without letting
  // the browser act on it, because every real save on this screen ends in a
  // redirect — there is no honest way to measure a bar the browser has already
  // navigated away from, and holding or failing the post replaces the document
  // with an error page instead.
  await page.evaluate(() => {
    document
      .querySelector(".save-bar")!
      .closest("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await expect(bar).toContainText("Tallennetaan…");
  expect((await bar.boundingBox())!.height).toBe(resting);
  // The one button is disabled while it runs, so the same recipe cannot be
  // created twice by an impatient second tap.
  await expect(page.getByRole("button", { name: "Tallenna resepti" }))
    .toBeDisabled();

  // And the real save still lands, from a fresh copy of the screen.
  await page.reload();
  await openDraftEditor(page);
  await page.locator("#title").fill("Toinen nimi");
  await page.getByRole("button", { name: "Tallenna resepti" }).click();
  await expect(page).toHaveURL(/\/recipes\/\d+$/);
});

test("B. changing who sees a recipe needs no editor and no hunting", async ({
  page,
}) => {
  await page.goto("/recipes/1");

  // Who can see it is said under the title, before any scrolling at all.
  const shortcut = page.locator(".sharing-shortcut");
  await expect(shortcut).toBeInViewport();
  await expect(shortcut).toContainText("Näkyvyys: vain oma talous");

  // And one tap puts the control and its save on screen together.
  await shortcut.getByRole("link", { name: "Muuta" }).click();
  const save = page.getByRole("button", { name: "Tallenna jako" });
  await expect(page.getByLabel("Julkinen")).toBeInViewport();
  await expect(save).toBeInViewport();

  await page.getByLabel("Julkinen").check();
  await expect(page.locator(".recipe-sharing .save-bar"))
    .toContainText("Tallentamattomia muutoksia");
  await expect(save).toBeInViewport();

  await save.click();
  await expect(page.locator(".recipe-sharing")).toContainText(
    "näkyy kaikille kirjautuneille talouksille",
  );
  // The saved state is what the line under the title now says.
  await expect(page.locator(".sharing-shortcut"))
    .toContainText("Näkyvyys: kaikki taloudet");

  await page.getByLabel("Oma").check();
  await page.getByRole("button", { name: "Tallenna jako" }).click();
  await expect(page.locator(".sharing-shortcut"))
    .toContainText("Näkyvyys: vain oma talous");
});

test("B. searching the household list is not an unsaved change", async ({
  page,
}) => {
  // #recipient-search has no name and is never posted: it exists only to narrow
  // the list of households below it. Typing in it used to put the bar into its
  // unsaved state, announcing changes that could not be saved because there
  // were none.
  await page.goto("/recipes/1");
  const bar = page.locator(".recipe-sharing .save-bar");
  const households = page.locator(".recipient-list li");

  await expect(households).toHaveCount(1);
  await page.locator("#recipient-search").fill("Naapuri");
  // The box really is live — this is the same typing, doing its own job.
  await expect(households.first()).toBeVisible();
  await page.locator("#recipient-search").fill("Ei tällaista taloutta");
  await expect(households.first()).toBeHidden();

  await expect(bar).not.toHaveClass(/is-dirty/);
  await expect(bar).not.toContainText("Tallentamattomia muutoksia");

  // A control that *is* posted still counts, so this is not the bar having
  // stopped noticing.
  await page.getByLabel("Julkinen").check();
  await expect(bar).toContainText("Tallentamattomia muutoksia");

  // And putting it back the way the server sent it is not a change either.
  await page.getByLabel("Oma").check();
  await expect(bar).not.toContainText("Tallentamattomia muutoksia");
});

test("an edit left unsaved still says so after going back", async ({ page }) => {
  await page.goto("/recipes/1/edit");
  const bar = page.locator(".save-bar");

  await page.locator("#title").fill("Kaalilaatikko illalla");
  await expect(bar).toContainText("Tallentamattomia muutoksia");

  // Away without saving, then back. The browser puts the edited field back —
  // and the bar used to greet it by announcing there was nothing to save.
  await page.goto("/recipes");
  await page.goBack();

  await expect(page.locator("#title")).toHaveValue("Kaalilaatikko illalla");
  await expect(bar).toContainText("Tallentamattomia muutoksia");
  await expect(page.getByRole("button", { name: "Tallenna muutokset" }))
    .toBeEnabled();
});

test("going back after a save leaves the bar usable, not stuck saving", async ({
  page,
}) => {
  await page.goto("/recipes/1/edit");
  await page.locator("#title").fill("Kaalilaatikko aamulla");
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();
  await expect(page).toHaveURL(/\/recipes\/1$/);

  await page.goBack();

  // The save the member started is over, so nothing on the returned page may
  // still claim to be running it. What the bar says about unsaved changes is
  // deliberately not asserted here: a browser that rebuilds the document serves
  // the markup from before the save and puts the newer values back into it, and
  // a bar that then says the two differ is telling the truth about a page whose
  // save would be refused as stale anyway.
  const bar = page.locator(".save-bar");
  await expect(bar).not.toContainText("Tallennetaan…");
  await expect(page.getByRole("button", { name: "Tallenna muutokset" }))
    .toBeEnabled();

  // Left as it was found: this file seeds once for the whole run.
  await page.goto("/recipes/1/edit");
  await page.locator("#title").fill("Kaalilaatikko");
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();
  await expect(page).toHaveURL(/\/recipes\/1$/);
});

test("the save bar's button still carries its own value", async ({ page }) => {
  // The sharing form's save posts `action=save`. The island disables the
  // button once the save is on its way, and a button disabled a moment too
  // early would take that value out of the post.
  await page.goto("/recipes/1");
  await page.getByLabel("Julkinen").check();

  const posted = page.waitForRequest(
    (request) =>
      request.url().endsWith("/recipes/julkaisu") && request.method() === "POST",
  );
  await page.getByRole("button", { name: "Tallenna jako" }).click();
  expect((await posted).postData()).toContain("action=save");

  await expect(page.locator(".recipe-sharing")).toContainText(
    "näkyy kaikille kirjautuneille talouksille",
  );
  await page.getByLabel("Oma").check();
  await page.getByRole("button", { name: "Tallenna jako" }).click();
});

test("without JavaScript every save is still a plain form button", async ({
  browser,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: PHONE,
  });
  await context.addCookies([sessionCookie(1)]);
  const page = await context.newPage();

  await page.goto("/recipes/1/edit");
  const save = page.getByRole("button", { name: "Tallenna muutokset" });
  await expect(save).toBeInViewport();
  // No script, so no dirty state — and nothing claiming one either.
  await expect(page.locator(".save-bar")).not.toHaveClass(/is-dirty/);

  await page.locator("#title").fill("Uunikaali, uudestaan");
  await save.click();
  await expect(page).toHaveURL(/\/recipes\/1$/);
  await expect(page.getByRole("heading", { name: "Uunikaali, uudestaan" }))
    .toBeVisible();

  await context.close();
});

test("C. the long editor still keeps its save on screen, and says it is dirty", async ({
  page,
}) => {
  await page.goto("/recipes/1/edit");

  const save = page.getByRole("button", { name: "Tallenna muutokset" });
  const bar = page.locator(".save-bar");
  await expect(save).toBeInViewport();
  await expect(bar).not.toHaveClass(/is-dirty/);

  await page.locator("#title").fill("Uunikaali illalla");
  await expect(bar).toHaveClass(/is-dirty/);
  await expect(bar).toContainText("Tallentamattomia muutoksia");

  const tall = await page.evaluate(() => document.body.scrollHeight);
  await page.mouse.wheel(0, tall);
  await expect(save).toBeInViewport();
  await expect(bar).toContainText("Tallentamattomia muutoksia");

  await save.click();
  await expect(page).toHaveURL(/\/recipes\/1$/);
});

test("adding an ingredient row is not a save, and does not say it is", async ({
  page,
}) => {
  await page.goto("/recipes/1/edit");

  // `+ Lisää aines` submits the same form, but it re-renders the editor rather
  // than saving it — so the bar must not claim a save is running.
  await page.getByRole("button", { name: "+ Lisää aines" }).click();
  await expect(page.getByRole("heading", { name: "Muokkaa reseptiä" }))
    .toBeVisible();
  await expect(page.locator(".save-bar")).not.toContainText("Tallennetaan…");
  await expect(page.getByRole("button", { name: "Tallenna muutokset" }))
    .toBeEnabled();
});
