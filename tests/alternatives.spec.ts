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

/**
 * The Cast payload the recipe screen is holding, read off the sender's own
 * data attribute rather than through the SDK stub — this is the same JSON the
 * receiver is handed, and none of these cases is about the sending itself.
 */
async function castPayload(page: Page): Promise<{
  ingredients: Array<{ title: string; items: string[] }>;
}> {
  const encoded = await page
    .locator("#cast-recipe")
    .getAttribute("data-recipe");
  return JSON.parse(decodeURIComponent(encoded ?? ""));
}

const LASAGNE = 3;

test("a group cannot be split across the cooking sections", async ({ page }) => {
  // Lasagne is written in named parts, so its own lines carry a phase and the
  // cooking view draws before-parts and after-parts apart.
  await page.goto(`/recipes/${LASAGNE}/edit`);

  const sheets = page.locator(".line").first();
  await openMore(sheets);
  await sheets.getByLabel("Vaihtoehtoryhmä (sama numero = tai)").fill("1");
  await sheets
    .getByLabel("Milloin tämä tehdään?")
    .selectOption("after_parts");

  await addIngredientRow(page);
  const added = page.locator(".line").nth(1);
  await added.locator("select").first().selectOption({ label: "ananas" });
  await added.locator("input[name$=quantity]").fill("1");
  await openMore(added);
  await added.getByLabel("Vaihtoehtoryhmä (sama numero = tai)").fill("1");
  await added
    .getByLabel("Milloin tämä tehdään?")
    .selectOption("before_parts");

  await page.getByRole("button", { name: "Tallenna muutokset" }).click();

  // Refused rather than saved as two lone lines that the shopping list would
  // still have counted as a pair.
  await expect(page.locator(".refused")).toContainText(
    "Saman vaihtoehtoryhmän rivien pitää olla samassa osassa ja vaiheessa",
  );
  await expect(page).toHaveURL(new RegExp(`/recipes/${LASAGNE}$`));

  // And the recipe is untouched: still one own line, still no `tai` anywhere.
  await page.goto(`/recipes/${LASAGNE}`);
  await expect(page.locator(".recipe-ingredient.is-alternative")).toHaveCount(0);
  await expect(page.locator(".alt-or")).toHaveCount(0);
});

test("a group inside one section still saves on a multipart dish", async ({
  page,
}) => {
  await page.goto(`/recipes/${LASAGNE}/edit`);

  const sheets = page.locator(".line").first();
  await openMore(sheets);
  await sheets.getByLabel("Vaihtoehtoryhmä (sama numero = tai)").fill("1");
  await sheets
    .getByLabel("Milloin tämä tehdään?")
    .selectOption("after_parts");

  await addIngredientRow(page);
  const added = page.locator(".line").nth(1);
  await added.locator("select").first().selectOption({ label: "ananas" });
  await added.locator("input[name$=quantity]").fill("1");
  await openMore(added);
  await added.getByLabel("Vaihtoehtoryhmä (sama numero = tai)").fill("1");
  await added
    .getByLabel("Milloin tämä tehdään?")
    .selectOption("after_parts");

  await page.getByRole("button", { name: "Tallenna muutokset" }).click();
  await expect(page).toHaveURL(new RegExp(`/recipes/${LASAGNE}$`));

  const choice = page.locator(".recipe-ingredient.is-alternative");
  await expect(choice).toHaveCount(1);
  await expect(choice.locator(".alt-or")).toHaveText("tai");
});

/**
 * Give Kaalilaatikko's oil an alternative that shares its source sentence, the
 * way an import writes one: the page said one thing, and each option is a
 * reading of it.
 */
async function addImportedAlternative(page: Page): Promise<void> {
  const sentence = "½ dl öljyä tai voita";

  await page.goto(`/recipes/${KAALILAATIKKO}/edit`);
  const oil = page.locator(".line").first();
  await openMore(oil);
  await oil.getByLabel("Vaihtoehtoryhmä (sama numero = tai)").fill("1");
  await oil.getByLabel("Lähderivi").fill(sentence);

  await addIngredientRow(page);
  const added = page.locator(".line").nth(4);
  await added.locator("select").selectOption({ label: "Luo uusi aines" });
  await added.locator("input[name$=quantity]").fill("0,5");
  await openMore(added);
  await added.getByLabel("Yksikkö", { exact: true }).fill("dl");
  await added.getByLabel("Uuden aineksen nimi").fill("voi");
  await added.getByLabel("Vaihtoehtoryhmä (sama numero = tai)").fill("1");
  await added.getByLabel("Lähderivi").fill(sentence);

  await page.getByRole("button", { name: "Tallenna muutokset" }).click();
  await expect(page).toHaveURL(new RegExp(`/recipes/${KAALILAATIKKO}$`));
}

test("a scaled imported alternative states its source sentence once", async ({
  page,
}) => {
  await addImportedAlternative(page);
  await page.goto(`/recipes/${KAALILAATIKKO}?multiplier=2`);

  const choice = page.locator(".recipe-ingredient.is-alternative");
  await expect(choice).toContainText("1 dl öljy");
  await expect(choice).toContainText("1 dl voi");

  // Both options are worth showing at 2x, and both name the same sentence. It
  // is said once for the row, not repeated under each option.
  await expect(choice.locator(".source")).toHaveCount(1);
  await expect(choice.locator(".source")).toHaveText("½ dl öljyä tai voita");
  // One `tai` joining the options, and no second one nested inside a source.
  await expect(choice.locator(".alt-or")).toHaveCount(1);
});

test("the scaled Cast line is one choice, not a choice inside a choice", async ({
  page,
}) => {
  await addImportedAlternative(page);
  await page.goto(`/recipes/${KAALILAATIKKO}?multiplier=2`);

  const payload = await castPayload(page);
  const items = payload.ingredients.flatMap((group) => group.items);
  const choice = items.find((item) => item.includes("öljy"));

  expect(choice).toBe("1 dl öljy tai 1 dl voi · ½ dl öljyä tai voita");
  // The options are joined by exactly one ` tai `, and the source sentence
  // appears once rather than inside each option.
  expect(choice!.split(" · ")).toHaveLength(2);
  expect(choice!.split(" · ")[0]!.split(" tai ")).toHaveLength(2);
});

test("the recipe JSON keeps its shape, alternatives included", async ({
  page,
}) => {
  await addImportedAlternative(page);

  const response = await page.request.get(`/api/recipes/${KAALILAATIKKO}`);
  expect(response.ok()).toBe(true);
  const { recipe } = (await response.json()) as {
    recipe: Record<string, unknown> & {
      lines: Array<Record<string, unknown>>;
    };
  };

  // The wire shape is pinned, not inferred: a field joining or leaving it is a
  // decision somebody has to make here rather than a spread quietly carrying
  // one through.
  expect(Object.keys(recipe).sort()).toEqual([
    "createdAt",
    "createdBy",
    "id",
    "imageKey",
    "lines",
    "parts",
    "revision",
    "sourceRoute",
    "sourceText",
    "steps",
    "title",
    "yieldPortions",
  ]);
  expect(Object.keys(recipe.lines[0]!).sort()).toEqual([
    "altQuantity",
    "altUnit",
    "alternativeGroup",
    "ingredient",
    "position",
    "quantity",
    "quantityMax",
    "sourceLine",
    "unit",
  ]);

  // And the group is really on the wire: without it a caller adding these
  // lines up would buy both the oil and the butter.
  const grouped = recipe.lines.filter(
    (line) => line["alternativeGroup"] !== null,
  );
  expect(grouped.map((line) => line["ingredient"])).toEqual(["öljy", "voi"]);
  expect(new Set(grouped.map((line) => line["alternativeGroup"]))).toEqual(
    new Set([1]),
  );
});
