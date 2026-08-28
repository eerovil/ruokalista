import { expect, test, type Page } from "@playwright/test";

import { onePixelPng } from "./support/png";
import { executeLocalSql, reseed } from "./support/seed";
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
  await page.getByLabel("Julkinen").check();
  await page.getByRole("button", { name: "Tallenna jako" }).click();
  await expect(page.locator(".recipe-sharing")).toContainText(
    "näkyy kaikille kirjautuneille talouksille",
  );
}

async function makePrivate(page: Page, recipeId: number): Promise<void> {
  await signIn(page, 1);
  await page.goto(`/recipes/${recipeId}`);
  await page.getByLabel("Oma").check();
  await page.getByRole("button", { name: "Tallenna jako" }).click();
}

async function shareWith(
  page: Page,
  recipeId: number,
  householdNames: string[],
): Promise<void> {
  await signIn(page, 1);
  await page.goto(`/recipes/${recipeId}`);
  await page.getByLabel("Valituille").check();
  const picker = page.locator(".recipient-picker");
  for (const name of householdNames) await picker.getByLabel(name).check();
  await page.getByRole("button", { name: "Tallenna jako" }).click();
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

test("selected households can be found, added and safely removed", async ({
  page,
}) => {
  executeLocalSql(`
    INSERT INTO household (id, name) VALUES (3, 'Mökki');
    INSERT INTO member
      (id, household_id, google_sub, display_name, email, is_admin)
    VALUES (4, 3, 'dev-seed-mokki', 'Salla', 'salla@example.com', 0)
  `);

  await signIn(page, 1);
  await page.goto("/recipes/1");
  const picker = page.locator(".recipient-picker");
  await expect(picker).toContainText("Naapuri");
  await expect(picker).toContainText("Mökki");
  await expect(picker).not.toContainText("Salla");
  await expect(picker).not.toContainText("salla@example.com");

  await picker.getByLabel("Hae vastaanottavaa taloutta").fill("mö");
  await expect(picker.getByLabel("Mökki")).toBeVisible();
  await expect(picker.getByLabel("Naapuri")).toBeHidden();
  await picker.getByLabel("Hae vastaanottavaa taloutta").fill("");

  await page.getByLabel("Valituille").check();
  await picker.getByLabel("Naapuri").check();
  await page.getByRole("button", { name: "Tallenna jako" }).click();
  await expect(page.locator(".recipe-sharing")).toContainText(
    "Tämä resepti on jaettu: Naapuri.",
  );

  await page.goto("/recipes");
  await expect(
    page.locator(".recipes li", { hasText: "Kaalilaatikko" }),
  ).toContainText("Jaettu 1 taloudelle");

  await signIn(page, 2);
  await page.goto("/recipes/julkiset");
  const shared = page.locator(".recipes li", { hasText: "Kaalilaatikko" });
  await expect(shared).toContainText("Jaettu sinulle");
  await shared.getByRole("link").click();
  await expect(page.locator(".shared-from")).toContainText("Koti");
  const api = await page.request.get("/api/recipes/1");
  expect(api.status()).toBe(200);
  const body = (await api.json()) as { recipe: { createdBy: string } };
  expect(body.recipe.createdBy).toBe("Koti");
  expect(JSON.stringify(body)).not.toContain("Eero");

  await plan(page, 2, today(), 1);
  await page.goto("/ostoslista");
  const cabbage = page.locator(".shopping-list > li", { hasText: "valkokaali" });
  await expect(cabbage).toHaveCount(1);
  await cabbage.locator("summary").click();
  await cabbage.getByRole("button", { name: "Löytyy jo kaapista" }).click();
  await page.goto("/kaappi");
  await expect(page.locator("body")).toContainText("valkokaali");

  await signIn(page, 4);
  await expect((await page.goto("/recipes/1"))?.status()).toBe(404);
  expect((await page.request.get("/api/recipes/1")).status()).toBe(404);
  expect(
    (await page.request.post("/api/batches", {
      data: { date: "2099-02-01", slot: "lunch", recipeId: 1, multiplier: 1 },
    })).status(),
  ).toBe(400);

  await signIn(page, 1);
  await page.goto("/recipes/1");
  await picker.getByLabel("Mökki").check();
  await page.getByRole("button", { name: "Tallenna jako" }).click();
  await expect(page.locator(".recipe-sharing")).toContainText("Mökki, Naapuri");

  await signIn(page, 4);
  await expect((await page.goto("/recipes/1"))?.status()).toBe(200);

  await signIn(page, 1);
  await page.goto("/recipes/1");
  await picker.getByLabel("Naapuri").uncheck();
  await page.getByRole("button", { name: "Tallenna jako" }).click();
  await expect(page.locator(".refused")).toContainText("tulevalla ruokalistalla");
  await expect(picker.getByLabel("Mökki")).toBeChecked();
  await expect(picker.getByLabel("Naapuri")).not.toBeChecked();

  executeLocalSql(`
    DELETE FROM batch_occurrence
     WHERE batch_id IN (
       SELECT id FROM planned_batch WHERE household_id = 2 AND recipe_id = 1
     );
    DELETE FROM planned_batch WHERE household_id = 2 AND recipe_id = 1
  `);
  await page.getByRole("button", { name: "Tallenna jako" }).click();

  await signIn(page, 2);
  await expect((await page.goto("/recipes/1"))?.status()).toBe(404);
  await signIn(page, 4);
  await expect((await page.goto("/recipes/1"))?.status()).toBe(200);
  await expect(page.getByRole("link", { name: "Muokkaa reseptiä" })).toHaveCount(0);
});

test("planning and revocation cannot both win the same race", async ({ page }) => {
  await shareWith(page, 1, ["Naapuri"]);
  const browser = page.context().browser();
  expect(browser).not.toBeNull();
  const owner = await browser!.newContext();
  const recipient = await browser!.newContext();
  const origin = new URL(page.url()).origin;
  await owner.addCookies([sessionCookie(1)]);
  await recipient.addCookies([sessionCookie(2)]);

  try {
    const [revoke, planning] = await Promise.all([
      owner.request.post(`${origin}/recipes/julkaisu`, {
        form: { action: "save", recipeId: "1", visibility: "private" },
        maxRedirects: 0,
      }),
      recipient.request.post(`${origin}/api/batches`, {
        data: {
          date: "2099-04-01",
          slot: "dinner",
          recipeId: 1,
          multiplier: 1,
        },
      }),
    ]);

    if (planning.status() === 201) {
      expect(revoke.status()).toBe(400);
      expect((await recipient.request.get(`${origin}/recipes/1`)).status()).toBe(200);
    } else {
      expect(planning.status()).toBe(400);
      expect(revoke.status()).toBe(303);
      expect((await recipient.request.get(`${origin}/recipes/1`)).status()).toBe(404);
    }
  } finally {
    await owner.close();
    await recipient.close();
  }
});

test("a revoked historical batch cannot be moved back into the future", async ({
  page,
}) => {
  await shareWith(page, 1, ["Naapuri"]);
  await signIn(page, 2);
  const planned = await page.request.post("/api/batches", {
    data: { date: "2020-01-06", slot: "dinner", recipeId: 1, multiplier: 1 },
  });
  expect(planned.status()).toBe(201);
  const { id } = (await planned.json()) as { id: number };

  await makePrivate(page, 1);
  await signIn(page, 2);
  const moved = await page.request.patch(`/api/batches/${id}`, {
    data: { occurrences: [{ date: "2099-04-02", slot: "dinner" }] },
  });
  expect(moved.status()).toBe(400);
  await expect((await page.goto("/recipes/1"))?.status()).toBe(404);
  await page.goto("/ostoslista");
  await expect(page.locator("body")).not.toContainText("valkokaali");
});

test("selected sharing has an explicit recipient cap", async ({ page }) => {
  const households = Array.from({ length: 51 }, (_, index) => ({
    id: index + 10,
    name: `Talous ${index + 1}`,
  }));
  executeLocalSql(
    `INSERT INTO household (id, name) VALUES ${households
      .map((household) => `(${household.id}, '${household.name}')`)
      .join(", ")}`,
  );
  await signIn(page, 1);
  await page.goto("/recipes/1");
  await page.getByLabel("Valituille").check();
  const picker = page.locator(".recipient-picker");
  for (const household of households) {
    await picker.getByLabel(household.name, { exact: true }).check();
  }
  await page.getByRole("button", { name: "Tallenna jako" }).click();
  await expect(page.locator(".refused")).toContainText("enintään 50");

  // The exact boundary is a valid save and must also fit D1's 100-parameter
  // statement limit.
  await picker.getByLabel(households[50]!.name, { exact: true }).uncheck();
  await page.getByRole("button", { name: "Tallenna jako" }).click();
  await expect(page.locator(".refused")).toHaveCount(0);
  await expect(picker.locator('input[name="recipientId"]:checked')).toHaveCount(50);
  await expect(page.locator(".recipe-sharing > p.empty")).not.toContainText("Talous 51");

  // The checked recipients are preserved after refusal, but are irrelevant to
  // a public target and therefore must not hit D1's binding limit.
  await page.getByLabel("Julkinen").check();
  await page.getByRole("button", { name: "Tallenna jako" }).click();
  await expect(page.locator(".recipe-sharing")).toContainText(
    "näkyy kaikille kirjautuneille talouksille",
  );
});

test("the other household cannot edit a published recipe", async ({ page }) => {
  await publish(page, 1);
  await signIn(page, 2);

  // No way in from the screen…
  await page.goto("/recipes/1");
  await expect(page.getByRole("link", { name: "Muokkaa reseptiä" })).toHaveCount(0);
  await expect(page.locator(".recipe-sharing")).not.toContainText("Jakaminen");

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
  await shareWith(page, 3, ["Naapuri"]);

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

test("a public recipe uses the reader's product picture without changing JSON", async ({
  page,
}) => {
  await shareWith(page, 3, ["Naapuri"]);
  executeLocalSql(`
    INSERT INTO recipe_ingredient_product
      (household_id, recipe_id, ingredient_id, ean, name, image_url)
    VALUES
      (1, 3, 9, 'owner-milk', 'Owner milk', 'https://products.example/owner.png'),
      (2, 3, 9, 'reader-milk', 'Reader milk', 'https://products.example/reader.png')
  `);
  await page.route("https://products.example/**", (route) =>
    route.fulfill({ contentType: "image/png", body: onePixelPng() }),
  );

  await signIn(page, 2);
  await page.goto("/recipes/3");
  const milk = page.locator(".recipe-ingredient", { hasText: "maito" });
  const thumbnail = milk.locator(".recipe-product-thumb");
  await expect(thumbnail).toBeVisible();
  await expect(thumbnail).toHaveAttribute("src", "https://products.example/reader.png");

  const response = await page.request.get("/api/recipes/3");
  const body = (await response.json()) as {
    recipe: { parts: Array<{ lines: Array<Record<string, unknown>> }> };
  };
  for (const part of body.recipe.parts) {
    for (const line of part.lines) expect(line).not.toHaveProperty("productImageUrl");
  }
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

test("a multipart dish is shared as one dish, parts and all", async ({
  page,
}) => {
  // Recipe 3 is the lasagne; 4 and 5 are its parts.
  await shareWith(page, 3, ["Naapuri"]);
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
  await page.getByLabel("Oma").check();
  await page.getByRole("button", { name: "Tallenna jako" }).click();
  await expect(page.locator(".refused")).toContainText("tulevalla ruokalistalla");
  await expect(page.locator(".recipe-sharing")).toContainText(
    "näkyy kaikille kirjautuneille talouksille",
  );

  // Deleting is refused one step earlier and says which step comes first, so
  // the two rules cannot drift apart.
  await page.goto("/recipes/1/delete");
  await expect(page.locator(".refused")).toContainText("on jaettu");
});

test("a cooking that already happened does not block unpublishing", async ({
  page,
}) => {
  await publish(page, 1);
  await plan(page, 2, "2020-01-06", 1);

  await signIn(page, 1);
  await page.goto("/recipes/1");
  await page.getByLabel("Oma").check();
  await page.getByRole("button", { name: "Tallenna jako" }).click();
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
    data: { date, slot: "dinner", recipeId, multiplier: 1 },
  });
  expect(response.status()).toBe(201);
}

test("a published recipe cannot be deleted until it is private again", async ({
  page,
}) => {
  await publish(page, 2);
  await signIn(page, 1);

  await page.goto("/recipes/2/delete");
  await expect(page.locator(".refused")).toContainText("Muuta se ensin");
  expect(
    (await page.request.delete("/api/recipes/2")).status(),
  ).toBe(409);

  await makePrivate(page, 2);
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

test("each household keeps its own default multiplier for the same recipe", async ({
  page,
}) => {
  await publish(page, 1);

  // Koti always cooks it at twice the recipe.
  await signIn(page, 1);
  await page.goto("/recipes/1");
  await page.locator(".multiplier-choice").getByRole("button", { name: "2×" }).click();
  await expect(
    page.locator(".multiplier-choice button.is-current"),
  ).toHaveText("2×");

  // Naapuri is two people, and Koti's habit is not theirs.
  await signIn(page, 2);
  await page.goto("/recipes/1");
  await expect(page.locator(".multiplier-choice button.is-current")).toHaveCount(0);
  await page
    .locator(".multiplier-choice")
    .getByRole("button", { name: "0,5×" })
    .click();

  await page.goto("/picker?date=2099-03-03&slot=lunch");
  await expect(
    page.locator(".pick li", { hasText: "Kaalilaatikko" }).getByLabel("Kerroin"),
  ).toHaveValue("0,5×");

  await signIn(page, 1);
  await page.goto("/picker?date=2099-03-03&slot=lunch");
  await expect(
    page.locator(".pick li", { hasText: "Kaalilaatikko" }).getByLabel("Kerroin"),
  ).toHaveValue("2×");
});

test("a household's default is cleared by an empty box, not guessed at", async ({
  page,
}) => {
  await publish(page, 1);
  await signIn(page, 1);

  await page.goto("/recipes/1");
  await page.locator(".multiplier-choice").getByRole("button", { name: "2×" }).click();
  await expect(page.locator(".multiplier-choice button.is-current")).toHaveText("2×");

  await page.locator(".multiplier-choice input").fill("");
  await page
    .locator(".multiplier-choice")
    .getByRole("button", { name: "Tallenna" })
    .click();

  await expect(page.locator(".multiplier-choice button.is-current")).toHaveCount(0);
  await page.goto("/picker?date=2099-03-04&slot=lunch");
  await expect(
    page.locator(".pick li", { hasText: "Kaalilaatikko" }).getByLabel("Kerroin"),
  ).toHaveValue("1×");
});
