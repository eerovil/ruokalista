import { expect, test } from "@playwright/test";

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

/** The mention whose word is `word`, anywhere in the method. */
function mention(page: import("@playwright/test").Page, word: string) {
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
