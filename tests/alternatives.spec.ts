import { expect, test, type Page } from "@playwright/test";

import { addIngredientRow, openMore } from "./support/lines";
import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * A recipe line that offers a choice: öljyä **tai** margariinia (#183).
 *
 * Every case here builds the group through the editor rather than seeding one,
 * because the group is only worth anything if a member can make it — and
 * because the save path is where the two rules that cannot live in a database
 * `CHECK` are enforced: a group of one is dissolved, and the numbers are
 * renumbered from one.
 */

const KAALILAATIKKO = 1;

test.beforeEach(async ({ context }) => {
  // Each case rewrites the same seeded recipe, and one of them coins a new
  // global ingredient, so every one starts from a fresh database.
  reseed();
  await context.addCookies([sessionCookie(1)]);
});

/**
 * Add "½ dl margariinia" to Kaalilaatikko as an alternative to its oil.
 *
 * `group` is what goes in both rows' group boxes; passing different numbers is
 * how a case says "these are not a pair".
 */
async function addMargarine(
  page: Page,
  { oilGroup, margarineGroup }: { oilGroup: string; margarineGroup: string },
): Promise<void> {
  await page.goto(`/recipes/${KAALILAATIKKO}/edit`);

  const oil = page.locator(".line").first();
  await openMore(oil);
  await oil.getByLabel("Vaihtoehtoryhmä (sama numero = tai)").fill(oilGroup);

  await addIngredientRow(page);
  const added = page.locator(".line").nth(4);
  await added.locator("select").selectOption({ label: "Luo uusi aines" });
  await added.locator("input[name$=quantity]").fill("0,5");
  await openMore(added);
  await added.getByLabel("Yksikkö", { exact: true }).fill("dl");
  await added.getByLabel("Uuden aineksen nimi").fill("margariini");
  await added
    .getByLabel("Vaihtoehtoryhmä (sama numero = tai)")
    .fill(margarineGroup);

  await page.getByRole("button", { name: "Tallenna muutokset" }).click();
  await expect(page).toHaveURL(new RegExp(`/recipes/${KAALILAATIKKO}$`));
}

test("two rows sharing a group number read as one `tai` line", async ({
  page,
}) => {
  await addMargarine(page, { oilGroup: "1", margarineGroup: "1" });

  // Five stored lines, four things to read: the pair is one row.
  await expect(page.locator(".recipe-ingredient")).toHaveCount(4);

  const choice = page.locator(".recipe-ingredient.is-alternative");
  await expect(choice).toHaveCount(1);
  await expect(choice.locator(".alt-or")).toHaveText("tai");
  // Each option keeps its own amount and its own unit, which is the whole
  // reason an option is a line rather than a word in an ingredient's name.
  await expect(choice).toContainText("½ dl öljy");
  await expect(choice).toContainText("½ dl margariini");
});

test("the group sits where its first option sat, not at the end", async ({
  page,
}) => {
  await addMargarine(page, { oilGroup: "1", margarineGroup: "1" });

  const first = page.locator(".recipe-ingredient").first();
  await expect(first).toHaveClass(/is-alternative/);
  await expect(first).toContainText("öljy");
});

test("a group of one is not a choice, so the save dissolves it", async ({
  page,
}) => {
  await addMargarine(page, { oilGroup: "1", margarineGroup: "2" });

  // Two rows, two group numbers, nothing to choose between: five plain lines.
  await expect(page.locator(".recipe-ingredient")).toHaveCount(5);
  await expect(page.locator(".recipe-ingredient.is-alternative")).toHaveCount(0);

  // And the boxes come back empty, rather than keeping a number that means
  // nothing.
  await page.goto(`/recipes/${KAALILAATIKKO}/edit`);
  const oil = page.locator(".line").first();
  await openMore(oil);
  await expect(
    oil.getByLabel("Vaihtoehtoryhmä (sama numero = tai)"),
  ).toHaveValue("");
});

test("the numbers are renumbered from one, whatever was typed", async ({
  page,
}) => {
  await addMargarine(page, { oilGroup: "40", margarineGroup: "40" });

  await expect(page.locator(".recipe-ingredient.is-alternative")).toHaveCount(1);

  await page.goto(`/recipes/${KAALILAATIKKO}/edit`);
  const oil = page.locator(".line").first();
  await openMore(oil);
  await expect(
    oil.getByLabel("Vaihtoehtoryhmä (sama numero = tai)"),
  ).toHaveValue("1");
});

test("a group number that is not a number is refused, not quietly dropped", async ({
  page,
}) => {
  await page.goto(`/recipes/${KAALILAATIKKO}/edit`);
  const oil = page.locator(".line").first();
  await openMore(oil);
  await oil.getByLabel("Vaihtoehtoryhmä (sama numero = tai)").fill("-1");
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();

  await expect(page.locator(".refused")).toContainText(
    "Vaihtoehtoryhmän pitää olla positiivinen kokonaisluku",
  );
});

test("only the first option of a group reaches the shopping list", async ({
  page,
}) => {
  await addMargarine(page, { oilGroup: "1", margarineGroup: "1" });

  const today = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Helsinki",
  }).format(new Date());
  const created = await page.request.post("/api/batches", {
    data: {
      date: today,
      slot: "dinner",
      recipeId: KAALILAATIKKO,
      multiplier: 1,
    },
  });
  expect(created.status()).toBe(201);

  await page.goto("/ostoslista");

  // The oil is bought and the margarine is not: a choice is one thing to buy.
  await expect(page.locator(".shopping-item[data-haku='öljy']")).toHaveCount(1);
  await expect(
    page.locator(".shopping-item[data-haku='margariini']"),
  ).toHaveCount(0);
});
