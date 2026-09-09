import { expect, test, type Page } from "@playwright/test";

import { DRAFT_FIXTURE, stubStructuring } from "./support/draft";
import { openDraftEditor, openMore } from "./support/lines";
import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * Issue #298, both halves, on the screen that reported them: the import
 * review, read on a phone.
 *
 * The first half is the save bar. Its position used to be `sticky`, and on an
 * iPhone that came apart — scroll a long review down and back up, and the bar
 * ends up stranded partway up the screen, because Safari does not recompute a
 * bottom-sticky offset while the address bar is collapsing and expanding.
 * Chromium has no such address bar and cannot reproduce it, so this spec
 * guards the fix rather than the symptom: the bar is positioned the way the
 * tab strip beside it is, it stays put across a scroll down and back up, and
 * the space it takes over the form is still reserved underneath it.
 *
 * The second half is a line the model matched to an ingredient the household
 * already has, when it is really a new one. That used to be five steps; here
 * it is one tick, with no name typed and no disclosure opened.
 */

/**
 * A model that read "rypsiöljyä" and filed it under the household's plain
 * "öljy". Nothing about the draft is wrong enough to stop a save — this is
 * exactly the case where the member is the only one who knows it is a
 * different foodstuff.
 */
const WRONG_MATCH_DRAFT = {
  title: "Rypsipaistetut kasvikset",
  yield_portions: 4,
  source_text:
    "Rypsipaistetut kasvikset\n4 annosta\n2 rkl rypsiöljyä\n500 g valkokaalia",
  steps: [
    {
      text: "Paista kaali rypsiöljyssä.",
      section: null,
      phase: null,
      ingredient_refs: [],
    },
  ],
  lines: [
    {
      quantity: 2,
      quantity_max: null,
      unit: "rkl",
      alt_quantity: null,
      alt_unit: null,
      ingredient_id: 1,
      ingredient_name: "rypsiöljy",
      source_line: "2 rkl rypsiöljyä",
      section: null,
      phase: null,
      note: null,
    },
    {
      quantity: 500,
      quantity_max: null,
      unit: "g",
      alt_quantity: null,
      alt_unit: null,
      ingredient_id: 3,
      ingredient_name: "valkokaali",
      source_line: "500 g valkokaalia",
      section: null,
      phase: null,
      note: null,
    },
  ],
};

test.beforeEach(async ({ context }) => {
  reseed();
  await context.addCookies([sessionCookie(1)]);
});

test("the save bar stays at the bottom of the screen across a scroll (#298)", async ({
  page,
}) => {
  await stubStructuring(page);
  await pasteAndStructure(page);
  await openDraftEditor(page);

  const bar = page.locator(".save-bar");
  await expect(bar).toBeVisible();

  // The mechanism, not just the placement. The tab strip under it has always
  // been fixed and has never moved on the reporter's phone; sticky is what
  // did, so being fixed is the fix — for as long as this form is on screen,
  // which on the review screen is the whole time.
  await expect(page.locator(".save-bar-slot")).toHaveClass(/is-pinned/);
  await expect(
    bar.evaluate((node) => window.getComputedStyle(node).position),
  ).resolves.toBe("fixed");

  const tabs = await box(page, ".tabs");
  const resting = await box(page, ".save-bar");
  // Sitting on the tab strip rather than over it or away from it.
  expect(Math.abs(resting.y + resting.height - tabs.y)).toBeLessThan(2);

  // Down to the end of a long form and back up — the report's exact gesture.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(200);
  const scrolled = await box(page, ".save-bar");
  expect(Math.abs(scrolled.y - resting.y)).toBeLessThan(2);

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  const back = await box(page, ".save-bar");
  expect(Math.abs(back.y - resting.y)).toBeLessThan(2);

  // A bar out of the flow would sit on top of the end of the form. The slot it
  // left behind is what keeps the last thing on the screen reachable.
  const slot = await box(page, ".save-bar-slot");
  expect(slot.height).toBeGreaterThanOrEqual(resting.height - 2);
});

test("a save bar belonging to one section stays with it (#298)", async ({
  page,
}) => {
  // The recipe screen's sharing form is a section of a longer page, not the
  // page. Pinning its bar to the bottom of every recipe would put "Tallenna
  // jako" over whatever a member was actually reaching for.
  await page.goto("/recipes/1");
  const edit = page.getByRole("link", { name: "Muokkaa reseptiä" });
  await expect(edit).toBeVisible();
  await expect(page.locator(".save-bar-slot")).not.toHaveClass(/is-pinned/);

  await edit.click();
  await expect(page).toHaveURL(/\/recipes\/1\/edit$/);
});

test("a wrongly matched line becomes a new ingredient in one tap (#298)", async ({
  page,
}) => {
  await stubStructuring(page, WRONG_MATCH_DRAFT);
  await pasteAndStructure(page);
  await openDraftEditor(page);

  const line = page.locator(".line").first();
  // The picker is still pointing at the household's own öljy, which is the
  // whole problem.
  await expect(line.locator("select")).toHaveValue("1");

  // One tick, on the row. No picker opened, no name typed, no Lisätiedot.
  await line.getByLabel("Tämä on uusi aines").check();
  await page.getByRole("button", { name: "Tallenna resepti" }).click();

  await expect(page).toHaveURL(/\/recipes\/\d+$/);
  await expect(
    page.getByRole("heading", { name: "Rypsipaistetut kasvikset" }),
  ).toBeVisible();

  // The name the model proposed on that row is the name that got created, and
  // the ingredient it was matched to is untouched.
  const names = await ingredientNames(page);
  expect(names).toContain("rypsiöljy");
  expect(names).toContain("öljy");
});

test("the name the tick approves can still be edited (#298)", async ({
  page,
}) => {
  await stubStructuring(page, WRONG_MATCH_DRAFT);
  await pasteAndStructure(page);
  await openDraftEditor(page);

  const line = page.locator(".line").first();
  const name = line.getByLabel("Uuden aineksen nimi");
  // Out of the way until the tick asks for it, and carrying the proposal.
  await expect(name).toBeHidden();

  await line.getByLabel("Tämä on uusi aines").check();
  await expect(name).toBeVisible();
  await expect(name).toHaveValue("rypsiöljy");

  await name.fill("kylmäpuristettu rypsiöljy");
  await page.getByRole("button", { name: "Tallenna resepti" }).click();

  await expect(page).toHaveURL(/\/recipes\/\d+$/);
  const names = await ingredientNames(page);
  expect(names).toContain("kylmäpuristettu rypsiöljy");
  expect(names).not.toContain("rypsiöljy");
});

test("an already-new line is unchanged by the tick (#298)", async ({ page }) => {
  await stubStructuring(page);
  await pasteAndStructure(page);
  await openDraftEditor(page);

  // The unmatched line has nothing to undo: it is already asking to create an
  // ingredient, and its name is on the row rather than behind a tick.
  const unmatched = page.locator(".line.is-new");
  await expect(unmatched).toHaveCount(1);
  await expect(unmatched.getByLabel("Tämä on uusi aines")).toHaveCount(0);
  await expect(unmatched.getByLabel("Uuden aineksen nimi")).toBeVisible();

  // And a matched line still keeps its uncommon fields where they were: the
  // name moved out of Lisätiedot, nothing else did.
  const matched = page.locator(".line").first();
  await openMore(matched);
  await expect(matched.getByLabel("Lähderivi")).toBeVisible();
  await expect(
    matched.locator(".more-fields").getByLabel("Uuden aineksen nimi"),
  ).toHaveCount(0);
});

async function pasteAndStructure(page: Page): Promise<void> {
  await page.goto("/intake");
  await page.getByLabel("Liitä reseptin teksti").fill(DRAFT_FIXTURE.title);
  await page.getByRole("button", { name: "Muodosta resepti" }).click();
  await expect(
    page.getByRole("heading", { name: "Tarkista resepti" }),
  ).toBeVisible();
}

async function ingredientNames(page: Page): Promise<string[]> {
  const response = await page.request.get("/api/ingredients");
  const body = (await response.json()) as { ingredients: { name: string }[] };
  return body.ingredients.map((ingredient) => ingredient.name);
}

async function box(
  page: Page,
  selector: string,
): Promise<{ y: number; height: number }> {
  const found = await page.locator(selector).boundingBox();
  expect(found, `${selector} has no box`).not.toBeNull();
  return found!;
}
