import { expect, test } from "@playwright/test";

import { stubStructuring } from "./support/draft";
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
 * A recipe may list one ingredient twice, at two amounts, for two stages of the
 * cooking — oil to fry in and oil for the dressing. A mention names one of
 * those lines, not the ingredient in general, so each has to reveal its own
 * figure. Getting this wrong would not read as a broken link; it would read as
 * an instruction, and the wrong one.
 *
 * Built through the real import path rather than seeded, so the identity has to
 * survive being invented by the model, saved, rendered, and edited.
 */
test("two lines of one ingredient reveal their own amounts, before and after an edit", async ({
  page,
}) => {
  await stubStructuring(page, TWICE_OILED);
  await page.goto("/intake");
  await page.getByLabel("Liitä reseptin teksti").fill("Perunasalaatti");
  await page.getByRole("button", { name: "Jäsennä" }).click();
  await expect(
    page.getByRole("heading", { name: "Tarkista resepti" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Tallenna resepti" }).click();
  await expect(page).toHaveURL(/\/recipes\/\d+$/);
  const recipe = page.url();

  // Both lines are öljy; only their amounts differ.
  await expect(page.locator(".lines li").nth(0)).toContainText("2 rkl");
  await expect(page.locator(".lines li").nth(2)).toContainText("1 dl");

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

  expect(await bothAmounts()).toEqual(["2 rkl", "1 dl"]);

  // The same after a round-trip through the editor, which rebuilds every
  // reference from scratch. Nothing is changed on the way through.
  await page.goto(`${recipe}/edit`);
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();
  await expect(page).toHaveURL(/\/recipes\/\d+$/);

  expect(await bothAmounts()).toEqual(["2 rkl", "1 dl"]);
});

/**
 * Öljy twice, at two amounts, with a step naming each. The second step says
 * plain "öljy" so the two mentions are told apart by their line and not by
 * their wording.
 */
const TWICE_OILED = {
  title: "Perunasalaatti",
  yield_portions: 4,
  source_text: "Perunasalaatti\n4 annosta\n2 rkl öljyä\n500 g valkokaalia\n1 dl öljyä",
  steps: [
    {
      text: "Paista kaali öljyssä.",
      section: null,
      phase: null,
      ingredient_refs: [{ line: 0, matched_text: "öljyssä", approx_position: 13 }],
    },
    {
      text: "Sekoita loppu öljy joukkoon.",
      section: null,
      phase: null,
      ingredient_refs: [{ line: 2, matched_text: "öljy", approx_position: 14 }],
    },
  ],
  lines: [
    {
      quantity: 2, quantity_max: null, unit: "rkl",
      alt_quantity: null, alt_unit: null,
      ingredient_id: 1, ingredient_name: "öljy", source_line: "2 rkl öljyä",
      section: null, phase: null, note: null,
    },
    {
      quantity: 500, quantity_max: null, unit: "g",
      alt_quantity: null, alt_unit: null,
      ingredient_id: 3, ingredient_name: "valkokaali",
      source_line: "500 g valkokaalia",
      section: null, phase: null, note: null,
    },
    {
      quantity: 1, quantity_max: null, unit: "dl",
      alt_quantity: null, alt_unit: null,
      ingredient_id: 1, ingredient_name: "öljy", source_line: "1 dl öljyä",
      section: null, phase: null, note: null,
    },
  ],
};

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
