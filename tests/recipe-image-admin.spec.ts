import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

import { emptySheet, onePixelPng } from "./support/png";
import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * The admin screen that decides which recipes get a generated picture.
 *
 * **No test here calls OpenAI, and none may.** Every paid submit below has the
 * committed contact sheet pushed into the form first, which a development
 * server accepts in place of buying one — the same bargain the JSON route
 * strikes in `recipe-image-batch.spec.ts`. A submit without it would spend real
 * money on every run of this suite, so that is the mistake to look for.
 *
 * The screen's own promise is that nothing before that submit costs anything,
 * and the tests that matter most here are the ones holding it: opening the list
 * and reading the confirmation leave every recipe exactly as it was.
 */

const SHEET = readFileSync(new URL("./fixtures/contact-sheet.png", import.meta.url))
  .toString("base64");

const LIST = "/admin/recipe-images";

/** Members 1 and 3 are both in household 1; only 3 is an admin. */
function cookie(memberId: number): string {
  const { name, value } = sessionCookie(memberId);
  return `${name}=${value}`;
}

/** One recipe's picture state, as #95's API reports it. */
async function status(
  page: Page,
  recipeId: number,
): Promise<Record<string, unknown>> {
  const response = await page.request.get(`/api/recipes/${recipeId}/image/status`, {
    headers: { Cookie: cookie(3) },
  });
  expect(response.status()).toBe(200);
  return response.json();
}

/**
 * Press the paid button with the fixture sheet supplied, so the split, the
 * commit and the freshness bookkeeping are all real and only the model call is
 * skipped. The field is honoured on a development origin and nowhere else.
 */
async function generateWithFixtureSheet(page: Page): Promise<void> {
  await page.locator("#generate").evaluate((form, sheet) => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "sheetBase64";
    input.value = sheet as string;
    form.appendChild(input);
  }, SHEET);

  await page.getByRole("button", { name: /Luo kuvat nyt/ }).click();
}

test.beforeEach(reseed);

test.describe("the gate", () => {
  test("an ordinary member is told the screen is not there", async ({
    context,
    page,
  }) => {
    await context.addCookies([sessionCookie(1)]);
    const response = await page.goto(LIST);

    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Ei löytynyt" })).toBeVisible();
  });

  test("an ordinary member cannot post the paid action either", async ({
    request,
  }) => {
    const response = await request.post(`${LIST}/generate`, {
      headers: {
        Cookie: cookie(1),
        "content-type": "application/x-www-form-urlencoded",
      },
      data: `id=1&sheetBase64=${encodeURIComponent(SHEET)}`,
      maxRedirects: 0,
    });

    expect(response.status()).toBe(404);

    // And nothing happened, whatever the refusal said.
    const state = await request.get("/api/recipes/1/image/status", {
      headers: { Cookie: cookie(3) },
    });
    expect((await state.json()).status).toBe("missing");
  });

  test("a signed-out browser is sent to sign in", async ({ request }) => {
    const response = await request.get(LIST, { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    expect(response.headers()["location"]).toBe("/signin");
  });
});

test.describe("the list", () => {
  test("every dish without a picture is listed and preselected", async ({
    context,
    page,
  }) => {
    await context.addCookies([sessionCookie(3)]);
    await page.goto(LIST);

    await expect(page.getByRole("heading", { name: "Reseptikuvat" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Kuvaa vailla \(3\)/ })).toBeVisible();

    // The three seeded dishes. The lasagne's two parts are not listed: a part
    // is not something anybody plans, and its ingredients are already in the
    // dish's fingerprint.
    const boxes = page.locator("form[action$='/confirm'] input[name='id']");
    await expect(boxes).toHaveCount(3);
    for (let at = 0; at < 3; at += 1) {
      await expect(boxes.nth(at)).toBeChecked();
    }
    await expect(page.getByText("Ei kuvaa").first()).toBeVisible();

    // The cap is stated where the money is spent, not only in the validation.
    await expect(page.getByText(/enintään 16 reseptiä/)).toBeVisible();
  });

  test("opening the list and the confirmation buys nothing", async ({
    context,
    page,
  }) => {
    await context.addCookies([sessionCookie(3)]);
    await page.goto(LIST);
    await page.getByRole("button", { name: "Katso erä ennen luontia" }).click();

    await expect(page.getByRole("heading", { name: "Vahvista kuvien luonti" })).toBeVisible();

    // Two screens deep and every recipe is still exactly as it was. A paid
    // request would have had to change one of these.
    for (const id of [1, 2, 3]) {
      expect((await status(page, id)).status).toBe("missing");
    }
  });

  test("the confirmation names the exact recipes, in cell order", async ({
    context,
    page,
  }) => {
    await context.addCookies([sessionCookie(3)]);
    await page.goto(`${LIST}/confirm?id=3&id=1`);

    const named = page.locator(".image-manifest li");
    await expect(named).toHaveCount(2);
    await expect(named.nth(0)).toContainText("Lasagne");
    await expect(named.nth(1)).toContainText("Kaalilaatikko");

    // The order that is shown is the order that is posted, because it is the
    // order the sheet is cut in.
    const hidden = page.locator("#generate input[name='id']");
    await expect(hidden.nth(0)).toHaveValue("3");
    await expect(hidden.nth(1)).toHaveValue("1");
  });
});

test.describe("a batch", () => {
  test("three recipes are generated and immediately read as fresh", async ({
    context,
    page,
  }) => {
    await context.addCookies([sessionCookie(3)]);
    await page.goto(LIST);
    await page.getByRole("button", { name: "Katso erä ennen luontia" }).click();
    await generateWithFixtureSheet(page);

    await expect(page.getByRole("heading", { name: "Kuvat luotu" })).toBeVisible();
    await expect(page.getByText("3 / 3 reseptiä sai kuvan.")).toBeVisible();

    // The report shows the pictures that were just written, and they load.
    const shown = page.locator(".image-list .recipe-image img");
    await expect(shown).toHaveCount(3);
    await expect(shown.first()).not.toHaveJSProperty("naturalWidth", 0);

    for (const id of [1, 2, 3]) {
      const state = await status(page, id);
      expect(state.status).toBe("fresh");
      expect(state.origin).toBe("generated");
    }
  });

  test("a generated picture leaves the list and can be redone deliberately", async ({
    context,
    page,
  }) => {
    await context.addCookies([sessionCookie(3)]);
    await page.goto(`${LIST}/confirm?id=1`);
    await generateWithFixtureSheet(page);

    await page.goto(LIST);
    await expect(page.getByRole("heading", { name: /Kuvaa vailla \(2\)/ })).toBeVisible();

    // It is not gone, it is behind its own disclosure with its own button, and
    // nothing in there is preselected.
    const current = page.locator("details.image-current");
    await expect(current).toContainText("Ajan tasalla olevat (1)");
    await current.getByText("Ajan tasalla olevat (1)").click();
    const box = current.locator("input[name='id']");
    await expect(box).toHaveCount(1);
    await expect(box).not.toBeChecked();
    await expect(
      current.getByRole("button", { name: /Luo valituille uudelleen/ }),
    ).toBeVisible();
  });

  test("editing a recipe puts it back on the list as stale", async ({
    context,
    page,
  }) => {
    await context.addCookies([sessionCookie(3)]);
    await page.goto(`${LIST}/confirm?id=1`);
    await generateWithFixtureSheet(page);

    await page.goto("/recipes/1/edit");
    await page.locator("#title").fill("Kaalilaatikko ja perunat");
    await page.getByRole("button", { name: "Tallenna muutokset" }).click();
    await expect(page).toHaveURL(/\/recipes\/1(\?|$)/);

    await page.goto(LIST);
    await expect(page.getByRole("heading", { name: /Kuvaa vailla \(3\)/ })).toBeVisible();
    await expect(
      page.getByText("Vanhentunut — resepti on muuttunut"),
    ).toBeVisible();
  });

  test("a picture somebody uploaded is listed but never offered", async ({
    context,
    page,
  }) => {
    // The smallest real picture a person could upload, through the same API the
    // editor's island posts to.
    const uploaded = await page.request.put("/api/recipes/1/image", {
      headers: { Cookie: cookie(3), "content-type": "image/png" },
      data: onePixelPng(),
    });
    expect(uploaded.status()).toBe(204);

    await context.addCookies([sessionCookie(3)]);
    await page.goto(LIST);

    await expect(page.getByRole("heading", { name: /Kuvaa vailla \(2\)/ })).toBeVisible();

    const current = page.locator("details.image-current");
    await current.getByText(/Ajan tasalla olevat/).click();
    await expect(current.getByRole("heading", { name: "Itse lisätyt kuvat" })).toBeVisible();
    await expect(current).toContainText("Kaalilaatikko");
    // Manually managed means this screen will not spend money on it.
    await expect(current.locator("input[name='id']")).toHaveCount(0);
  });
});

test.describe("what it refuses", () => {
  test("more than a sheet holds is refused, and says to split the batch", async ({
    request,
  }) => {
    const ids = Array.from({ length: 17 }, (_, at) => `id=${at + 1}`).join("&");
    const response = await request.post(`${LIST}/generate`, {
      headers: {
        Cookie: cookie(3),
        "content-type": "application/x-www-form-urlencoded",
      },
      data: ids,
    });

    expect(response.status()).toBe(400);
    expect(await response.text()).toContain("Tee loput seuraavana eränä.");
  });

  test("an empty selection is refused before anything is bought", async ({
    context,
    page,
  }) => {
    await context.addCookies([sessionCookie(3)]);
    const response = await page.goto(`${LIST}/confirm`);

    expect(response?.status()).toBe(400);
    await expect(page.getByText("Valitse ainakin yksi resepti.")).toBeVisible();
  });

  test("a sheet that cannot be cut changes nothing and can be retried", async ({
    context,
    page,
  }) => {
    await context.addCookies([sessionCookie(3)]);
    await page.goto(`${LIST}/confirm?id=1`);

    // A transparent sheet with nothing drawn on it: bought, and worthless.
    await page.locator("#generate").evaluate((form, sheet) => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "sheetBase64";
      input.value = sheet as string;
      form.appendChild(input);
    }, emptySheet());
    await page.getByRole("button", { name: /Luo kuvat nyt/ }).click();

    await expect(page.getByRole("heading", { name: "Kuvia ei luotu" })).toBeVisible();
    await expect(page.getByText(/Arkkia ei voitu leikata/)).toBeVisible();
    expect((await status(page, 1)).status).toBe("missing");

    // Retrying is just another request, and the recipe is still on the list.
    await page.goto(`${LIST}/confirm?id=1`);
    await generateWithFixtureSheet(page);
    await expect(page.getByRole("heading", { name: "Kuvat luotu" })).toBeVisible();
    expect((await status(page, 1)).status).toBe("fresh");
  });
});
