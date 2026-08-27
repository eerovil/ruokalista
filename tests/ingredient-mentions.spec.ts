import { expect, test } from "@playwright/test";

import {
  ANCHOR_REPOINT_DRAFT,
  DUPLICATE_AMOUNT_DRAFT,
  REMOVED_LINE_DRAFT,
  stubStructuring,
} from "./support/draft";
import { openDraftEditor, openMore } from "./support/lines";
import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * Issue #120: tapping an ingredient's name in a preparation step reveals that
 * ingredient's current amount, right there in the sentence.
 *
 * The thing worth proving is not that a span appears. It is that the amount
 * shown is read from the ingredient line every time — so a different portion
 * count and a later edit both come through on their own — and that a reference
 * which no longer fits the text fails by doing nothing.
 */

test.beforeAll(reseed);

test.beforeEach(async ({ context }) => {
  await context.addCookies([sessionCookie(1)]);
});

/**
 * The mention whose word is `word`, anywhere in the method. Pass an anchored
 * regular expression where one word contains another — plain "öljy" as a string
 * would also match the mention reading "öljyssä".
 */
function mention(
  page: import("@playwright/test").Page,
  word: string | RegExp,
) {
  return page
    .locator(".steps .mention")
    .filter({ has: page.locator(".mention-word", { hasText: word }) });
}

async function expectAllMentionAmounts(
  page: import("@playwright/test").Page,
  visible: boolean,
) {
  const amounts = page.locator(".mention-amount");
  const count = await amounts.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    await (visible
      ? expect(amounts.nth(index)).toBeVisible()
      : expect(amounts.nth(index)).toBeHidden());
  }
}

test("a mention starts closed and opens on a tap", async ({ page }) => {
  await page.goto("/recipes/1");

  const kaali = mention(page, "kaali");
  await expect(kaali).toHaveCount(1);
  await expect(kaali.locator(".mention-amount")).toBeHidden();

  await kaali.locator("label").click();
  await expect(kaali.locator(".mention-amount")).toBeVisible();
  await expect(kaali.locator(".mention-amount")).toHaveText("½ kpl (500 g)");

  // The word itself is never replaced — the amount joins the sentence, it does
  // not take it over.
  await expect(kaali.locator(".mention-word")).toHaveText("kaali");
});

test("tapping again hides it, and mentions toggle independently", async ({
  page,
}) => {
  await page.goto("/recipes/1");

  const kaali = mention(page, "kaali");
  const oljy = mention(page, "öljyssä");

  await kaali.locator("label").click();
  await expect(kaali.locator(".mention-amount")).toBeVisible();
  // One open mention leaves the other alone.
  await expect(oljy.locator(".mention-amount")).toBeHidden();

  await oljy.locator("label").click();
  await expect(oljy.locator(".mention-amount")).toHaveText("½ dl");
  await expect(kaali.locator(".mention-amount")).toBeVisible();

  await kaali.locator("label").click();
  await expect(kaali.locator(".mention-amount")).toBeHidden();
  await expect(oljy.locator(".mention-amount")).toBeVisible();
});

test("one keyboard toggle layers every amount over individual choices", async ({
  page,
}) => {
  await page.goto("/recipes/1");

  const revealAllByName = page.getByRole("checkbox", {
    name: "Näytä kaikki määrät",
  });
  const revealAll = page.locator(".reveal-all");
  await revealAllByName.focus();
  await expect(revealAll).toBeFocused();
  await revealAll.press("Space");
  await expectAllMentionAmounts(page, true);
  await expect(page.getByText("Piilota määrät", { exact: true })).toBeVisible();

  // An individual choice remains its own state even while the global layer
  // already makes every amount visible.
  const kaali = mention(page, "kaali");
  await kaali.locator("label").click();
  await revealAll.press("Space");
  await expect(kaali.locator(".mention-amount")).toBeVisible();
  await expect(mention(page, "öljyssä").locator(".mention-amount")).toBeHidden();
});

test("one toggle covers a multipart dish and survives back-forward restore", async ({
  page,
}) => {
  await page.goto("/recipes/3");

  const revealAllByName = page.getByRole("checkbox", {
    name: "Näytä kaikki määrät",
  });
  const revealAll = page.locator(".reveal-all");
  await expect(revealAllByName).toBeVisible();
  await page.locator(".reveal-all-label").click();
  await expect(revealAll).toBeChecked();
  const partAmounts = page.locator(".part .mention-amount");
  expect(await partAmounts.count()).toBeGreaterThan(0);
  for (let index = 0; index < await partAmounts.count(); index += 1) {
    await expect(partAmounts.nth(index)).toBeVisible();
  }
  await expect(page.locator(".reveal-all")).toHaveCount(1);

  await page.goto("/recipes");
  await page.goBack();
  await expect(page.locator(".reveal-all")).toBeChecked();
  await expect(page.locator(".part .mention-amount")).toBeVisible();
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the recipe-wide toggle still reveals and hides every amount", async ({
    page,
  }) => {
    await page.goto("/recipes/1");

    const revealAllByName = page.getByRole("checkbox", {
      name: "Näytä kaikki määrät",
    });
    const revealAll = page.locator(".reveal-all");
    await expect(revealAllByName).toBeVisible();
    await page.locator(".reveal-all-label").click();
    await expect(revealAll).toBeChecked();
    await expectAllMentionAmounts(page, true);

    await page.locator(".reveal-all-label").click();
    await expect(revealAll).not.toBeChecked();
    await expectAllMentionAmounts(page, false);

    const kaali = mention(page, "kaali");
    await kaali.locator("label").click();
    await expect(kaali.locator(".mention-amount")).toBeVisible();
  });
});

test("the revealed amount is this meal's, not the page's", async ({ page }) => {
  // Kaalilaatikko yields four. Cooking for eight doubles every line, and the
  // mention has no stored amount of its own to fall out of step.
  await page.goto("/recipes/1?portions=8");

  const oljy = mention(page, "öljyssä");
  await oljy.locator("label").click();
  await expect(oljy.locator(".mention-amount")).toHaveText("1 dl");
});

test("an ingredient with no stated amount is left as plain text", async ({
  page,
}) => {
  await page.goto("/recipes/1");

  // "hieman sitruunaruohoa" has no amount to reveal, so the word is not a
  // control at all rather than a control that does nothing.
  await expect(mention(page, "sitruunaruoholla")).toHaveCount(0);
  await expect(page.locator(".steps li").nth(2)).toContainText(
    "Mausta sitruunaruoholla",
  );
});

test("a reference to wording the step no longer has links nothing", async ({
  page,
}) => {
  await page.goto("/recipes/1");

  // The third step carries a stale reference to "kaali", which is not in it.
  // It must not attach itself to some other word instead.
  const third = page.locator(".steps li").nth(2);
  await expect(third.locator(".mention")).toHaveCount(0);
  await expect(third).toHaveText(/Mausta sitruunaruoholla ja tarjoa\./);
});

test("a part's step reveals the part's own amount, scaled with the dish", async ({
  page,
}) => {
  await page.goto("/recipes/3");

  const jauheliha = mention(page, "jauhelihan");
  await jauheliha.locator("label").click();
  await expect(jauheliha.locator(".mention-amount")).toHaveText("400 g");

  // A part has no yield of its own, so it scales by the dish's factor.
  await page.goto("/recipes/3?portions=12");
  const doubled = mention(page, "jauhelihan");
  await doubled.locator("label").click();
  await expect(doubled.locator(".mention-amount")).toHaveText("800 g");
});

test("repointing an ingredient row unlinks its mention, it does not rebind it", async ({
  page,
}) => {
  await page.goto("/recipes/1/edit");

  // The first line is öljy, and the first step says "öljyssä". Point that line
  // at a different ingredient and leave the step's wording exactly as it is.
  await page.locator('select[name="line.0.ingredient"]').selectOption({
    label: "jauheliha",
  });
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();

  await page.goto("/recipes/1");
  await expect(page.locator(".lines li").first()).toContainText("jauheliha");

  // The word still reads, and reveals nothing. Rebinding it to whatever took
  // the row over would put jauheliha's amount behind the word "öljyssä".
  await expect(mention(page, "öljyssä")).toHaveCount(0);
  await expect(page.locator(".steps li").nth(0)).toContainText("öljyssä");
  await expect(page.locator(".steps li").nth(0)).not.toContainText("½ dl");

  // Only that row's mention went. The other one on the same step is untouched.
  const kaali = mention(page, "kaali");
  await kaali.locator("label").click();
  await expect(kaali.locator(".mention-amount")).toHaveText("½ kpl (500 g)");
});

/**
 * A recipe may list one ingredient several times for several stages. The model
 * chooses a line without anything independently verifying that choice, so a
 * mention reveals every distinct stated amount for the ingredient. Blank
 * amounts disappear and repeated amounts appear once.
 *
 * Built through the real import path rather than seeded, so the identity has to
 * survive being invented by the model, saved, rendered, and edited.
 */
test("duplicate ingredient lines reveal all useful amounts before and after an edit", async ({
  page,
}) => {
  await stubStructuring(page, DUPLICATE_AMOUNT_DRAFT);
  await page.goto("/intake");
  await page.getByLabel("Liitä reseptin teksti").fill("Perunasalaatti");
  await page.getByRole("button", { name: "Jäsennä" }).click();
  await expect(
    page.getByRole("heading", { name: "Tarkista resepti" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Tallenna resepti" }).click();
  await expect(page).toHaveURL(/\/recipes\/\d+$/);
  const recipe = page.url();

  // Several lines are öljy: two amounts differ, one is blank and one repeats.
  await expect(page.locator(".lines li").nth(0)).toContainText("2 rkl");
  await expect(page.locator(".lines li").nth(4)).toContainText("1 dl");

  async function bothAmounts() {
    const frying = mention(page, /^öljyssä$/);
    const dressing = mention(page, /^öljy$/);
    await frying.locator("label").click();
    await dressing.locator("label").click();
    return [
      await frying.locator(".mention-amount").innerText(),
      await dressing.locator(".mention-amount").innerText(),
    ];
  }

  expect(await bothAmounts()).toEqual(["2 rkl / 1 dl", "2 rkl / 1 dl"]);

  // The same after a round-trip through the editor, which rebuilds every
  // reference from scratch. Nothing is changed on the way through.
  await page.goto(`${recipe}/edit`);
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();
  await expect(page).toHaveURL(/\/recipes\/\d+$/);

  expect(await bothAmounts()).toEqual(["2 rkl / 1 dl", "2 rkl / 1 dl"]);
});

/** Import a stubbed draft and save it as it stands. Returns the recipe's URL. */
async function importAndSave(
  page: import("@playwright/test").Page,
  draft: unknown,
  title: string,
): Promise<string> {
  await stubStructuring(page, draft);
  await page.goto("/intake");
  await page.getByLabel("Liitä reseptin teksti").fill(title);
  await page.getByRole("button", { name: "Jäsennä" }).click();
  await expect(
    page.getByRole("heading", { name: "Tarkista resepti" }),
  ).toBeVisible();
  return page.url();
}

/**
 * The editor has to hang a saved mention on some row to put it in the form, and
 * with a duplicated ingredient it picks the first one. That row is a handle,
 * not the mention's identity: repoint it while another row still carries the
 * ingredient and the mention is still true, so it has to survive.
 */
test("repointing the row a mention was anchored to keeps the mention alive", async ({
  page,
}) => {
  await importAndSave(page, ANCHOR_REPOINT_DRAFT, "Paistetut perunat");
  await page.getByRole("button", { name: "Tallenna resepti" }).click();
  await expect(page).toHaveURL(/\/recipes\/\d+$/);
  const recipe = page.url();

  const oil = mention(page, /^öljyssä$/);
  await oil.locator("label").click();
  await expect(oil.locator(".mention-amount")).toHaveText("2 rkl / 1 dl");

  // Row 0 is the first öljy line and the one the editor anchors to. Point only
  // that row somewhere else; the 1 dl öljy row is left exactly as it was.
  await page.goto(`${recipe}/edit`);
  await page.locator('select[name="line.0.ingredient"]').selectOption({
    label: "jauheliha",
  });
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();
  await expect(page).toHaveURL(/\/recipes\/\d+$/);

  // Öljy is still in the recipe, so the word still reveals what is left of it.
  const after = mention(page, /^öljyssä$/);
  await expect(after).toHaveCount(1);
  await after.locator("label").click();
  await expect(after.locator(".mention-amount")).toHaveText("1 dl");
});

/**
 * Removing a line on the review screen closes the gap in what gets saved. A
 * mention pointing at a line by its place in that list would slide onto the
 * next ingredient and reveal its amount — a wrong instruction rather than a
 * missing link, so the row carries its own identity instead.
 */
test("removing a line before saving does not slide a mention onto the next one", async ({
  page,
}) => {
  await importAndSave(page, REMOVED_LINE_DRAFT, "Haudutettu kaali");

  // Take the öljy line out. The step mentions the valkokaali line after it.
  await openDraftEditor(page);
  const first = page.locator(".edit-lines .line").first();
  await openMore(first);
  await first.locator('input[name="line.0.remove"]').check();
  await page.getByRole("button", { name: "Tallenna resepti" }).click();
  await expect(page).toHaveURL(/\/recipes\/\d+$/);

  await expect(page.locator(".lines li")).toHaveCount(2);
  await expect(page.locator(".lines li").nth(0)).toContainText("valkokaali");
  await expect(page.locator(".lines li").nth(1)).toContainText("vesi");

  const kaali = mention(page, /^kaali$/);
  await kaali.locator("label").click();
  // The cabbage's own 500 g, not the water's 1 l that took its place.
  await expect(kaali.locator(".mention-amount")).toHaveText("500 g");
});

test("mentions survive an edit that moves the text along", async ({ page }) => {
  await page.goto("/recipes/1/edit");

  // Put a clause in front of the linked words. Every character position after
  // it moves, which is exactly what a stored start/end offset could not take.
  const step = page.locator('textarea[name="step.0"]');
  await expect(step).toHaveValue("Kuullota kaali öljyssä.");
  await step.fill("Kun pannu on kuuma, kuullota kaali öljyssä.");
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();

  await page.goto("/recipes/1");
  await expect(page.locator(".steps li").nth(0)).toContainText(
    "Kun pannu on kuuma",
  );

  const kaali = mention(page, "kaali");
  await kaali.locator("label").click();
  await expect(kaali.locator(".mention-amount")).toHaveText("½ kpl (500 g)");
});
