import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

import { emptySheet, onePixelPng, opaqueSheet } from "./support/png";
import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * The admin screen that decides which recipes get a generated picture, and the
 * browser-side split that gives them one.
 *
 * **Nothing in this app calls an image API any more, and these tests hold that
 * down.** #96 bought a 4x4 contact sheet from OpenAI inside the Worker; #111
 * removed it, because on the Workers Free plan it could not finish — 10 ms of
 * CPU a request against over a second of pixel work. Every test that cuts a
 * sheet here fails the run if any request reaches `api.openai.com`, and the
 * flow they drive is the real one: the committed fixture sheet goes onto the
 * file input, the admin's browser cuts it with the bundled splitter, and each
 * crop is stored through `PUT /api/recipes/:id/image`.
 *
 * The screen's own promise is that nothing before pressing that button changes
 * anything, and the tests that matter most are the ones holding it: opening the
 * list and reading the prompt leave every recipe exactly as it was.
 */

const SHEET_BYTES = readFileSync(
  new URL("./fixtures/contact-sheet.png", import.meta.url),
);

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
 * Fail the test if anything reaches OpenAI.
 *
 * The removed route was a Worker-side `fetch`, which a browser cannot intercept
 * — so this is not the whole proof on its own. What makes it complete is that
 * the split now happens in this page: every request that could reach a provider
 * is a request this context makes, and this sees all of them. The structural
 * half of the proof is in `dev/check-image-generation.ts`, which asserts the
 * module has no `fetch` in it at all.
 */
async function refuseOpenAI(page: Page): Promise<string[]> {
  const reached: string[] = [];
  await page.route("**://api.openai.com/**", async (route) => {
    reached.push(route.request().url());
    await route.abort();
  });
  return reached;
}

/** Put the committed sheet on the file input and cut it. */
async function splitFixtureSheet(page: Page): Promise<void> {
  await page.locator("#sheet").setInputFiles({
    name: "contact-sheet.png",
    mimeType: "image/png",
    buffer: SHEET_BYTES,
  });
  await page.getByRole("button", { name: /Leikkaa arkki/ }).click();
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

  test("an ordinary member gets neither the prompt nor the splitter", async ({
    request,
  }) => {
    for (const path of [`${LIST}/confirm?id=1`, `${LIST}/split.js`]) {
      const response = await request.get(path, {
        headers: { Cookie: cookie(1) },
        maxRedirects: 0,
      });
      expect(response.status(), path).toBe(404);
    }

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

    // The batch size is stated on the screen, not only in the validation.
    await expect(page.getByText(/16 reseptiä 4×4 -ruudukkona/)).toBeVisible();
  });

  test("opening the list and the prompt changes nothing", async ({
    context,
    page,
  }) => {
    await context.addCookies([sessionCookie(3)]);
    await page.goto(LIST);
    await page.getByRole("button", { name: "Jatka kehotteeseen" }).click();

    await expect(page.getByRole("heading", { name: "Luo reseptikuvat" })).toBeVisible();

    // Two screens deep and every recipe is still exactly as it was.
    for (const id of [1, 2, 3]) {
      expect((await status(page, id)).status).toBe("missing");
    }
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
    // Manually managed means this screen will not overwrite it in bulk.
    await expect(current.locator("input[name='id']")).toHaveCount(0);
  });
});

test.describe("the prompt", () => {
  test("it is the shared prompt, and it names this batch's cells in order", async ({
    context,
    page,
  }) => {
    await context.addCookies([sessionCookie(3)]);
    await page.goto(`${LIST}/confirm?id=1&id=3`);

    const prompt = await page.locator("#sheet-prompt").inputValue();

    // The three load-bearing parts. The grid is what maps a cell back to a
    // recipe, the gutters are what the splitter recovers with, and rendered
    // text would be something to misread a positional mapping against.
    expect(prompt).toContain("exactly 16 food illustrations");
    expect(prompt).toContain("4-column by 4-row grid");
    expect(prompt).toContain("no text, no numbers, no labels");
    expect(prompt).toContain("generous fully transparent gutters");
    expect(prompt).toContain("Cells 3 to 16 are unused");

    // And the cells are this batch's recipes, in the chosen order, described
    // from their own ingredients.
    expect(prompt).toMatch(/Cell 1: Kaalilaatikko — .*kaali/);
    expect(prompt).toMatch(/Cell 2: Lasagne —/);
    expect(prompt).not.toContain("Cell 3:");
  });

  test("reordering the batch reorders the prompt and the manifest together", async ({
    context,
    page,
  }) => {
    await context.addCookies([sessionCookie(3)]);
    await page.goto(`${LIST}/confirm?id=3&id=1`);

    const prompt = await page.locator("#sheet-prompt").inputValue();
    expect(prompt).toMatch(/Cell 1: Lasagne —/);
    expect(prompt).toMatch(/Cell 2: Kaalilaatikko —/);

    // The manifest says the same thing, because position is the whole mapping
    // and this list is what the browser reads it from.
    const named = page.locator("#split-manifest li");
    await expect(named).toHaveCount(2);
    await expect(named.nth(0)).toContainText("Lasagne");
    await expect(named.nth(1)).toContainText("Kaalilaatikko");
    await expect(named.nth(0)).toHaveAttribute("data-recipe-id", "3");
    await expect(named.nth(1)).toHaveAttribute("data-recipe-id", "1");
  });

  test("each row carries the fingerprint the crop will be stored against", async ({
    context,
    page,
  }) => {
    await context.addCookies([sessionCookie(3)]);
    await page.goto(`${LIST}/confirm?id=1`);

    const row = page.locator("#split-manifest li").first();
    const stated = await row.getAttribute("data-fingerprint");

    // The same value #95's API reports for the recipe as it stands. This is
    // what stops a crop being recorded against a recipe nobody read.
    expect((await status(page, 1)).recipeFingerprint).toBe(stated);
    expect(stated).toMatch(/^[0-9a-f]{16,}$/);
  });

  test("the Copy button copies the prompt", async ({ context, page }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await context.addCookies([sessionCookie(3)]);
    await page.goto(`${LIST}/confirm?id=1`);

    await page.getByRole("button", { name: "Kopioi kehote" }).click();
    await expect(page.getByRole("button", { name: "Kopioitu" })).toBeVisible();

    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain("4-column by 4-row grid");
    expect(copied).toContain("Cell 1: Kaalilaatikko");
  });
});

test.describe("cutting a sheet", () => {
  test("three recipes get their pictures, and read as fresh", async ({
    context,
    page,
  }) => {
    await context.addCookies([sessionCookie(3)]);
    const reached = await refuseOpenAI(page);

    await page.goto(LIST);
    await page.getByRole("button", { name: "Jatka kehotteeseen" }).click();
    await splitFixtureSheet(page);

    await expect(page.locator("#split-note")).toContainText(
      "3 / 3 reseptiä sai kuvan.",
      { timeout: 30_000 },
    );

    for (const id of [1, 2, 3]) {
      const state = await status(page, id);
      expect(state.status).toBe("fresh");
      expect(state.origin).toBe("generated");
      // What actually drew it: a person supplied the sheet, under our style.
      expect(state.generatedBy).toBe("supplied:manual/s1");
      expect(state.generatedBy).not.toContain("openai");
    }

    // The whole point of #111: not one paid request was made.
    expect(reached).toEqual([]);
  });

  test("the stored crops are real pictures at the output size", async ({
    context,
    page,
  }) => {
    await context.addCookies([sessionCookie(3)]);
    await page.goto(`${LIST}/confirm?id=1`);
    await splitFixtureSheet(page);
    await expect(page.locator("#split-note")).toContainText("1 / 1", {
      timeout: 30_000,
    });

    // Fetched as an image and measured, rather than trusted because a 204 came
    // back: the splitter runs in a browser now, and a crop that decoded to
    // nothing would still have stored.
    const size = await page.evaluate(async () => {
      const image = new Image();
      image.src = "/api/recipes/1/image";
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight };
    });
    expect(size).toEqual({ width: 512, height: 512 });
  });

  test("a generated picture leaves the list and can be redone deliberately", async ({
    context,
    page,
  }) => {
    await context.addCookies([sessionCookie(3)]);
    await page.goto(`${LIST}/confirm?id=1`);
    await splitFixtureSheet(page);
    await expect(page.locator("#split-note")).toContainText("1 / 1", {
      timeout: 30_000,
    });

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
    await splitFixtureSheet(page);
    await expect(page.locator("#split-note")).toContainText("1 / 1", {
      timeout: 30_000,
    });

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
});

test.describe("what it refuses", () => {
  test("more than a sheet holds is refused, and says to split the batch", async ({
    request,
  }) => {
    const ids = Array.from({ length: 17 }, (_, at) => `id=${at + 1}`).join("&");
    const response = await request.get(`${LIST}/confirm?${ids}`, {
      headers: { Cookie: cookie(3) },
    });

    expect(response.status()).toBe(400);
    expect(await response.text()).toContain("Tee loput seuraavana eränä.");
  });

  test("an empty selection is refused before anything is drawn", async ({
    context,
    page,
  }) => {
    await context.addCookies([sessionCookie(3)]);
    const response = await page.goto(`${LIST}/confirm`);

    expect(response?.status()).toBe(400);
    await expect(page.getByText("Valitse ainakin yksi resepti.")).toBeVisible();
  });

  test("a sheet that cannot be cut stores nothing and can be redone free", async ({
    context,
    page,
  }) => {
    await context.addCookies([sessionCookie(3)]);
    await page.goto(`${LIST}/confirm?id=1`);

    // A transparent sheet with nothing drawn on it.
    await page.locator("#sheet").setInputFiles({
      name: "sheet.png",
      mimeType: "image/png",
      buffer: Buffer.from(emptySheet(), "base64"),
    });
    await page.getByRole("button", { name: /Leikkaa arkki/ }).click();

    await expect(page.locator("#split-note")).toContainText(
      /Arkkia ei voitu leikata/,
      { timeout: 30_000 },
    );
    await expect(page.locator("#split-note")).toContainText(
      "uusi yritys ei maksa mitään",
    );
    expect((await status(page, 1)).status).toBe("missing");

    // Trying again is just another file, and the recipe is still on the list.
    await splitFixtureSheet(page);
    await expect(page.locator("#split-note")).toContainText("1 / 1", {
      timeout: 30_000,
    });
    expect((await status(page, 1)).status).toBe("fresh");
  });

  test("a sheet with no transparency is refused, and says why", async ({
    context,
    page,
  }) => {
    await context.addCookies([sessionCookie(3)]);
    await page.goto(`${LIST}/confirm?id=1&id=2`);

    // What a great many external image tools produce: the same drawing, exported
    // onto an opaque background. There is deliberately no white-background
    // fallback, because guessing which white pixels are plate would put half of
    // somebody else's dinner on a recipe.
    await page.locator("#sheet").setInputFiles({
      name: "flattened.png",
      mimeType: "image/png",
      buffer: Buffer.from(opaqueSheet(), "base64"),
    });
    await page.getByRole("button", { name: /Leikkaa arkki/ }).click();

    const note = page.locator("#split-note");
    await expect(note).toContainText(/Arkkia ei voitu leikata/, { timeout: 30_000 });
    // Transparency is named as the reason, rather than sixteen cells each
    // complaining that they are joined to their neighbour.
    await expect(note).toContainText(/läpinäkyv/);

    for (const id of [1, 2]) {
      expect((await status(page, id)).status).toBe("missing");
    }
  });

  test("a file that is not a PNG is refused and nothing is touched", async ({
    context,
    page,
  }) => {
    await context.addCookies([sessionCookie(3)]);
    await page.goto(`${LIST}/confirm?id=1`);

    await page.locator("#sheet").setInputFiles({
      name: "sheet.png",
      mimeType: "image/png",
      buffer: Buffer.from("<!doctype html><title>not a sheet</title>"),
    });
    await page.getByRole("button", { name: /Leikkaa arkki/ }).click();

    await expect(page.locator("#split-note")).toContainText(
      /Arkkia ei voitu lukea/,
      { timeout: 30_000 },
    );
    expect((await status(page, 1)).status).toBe("missing");
  });

  test("no file chosen says so rather than doing nothing", async ({
    context,
    page,
  }) => {
    await context.addCookies([sessionCookie(3)]);
    await page.goto(`${LIST}/confirm?id=1`);

    await page.getByRole("button", { name: /Leikkaa arkki/ }).click();
    await expect(page.locator("#split-note")).toContainText(/Valitse arkki/);
    expect((await status(page, 1)).status).toBe("missing");
  });
});
