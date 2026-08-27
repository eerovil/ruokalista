import { expect, test, type Page } from "@playwright/test";

import { onePixelPng } from "./support/png";
import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * Sharing a recipe between households (#143).
 *
 * The two households in `dev/seed.sql` are what makes this testable at all:
 * member 1 is Koti's, member 2 is Naapuri's, and every assertion below is
 * really "does the wall hold in the one place it was deliberately opened". The
 * seed ships one already-published recipe — Naapuri's uunikala — so the
 * read-only side has something to be read; everything about publishing is
 * driven through the screens, because the screens are the feature.
 */

test.beforeEach(reseed);

/** Today in Helsinki, which is what the Worker means by today. */
function today(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Helsinki",
  }).format(new Date());
}

async function signIn(page: Page, memberId: number): Promise<void> {
  await page.context().clearCookies();
  await page.context().addCookies([sessionCookie(memberId)]);
}

/** Publish one of Koti's recipes from its own screen, as Koti. */
async function publish(page: Page, recipeId: number): Promise<void> {
  await signIn(page, 1);
  await page.goto(`/recipes/${recipeId}`);
  await page.getByRole("button", { name: "Julkaise resepti" }).click();
  await expect(page.locator(".recipe-sharing")).toContainText(
    "näkyy kaikille talouksille",
  );
}

test("a published recipe reaches the other household, and can be planned", async ({
  page,
}) => {
  await publish(page, 1);

  await signIn(page, 2);
  await page.goto("/recipes/julkiset");
  await expect(page.locator(".recipes a")).toContainText("Kaalilaatikko");
  await expect(page.locator(".recipes .meta").first()).toContainText("Koti");

  // Reading it works, and says whose it is.
  await page.getByRole("link", { name: /Kaalilaatikko/ }).click();
  await expect(page.locator(".shared-from")).toContainText("Koti");
  await expect(page.locator(".lines li").first()).toContainText("½ dl");

  // And it can go on the week, the same as an own recipe.
  await page.goto("/picker?date=2026-09-01&slot=dinner");
  const row = page.locator(".pick li", { hasText: "Kaalilaatikko" });
  await expect(row.locator(".meta")).toContainText("Koti");
  await row.getByRole("button", { name: "Lisää" }).click();
  await expect(page.locator(".day", { hasText: "tiistai" })).toContainText(
    "Kaalilaatikko",
  );
});

test("the other household cannot edit a published recipe", async ({ page }) => {
  await publish(page, 1);
  await signIn(page, 2);

  // No way in from the screen…
  await page.goto("/recipes/1");
  await expect(page.getByRole("link", { name: "Muokkaa reseptiä" })).toHaveCount(0);
  await expect(page.locator(".recipe-sharing")).not.toContainText("Julkaisu");

  // …and none by typing the address either. Editing, deleting and unpublishing
  // are all the owner's, and each refuses on its own rather than relying on the
  // link being absent.
  await expect((await page.goto("/recipes/1/edit"))?.status()).toBe(404);
  await expect((await page.goto("/recipes/1/delete"))?.status()).toBe(404);

  const refused = await page.request.post("/recipes/julkaisu", {
    form: { action: "unpublish", recipeId: "1" },
  });
  expect(refused.status()).toBe(400);
  await page.goto("/recipes/1");
  await expect(page.locator(".shared-from")).toBeVisible();
});

test("a published recipe's picture is readable by the other household", async ({
  page,
}) => {
  await signIn(page, 1);
  // Koti's cabbage bake, its lasagne, that lasagne's meat sauce, and a recipe
  // that stays private — every one of them with a picture, so what is being
  // measured below is the scope and not whether an image exists.
  for (const id of [1, 2, 3, 4]) {
    const put = await page.request.put(`/api/recipes/${id}/image`, {
      headers: { "content-type": "image/png" },
      data: onePixelPng(),
    });
    expect(put.status()).toBe(204);
  }
  await publish(page, 1);
  await publish(page, 3);

  await signIn(page, 2);
  // The published dish, and a part of a published dish — a part is never
  // published on its own, but it is read through its parent, so its picture
  // has to be reachable the same way.
  expect((await page.request.get("/api/recipes/1/image")).status()).toBe(200);
  expect((await page.request.get("/api/recipes/3/image")).status()).toBe(200);
  expect((await page.request.get("/api/recipes/4/image")).status()).toBe(200);
  // The private one is still a 404, not a picture.
  expect((await page.request.get("/api/recipes/2/image")).status()).toBe(404);

  // Widening the read did not widen a write: the picture of somebody else's
  // published recipe is still theirs to change.
  expect(
    (
      await page.request.put("/api/recipes/1/image", {
        headers: { "content-type": "image/png" },
        data: onePixelPng(),
      })
    ).status(),
  ).toBe(404);
  expect((await page.request.delete("/api/recipes/1/image")).status()).toBe(404);

  // And it is a picture on the screen rather than a broken-image icon, both in
  // the public list and on the recipe itself.
  await page.goto("/recipes/julkiset");
  const thumb = page
    .locator(".recipes li", { hasText: "Kaalilaatikko" })
    .locator(".recipe-image img");
  await expect(thumb).toBeVisible();
  await expect(thumb).toHaveJSProperty("complete", true);
  await expect(thumb).not.toHaveJSProperty("naturalWidth", 0);

  await page.goto("/recipes/1");
  const hero = page.locator(".recipe-image.is-hero img");
  await expect(hero).toBeVisible();
  await expect(hero).toHaveJSProperty("complete", true);
  await expect(hero).not.toHaveJSProperty("naturalWidth", 0);
});

test("an unpublished recipe stays invisible to the other household", async ({
  page,
}) => {
  await signIn(page, 2);

  // Koti's recipes are all private in the seed.
  await page.goto("/recipes/julkiset");
  await expect(page.locator(".recipes li")).toHaveCount(0);
  await expect((await page.goto("/recipes/1"))?.status()).toBe(404);
  await expect((await page.goto("/api/recipes/1"))?.status()).toBe(404);

  // Its own list is its own list: a public recipe is not mixed into it.
  await page.goto("/recipes");
  await expect(page.locator(".recipes li")).toHaveCount(1);
  await expect(page.locator(".recipes a")).toContainText("Naapurin uunikala");
});

test("an edit by the owner is what the other household reads", async ({
  page,
}) => {
  await publish(page, 1);

  await signIn(page, 1);
  await page.goto("/recipes/1/edit");
  await page.locator("#title").fill("Kaalilaatikko (korjattu)");
  await page.getByRole("button", { name: "Tallenna muutokset" }).last().click();
  await expect(page.locator("h1")).toContainText("Kaalilaatikko (korjattu)");

  await signIn(page, 2);
  await page.goto("/recipes/1");
  await expect(page.locator("h1")).toContainText("Kaalilaatikko (korjattu)");
});

test("publishing and unpublishing work on a selection of recipes", async ({
  page,
}) => {
  await signIn(page, 1);
  await page.goto("/recipes");

  await page.getByLabel("Valitse Kaalilaatikko").check();
  await page.getByLabel("Valitse Öljykastike").check();
  await page.getByRole("button", { name: "Julkaise valitut" }).click();

  await expect(page.locator(".done")).toContainText("2 reseptiä");
  await expect(page.locator(".badge.is-published")).toHaveCount(2);

  await signIn(page, 2);
  await page.goto("/recipes/julkiset");
  await expect(page.locator(".recipes li")).toHaveCount(2);

  await signIn(page, 1);
  await page.goto("/recipes");
  await page.getByLabel("Valitse Kaalilaatikko").check();
  await page.getByLabel("Valitse Öljykastike").check();
  await page.getByRole("button", { name: "Poista julkaisu valituista" }).click();

  await expect(page.locator(".badge.is-published")).toHaveCount(0);
});

test("a multipart dish is published as one dish, parts and all", async ({
  page,
}) => {
  // Recipe 3 is the lasagne; 4 and 5 are its parts.
  await publish(page, 3);
  await signIn(page, 2);

  await page.goto("/recipes/julkiset");
  await expect(page.locator(".recipes li")).toHaveCount(1);
  await expect(page.locator(".recipes a")).toContainText("Lasagne");

  // The parts are readable through the dish, which is where a cook needs them.
  await page.goto("/recipes/3");
  const parts = page.locator("section.part h2");
  await expect(parts.nth(0)).toContainText("Jauhelihakastike");
  await expect(parts.nth(1)).toContainText("Juustokastike");
  await expect(page.locator("section.part .lines li").first()).toContainText("400 g");

  // But a part is not a record this household can address, and it never became
  // publishable on its own.
  await expect((await page.goto("/recipes/4"))?.status()).toBe(404);

  // The picker offers Naapuri's own recipe and the shared dish — and neither
  // part, because only dishes are planned.
  await page.goto("/picker?date=2026-09-01&slot=dinner");
  await expect(page.locator(".pick li")).toHaveCount(2);
  await expect(page.locator(".pick")).not.toContainText("Juustokastike");
});

test("unpublishing is refused while another household plans it for a day still to come", async ({
  page,
}) => {
  await publish(page, 1);
  await plan(page, 2, "2099-01-01", 1);

  await signIn(page, 1);
  await page.goto("/recipes/1");
  await page.getByRole("button", { name: "Poista julkaisu" }).click();
  await expect(page.locator(".refused")).toContainText("tulevalla ruokalistalla");
  await expect(page.locator(".recipe-sharing")).toContainText(
    "näkyy kaikille talouksille",
  );

  // Deleting is refused one step earlier and says which step comes first, so
  // the two rules cannot drift apart.
  await page.goto("/recipes/1/delete");
  await expect(page.locator(".refused")).toContainText("on julkaistu");
});

test("a cooking that already happened does not block unpublishing", async ({
  page,
}) => {
  await publish(page, 1);
  await plan(page, 2, "2020-01-06", 1);

  await signIn(page, 1);
  await page.goto("/recipes/1");
  await page.getByRole("button", { name: "Poista julkaisu" }).click();
  await expect(page.locator(".recipe-sharing")).toContainText(
    "näkyy vain omalle taloudelle",
  );

  // The other household's week still reads correctly afterwards: the batch is a
  // record of a cooking, and taking the recipe private does not rewrite it.
  await signIn(page, 2);
  await page.goto("/?week=2020-01-06");
  await expect(page.locator(".day", { hasText: "maanantai" })).toContainText(
    "Kaalilaatikko",
  );
});

/** Put a recipe on a household's week, without going through the picker. */
async function plan(
  page: Page,
  memberId: number,
  date: string,
  recipeId: number,
): Promise<void> {
  await signIn(page, memberId);
  const response = await page.request.post("/api/batches", {
    data: { date, slot: "dinner", recipeId, portions: 4 },
  });
  expect(response.status()).toBe(201);
}

test("a published recipe cannot be deleted until it is private again", async ({
  page,
}) => {
  await publish(page, 2);
  await signIn(page, 1);

  await page.goto("/recipes/2/delete");
  await expect(page.locator(".refused")).toContainText("Poista ensin");
  expect(
    (await page.request.delete("/api/recipes/2")).status(),
  ).toBe(409);

  await page.goto("/recipes/2");
  await page.getByRole("button", { name: "Poista julkaisu" }).click();
  await page.goto("/recipes/2/delete");
  await page.getByRole("button", { name: "Poista lopullisesti" }).click();
  await expect(page).toHaveURL(/\/recipes$/);
  await expect(page.locator(".recipes")).not.toContainText("Öljykastike");
});

test("a public recipe feeds the other household's shopping list and cupboard", async ({
  page,
}) => {
  // Naapuri's uunikala is published in the seed and uses öljy, vettä and
  // naapurin suola — all now one global ingredient each.
  await signIn(page, 1);
  await page.goto(`/picker?date=${today()}&slot=dinner`);
  await page
    .locator(".pick li", { hasText: "Naapurin uunikala" })
    .getByRole("button", { name: "Lisää" })
    .click();

  await page.goto("/ostoslista");
  const salt = page.locator(".shopping-list > li", { hasText: "naapurin suola" });
  await expect(salt).toHaveCount(1);

  // The cupboard covers it by ingredient id, which is the same id in both
  // households now — that is the whole reason the dictionary went global. The
  // row is a disclosure, so it opens before its buttons exist to a person.
  await salt.locator("summary").click();
  await salt.getByRole("button", { name: "Löytyy jo kaapista" }).click();
  await page.goto("/kaappi");
  await expect(page.locator("body")).toContainText("naapurin suola");
});

test("renaming a global ingredient is an admin operation", async ({ page }) => {
  await signIn(page, 1);
  await page.goto("/ingredients");
  // Every member reads the dictionary…
  await expect(page.locator(".ingredient-name").first()).toBeVisible();
  // …and an ordinary one is offered no way to rewrite it for everybody.
  await expect(page.locator(".rename form")).toHaveCount(0);
  expect(
    (await page.request.post("/ingredients/1/rename", { form: { name: "rasva" } }))
      .status(),
  ).toBe(404);
  expect(
    (
      await page.request.patch("/api/ingredients/1", { data: { name: "rasva" } })
    ).status(),
  ).toBe(404);

  await signIn(page, 3);
  await page.goto("/ingredients");
  const oil = page.locator(".ingredients li", { hasText: "valkokaali" });
  await oil.locator("summary").click();
  await oil.getByLabel("Aineksen nimi").fill("kaali");
  await oil.getByRole("button", { name: "Tallenna" }).click();
  await expect(page.locator(".ingredients")).toContainText("kaali");
});

test("each household keeps its own default portions for the same recipe", async ({
  page,
}) => {
  await publish(page, 1);

  // Koti always cooks it for nine.
  await signIn(page, 1);
  await page.goto("/recipes/1");
  await page.getByLabel("Oletusannokset").fill("9");
  await page.locator(".portions-preference button").click();
  await expect(page.getByLabel("Oletusannokset")).toHaveValue("9");

  // Naapuri is two people, and Koti's habit is not theirs.
  await signIn(page, 2);
  await page.goto("/recipes/1");
  await expect(page.getByLabel("Oletusannokset")).toHaveValue("");
  await page.getByLabel("Oletusannokset").fill("2");
  await page.locator(".portions-preference button").click();

  await page.goto("/picker?date=2099-03-03&slot=lunch");
  await expect(
    page.locator(".pick li", { hasText: "Kaalilaatikko" }).getByLabel("Annoksia"),
  ).toHaveValue("2");

  await signIn(page, 1);
  await page.goto("/picker?date=2099-03-03&slot=lunch");
  await expect(
    page.locator(".pick li", { hasText: "Kaalilaatikko" }).getByLabel("Annoksia"),
  ).toHaveValue("9");
});
