import { expect, test } from "@playwright/test";
import zlib from "node:zlib";

import { openMore } from "./support/lines";
import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * A recipe's picture: the editor's upload, the read-only image on the recipe
 * screen, and the API that bulk tooling uses.
 *
 * The pictures here are built rather than committed, because what is being
 * checked is what the bytes say about themselves — the size a PNG declares in
 * its header, and the fact that HTML claiming to be a PNG is not one. A fixture
 * file would hide exactly that.
 */

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typed) >>> 0);
  return Buffer.concat([head, typed, crc]);
}

/** A real, decodable PNG of a single flat colour. */
function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;

  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3)]);
  for (let x = 0; x < width; x += 1) row.set(rgb, 1 + x * 3);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const RECIPE = 1; // Kaalilaatikko, household 1.
const IMAGE_URL = `/api/recipes/${RECIPE}/image`;

test.beforeAll(reseed);

test.describe("the editor", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([sessionCookie(1)]);
  });

  test("a picture can be added, replaced and removed", async ({ page }) => {
    await page.goto(`/recipes/${RECIPE}/edit`);
    await expect(page.locator(".recipe-image.is-empty")).toBeVisible();
    await expect(page.locator(".recipe-image img")).toHaveCount(0);

    await page.setInputFiles("#recipe-image", {
      name: "kaalilaatikko.png",
      mimeType: "image/png",
      buffer: png(900, 600, [200, 110, 60]),
    });
    await page.locator("#recipe-image-form button[type=submit]").click();

    const shown = page.locator(".recipe-image img");
    await expect(shown).toBeVisible();
    await expect(shown).toHaveJSProperty("complete", true);
    // Loaded, not a broken-image icon.
    await expect(shown).not.toHaveJSProperty("naturalWidth", 0);

    // Replacing swaps the picture rather than adding a second one.
    await page.setInputFiles("#recipe-image", {
      name: "toinen.png",
      mimeType: "image/png",
      buffer: png(400, 400, [40, 120, 220]),
    });
    await page.locator("#recipe-image-form button[type=submit]").click();
    await expect(page.locator(".recipe-image img")).toHaveCount(1);

    await page.locator(".recipe-image-editor button.danger").click();
    await expect(page.locator(".recipe-image.is-empty")).toBeVisible();
    await expect(page.locator(".recipe-image img")).toHaveCount(0);
  });

  test("a file that is not an image is refused on the editor, not in JSON", async ({
    page,
  }) => {
    await page.goto(`/recipes/${RECIPE}/edit`);
    await page.setInputFiles("#recipe-image", {
      name: "kuva.png",
      mimeType: "image/png",
      buffer: Buffer.from("<html><script>alert(1)</script></html>", "ascii"),
    });
    await page.locator("#recipe-image-form button[type=submit]").click();

    // The refusal is the editor with the reason on it — the member keeps the
    // screen they were on, and never sees a raw JSON body.
    await expect(page.locator("p.refused")).toContainText("JPEG, PNG tai WebP");
    await expect(page.getByRole("heading", { name: "Muokkaa reseptiä" })).toBeVisible();
    await expect(page.locator(".recipe-image.is-empty")).toBeVisible();
  });
});

test.describe("the recipe screen", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([sessionCookie(1)]);
  });

  test("shows the picture, and a placeholder when there is none", async ({
    page,
  }) => {
    await page.goto(`/recipes/${RECIPE}`);
    await expect(page.locator(".recipe-image.is-empty")).toBeVisible();

    // page.request shares the browser context, so it is signed in already.
    await page.request.put(IMAGE_URL, {
      headers: { "content-type": "image/png" },
      data: png(600, 400, [200, 110, 60]),
    });

    await page.goto(`/recipes/${RECIPE}`);
    await expect(page.locator(".recipe-image img")).toBeVisible();
    // Read-only: uploading lives in the editor and nowhere else.
    await expect(page.locator("input[type=file]")).toHaveCount(0);
  });

  test("no screen but the editor offers an upload", async ({ page }) => {
    for (const url of ["/recipes", `/recipes/${RECIPE}`, "/?week=2026-10-05"]) {
      await page.goto(url);
      await expect(page.locator("input[type=file]")).toHaveCount(0);
    }
  });
});

test.describe("every screen a recipe appears on", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([sessionCookie(1)]);
  });

  /**
   * The list, the picker, the week and the meal a day opens. Each is checked
   * twice — once with no picture anywhere, once with one on recipe 1 — because
   * the point of the placeholder is that the row is the same size either way.
   */
  const SCREENS = [
    { name: "the recipe list", url: "/recipes", row: ".recipes li" },
    { name: "the picker", url: "/picker?date=2026-10-05&slot=dinner", row: ".pick li" },
  ];

  for (const screen of SCREENS) {
    test(`${screen.name} shows a thumbnail, and the same row without one`, async ({
      page,
    }) => {
      await page.goto(screen.url);
      const empty = page.locator(`${screen.row} .recipe-image.is-empty`).first();
      await expect(empty).toBeVisible();
      const before = await empty.boundingBox();

      await page.request.put(IMAGE_URL, {
        headers: { "content-type": "image/png" },
        data: png(600, 400, [200, 110, 60]),
      });

      await page.goto(screen.url);
      const shown = page.locator(`${screen.row} .recipe-image img`).first();
      await expect(shown).toBeVisible();
      await expect(shown).not.toHaveJSProperty("naturalWidth", 0);

      // A row does not change size because somebody added a picture.
      const after = await page
        .locator(`${screen.row} .recipe-image`)
        .first()
        .boundingBox();
      expect(after?.height).toBe(before?.height);
      expect(after?.width).toBe(before?.width);

      await page.request.delete(IMAGE_URL);
    });
  }

  test("a planned meal shows it on the week and on the meal itself", async ({
    page,
  }) => {
    // Plan recipe 1 for a day, then look at the week and at the meal.
    const planned = await page.request.post("/api/batches", {
      data: { date: "2026-10-06", slot: "dinner", recipeId: RECIPE, portions: 4 },
    });
    expect(planned.ok()).toBe(true);

    await page.goto("/?week=2026-10-05");
    await expect(page.locator(".entry .recipe-image.is-empty").first()).toBeVisible();

    await page.request.put(IMAGE_URL, {
      headers: { "content-type": "image/png" },
      data: png(600, 400, [200, 110, 60]),
    });

    await page.goto("/?week=2026-10-05");
    const onWeek = page.locator(".entry .recipe-image img").first();
    await expect(onWeek).toBeVisible();
    await expect(onWeek).not.toHaveJSProperty("naturalWidth", 0);

    await page.locator(".entry > a").first().click();
    await expect(page.locator(".recipe-image img")).toBeVisible();
    // Still read-only: the meal screen changes portions, not pictures.
    await expect(page.locator("input[type=file]")).toHaveCount(0);
  });
});

test.describe("the bulk API", () => {
  test("attaches, replaces and removes without a browser", async ({ request }) => {
    const cookie = sessionCookie(1);
    const headers = {
      cookie: `${cookie.name}=${cookie.value}`,
      "content-type": "image/png",
    };

    const put = await request.put(IMAGE_URL, {
      headers,
      data: png(800, 600, [200, 110, 60]),
    });
    expect(put.status()).toBe(204);

    const got = await request.get(IMAGE_URL, { headers: { cookie: headers.cookie } });
    expect(got.status()).toBe(200);
    expect(got.headers()["content-type"]).toBe("image/png");
    // Untrusted bytes served from our own origin: no browser may re-guess what
    // they are.
    expect(got.headers()["x-content-type-options"]).toBe("nosniff");

    const replaced = await request.put(IMAGE_URL, {
      headers,
      data: png(320, 240, [40, 120, 220]),
    });
    expect(replaced.status()).toBe(204);

    const removed = await request.delete(IMAGE_URL, {
      headers: { cookie: headers.cookie },
    });
    expect(removed.status()).toBe(204);
    const gone = await request.get(IMAGE_URL, { headers: { cookie: headers.cookie } });
    expect(gone.status()).toBe(404);
  });

  test("bytes are taken on what they are, not on what the caller says", async ({
    request,
  }) => {
    const cookie = sessionCookie(1);
    const headers = {
      cookie: `${cookie.name}=${cookie.value}`,
      "content-type": "image/png",
    };

    const lying = await request.put(IMAGE_URL, {
      headers,
      data: Buffer.from("<html><script>alert(1)</script></html>", "ascii"),
    });
    expect(lying.status()).toBe(415);

    // A picture too big to display is refused rather than stored unchanged.
    const huge = await request.put(IMAGE_URL, {
      headers,
      data: png(2400, 1200, [200, 110, 60]),
    });
    expect(huge.status()).toBe(413);
    expect(await huge.text()).toContain("2400x1200");

    const empty = await request.put(IMAGE_URL, { headers, data: Buffer.alloc(0) });
    expect(empty.status()).toBe(400);
  });

  test("another household's recipe is a 404, not a 403", async ({ request }) => {
    const neighbour = sessionCookie(2);
    const headers = { cookie: `${neighbour.name}=${neighbour.value}` };

    const mine = sessionCookie(1);
    await request.put(IMAGE_URL, {
      headers: {
        cookie: `${mine.name}=${mine.value}`,
        "content-type": "image/png",
      },
      data: png(600, 400, [200, 110, 60]),
    });

    expect((await request.get(IMAGE_URL, { headers })).status()).toBe(404);
    expect(
      (await request.put(IMAGE_URL, {
        headers: { ...headers, "content-type": "image/png" },
        data: png(100, 100, [0, 0, 0]),
      })).status(),
    ).toBe(404);
    expect((await request.delete(IMAGE_URL, { headers })).status()).toBe(404);

    // Signed out is refused too.
    expect((await request.get(IMAGE_URL)).status()).toBe(401);
  });
});

test.describe("freshness", () => {
  /**
   * The walk the generator will take: a recipe with no picture, a generated one
   * recorded against the recipe it was made from, and the same picture once
   * somebody changed what the dish is made of.
   *
   * The fingerprint's own rules are checked in `dev/check-recipe-fingerprint.ts`,
   * where a change can be made one field at a time. This is the round trip
   * through R2, the database and the editor.
   */

  const STATUS_URL = `/api/recipes/${RECIPE}/image/status`;

  test.beforeEach(async ({ context }) => {
    await context.addCookies([sessionCookie(1)]);
    // Earlier tests in this file leave pictures behind, and every case here
    // starts from a recipe that has none.
    await context.request.delete(IMAGE_URL);
  });

  test("missing, then fresh, then stale when the ingredients change", async ({
    page,
  }) => {
    const status = async () => (await page.request.get(STATUS_URL)).json();

    const none = await status();
    expect(none.status).toBe("missing");
    expect(none.origin).toBe(null);

    // What a generator does when it comes back with what it made.
    const put = await page.request.put(
      `${IMAGE_URL}?origin=generated&model=test-model`,
      { headers: { "content-type": "image/png" }, data: png(600, 400, [200, 110, 60]) },
    );
    expect(put.status()).toBe(204);

    const generated = await status();
    expect(generated.status).toBe("fresh");
    expect(generated.origin).toBe("generated");
    expect(generated.generatedBy).toBe("test-model");
    expect(generated.imageFingerprint).toBe(generated.recipeFingerprint);
    expect(generated.generatedAt).not.toBe(null);

    // Change how much of the first ingredient the dish uses.
    await page.goto(`/recipes/${RECIPE}/edit`);
    const amount = page.locator(".line").first().locator("input[name$=quantity]").first();
    const was = await amount.inputValue();
    await amount.fill("3");
    await page.getByRole("button", { name: "Tallenna muutokset" }).click();
    await expect(page).toHaveURL(new RegExp(`/recipes/${RECIPE}$`));

    const stale = await status();
    expect(stale.status).toBe("stale");
    // The picture is untouched; only the recipe moved under it.
    expect(stale.imageFingerprint).toBe(generated.imageFingerprint);
    expect(stale.recipeFingerprint).not.toBe(generated.recipeFingerprint);

    // Putting the amount back is the dish it was, so the picture is right again.
    await page.goto(`/recipes/${RECIPE}/edit`);
    await page.locator(".line").first().locator("input[name$=quantity]").first().fill(was);
    await page.getByRole("button", { name: "Tallenna muutokset" }).click();
    await expect(page).toHaveURL(new RegExp(`/recipes/${RECIPE}$`));

    const again = await status();
    expect(again.recipeFingerprint).toBe(generated.recipeFingerprint);
    expect(again.status).toBe("fresh");

    await page.request.delete(IMAGE_URL);
    expect((await status()).status).toBe("missing");
  });

  test("reordering the lines is not a change to the dish", async ({ page }) => {
    await page.request.put(`${IMAGE_URL}?origin=generated`, {
      headers: { "content-type": "image/png" },
      data: png(600, 400, [200, 110, 60]),
    });
    expect((await (await page.request.get(STATUS_URL)).json()).status).toBe("fresh");

    await page.goto(`/recipes/${RECIPE}/edit`);
    await openMore(page.locator(".line").nth(0));
    await openMore(page.locator(".line").nth(1));
    const positions = page.locator(".line input[name$=position]");
    await positions.nth(0).fill("2");
    await positions.nth(1).fill("1");
    await page.getByRole("button", { name: "Tallenna muutokset" }).click();
    await expect(page).toHaveURL(new RegExp(`/recipes/${RECIPE}$`));

    // Same food, written in a different order.
    expect((await (await page.request.get(STATUS_URL)).json()).status).toBe("fresh");
    await page.request.delete(IMAGE_URL);
  });

  test("a picture somebody uploaded is never called stale", async ({ page }) => {
    // No origin stated is an upload, which is what the editor and every #89
    // caller do.
    await page.request.put(IMAGE_URL, {
      headers: { "content-type": "image/png" },
      data: png(600, 400, [200, 110, 60]),
    });

    const manual = await (await page.request.get(STATUS_URL)).json();
    expect(manual.status).toBe("fresh");
    expect(manual.origin).toBe("manual");
    expect(manual.imageFingerprint).toBe(null);

    await page.goto(`/recipes/${RECIPE}/edit`);
    await page.locator("#title").fill("Aivan toinen ruoka");
    await page.locator(".line").first().locator("input[name$=quantity]").first().fill("9");
    await page.getByRole("button", { name: "Tallenna muutokset" }).click();
    await expect(page).toHaveURL(new RegExp(`/recipes/${RECIPE}$`));

    // Manually managed until somebody replaces or removes it, so nothing here
    // queues it for a paid regeneration.
    expect((await (await page.request.get(STATUS_URL)).json()).status).toBe("fresh");
    await page.request.delete(IMAGE_URL);
  });

  test("the status of another household's recipe is a 404", async ({ request }) => {
    const neighbour = sessionCookie(2);
    const refused = await request.get(STATUS_URL, {
      headers: { cookie: `${neighbour.name}=${neighbour.value}` },
    });
    expect(refused.status()).toBe(404);
    expect((await request.get(STATUS_URL)).status()).toBe(401);
  });
});
