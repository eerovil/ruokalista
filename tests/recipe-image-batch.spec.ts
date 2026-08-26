import { expect, test, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import zlib from "node:zlib";

import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * Generating recipe pictures from one contact sheet.
 *
 * **No test here calls OpenAI, and none may.** Every request below supplies the
 * sheet itself, which a development server accepts in place of buying one — the
 * same bargain `Avaa esimerkkiluonnos` strikes for intake. A request without
 * `sheetBase64` would spend real money on every run of this suite, so if you add
 * one, that is the mistake to look for.
 *
 * The sheet in `tests/fixtures/contact-sheet.png` is a real one, bought once
 * while this was built: eight dishes, transparent background, drawn by
 * gpt-image-2 from the prompt in `src/image-generation.ts`. Using it rather than
 * a drawing of coloured circles is the point — it is a real model's real
 * placement, including how loosely it obeyed the grid, and the splitter is held
 * against that for nothing on every run from here on.
 */

const SHEET = readFileSync(new URL("./fixtures/contact-sheet.png", import.meta.url))
  .toString("base64");

const GENERATE = "/api/admin/recipe-images/generate";

/** Members 1 and 3 are both in household 1; only 3 is an admin. */
function cookie(memberId: number): string {
  const { name, value } = sessionCookie(memberId);
  return `${name}=${value}`;
}

function generate(
  request: APIRequestContext,
  body: unknown,
  memberId = 3,
): ReturnType<APIRequestContext["post"]> {
  return request.post(GENERATE, {
    headers: { Cookie: cookie(memberId), "content-type": "application/json" },
    data: body,
  });
}

/** One recipe's picture state, as the API reports it. */
async function status(
  request: APIRequestContext,
  recipeId: number,
): Promise<Record<string, unknown>> {
  const response = await request.get(`/api/recipes/${recipeId}/image/status`, {
    headers: { Cookie: cookie(3) },
  });
  expect(response.status()).toBe(200);
  return response.json();
}

/** The smallest real picture a person could upload. */
function onePixelPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.from([0, 20, 90, 40, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A transparent PNG with nothing drawn on it — a sheet the model wasted. */
function emptySheet(edge = 512): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(edge, 0);
  ihdr.writeUInt32BE(edge, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(edge * 4)]);
  const pixels = Buffer.concat(Array.from({ length: edge }, () => row));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typed) >>> 0);
  return Buffer.concat([head, typed, crc]);
}

test.beforeEach(reseed);

test.describe("the gate", () => {
  test("an ordinary member is told the route is not there", async ({ request }) => {
    const response = await generate(request, { recipeIds: [1], sheetBase64: SHEET }, 1);

    expect(response.status()).toBe(404);
    expect(await response.json()).toHaveProperty("error");

    // And nothing happened: no picture, whatever the refusal said.
    const status = await request.get("/api/recipes/1/image/status", {
      headers: { Cookie: cookie(1) },
    });
    expect((await status.json()).status).toBe("missing");
  });

  test("a signed-out caller gets nothing", async ({ request }) => {
    const response = await request.post(GENERATE, { data: { recipeIds: [1] } });
    expect(response.status()).toBe(401);
  });

  test("a member of another household is refused, admin or not", async ({ request }) => {
    // Member 2 is the neighbour. Every query below the gate takes the caller's
    // own household_id, so there is no id they could name that would work.
    const response = await generate(request, { recipeIds: [1], sheetBase64: SHEET }, 2);
    expect(response.status()).toBe(404);
  });
});

test.describe("the manifest", () => {
  const refusals: [string, unknown][] = [
    ["an empty batch", { recipeIds: [] }],
    ["more recipes than a sheet holds", { recipeIds: Array.from({ length: 17 }, (_, at) => at + 1) }],
    ["the same recipe twice", { recipeIds: [1, 1] }],
    ["something that is not an id", { recipeIds: ["1"] }],
    ["a negative id", { recipeIds: [-3] }],
    ["no array at all", { recipeIds: 1 }],
  ];

  for (const [what, body] of refusals) {
    test(`${what} is refused before anything is bought`, async ({ request }) => {
      const response = await generate(request, { ...(body as object), sheetBase64: SHEET });
      expect(response.status()).toBe(400);
      expect(await response.json()).toHaveProperty("error");
    });
  }

  test("a recipe that does not exist is refused before anything is bought", async ({
    request,
  }) => {
    const response = await generate(request, { recipeIds: [1, 9999], sheetBase64: SHEET });
    expect(response.status()).toBe(404);

    // The recipe that did exist was not given a picture on the way past.
    const status = await request.get("/api/recipes/1/image/status", {
      headers: { Cookie: cookie(3) },
    });
    expect((await status.json()).status).toBe("missing");
  });
});

test.describe("a real sheet", () => {
  test("three recipes get the first three cells, in order", async ({ request }) => {
    const response = await generate(request, {
      recipeIds: [1, 2, 3],
      sheetBase64: SHEET,
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ stored: 3, rejected: false, cropEdge: 512 });
    expect(body.sheet).toEqual({ width: 1024, height: 1024 });

    // Manifest position is the whole mapping: cell 1 to recipe 1, and so on.
    expect(body.cells).toMatchObject([
      { cell: 0, recipeId: 1, status: "stored" },
      { cell: 1, recipeId: 2, status: "stored" },
      { cell: 2, recipeId: 3, status: "stored" },
    ]);
  });

  test("a stored crop is a 512-square PNG that actually serves", async ({ request }) => {
    await generate(request, { recipeIds: [1], sheetBase64: SHEET });

    const image = await request.get("/api/recipes/1/image", {
      headers: { Cookie: cookie(3) },
    });
    expect(image.status()).toBe(200);
    expect(image.headers()["content-type"]).toBe("image/png");
    expect(image.headers()["x-content-type-options"]).toBe("nosniff");

    const bytes = await image.body();
    // Straight out of the PNG's own header, so this is the stored picture's real
    // size rather than what anything claimed about it.
    expect(bytes.readUInt32BE(16)).toBe(512);
    expect(bytes.readUInt32BE(20)).toBe(512);
  });

  test("a generated picture is fresh, and says what made it", async ({ request }) => {
    await generate(request, { recipeIds: [1], sheetBase64: SHEET });

    const status = await request.get("/api/recipes/1/image/status", {
      headers: { Cookie: cookie(3) },
    });
    const body = await status.json();

    expect(body.status).toBe("fresh");
    expect(body.origin).toBe("generated");
    expect(body.generatedAt).not.toBeNull();
    expect(body.generatedBy).toMatch(/\/s1$/);
    // Fresh means the picture states the recipe it was made from, and that
    // fingerprint is the recipe as it stands.
    expect(body.imageFingerprint).toBe(body.recipeFingerprint);
  });

  test("editing the recipe afterwards makes its picture stale", async ({ page, context, request }) => {
    await generate(request, { recipeIds: [1], sheetBase64: SHEET });

    await context.addCookies([sessionCookie(3)]);
    await page.goto("/recipes/1/edit");
    await page.locator("#title").fill("Kaalilaatikko ja perunat");
    await page.getByRole("button", { name: "Tallenna muutokset" }).click();
    await expect(page).toHaveURL(/\/recipes\/1(\?|$)/);

    const status = await request.get("/api/recipes/1/image/status", {
      headers: { Cookie: cookie(3) },
    });
    expect((await status.json()).status).toBe("stale");
  });

  test("generating again replaces the picture rather than adding one", async ({
    context,
    page,
    request,
  }) => {
    await generate(request, { recipeIds: [1], sheetBase64: SHEET });
    const first = await (await request.get("/api/recipes/1/image/status", {
      headers: { Cookie: cookie(3) },
    })).json();

    const again = await generate(request, { recipeIds: [1], sheetBase64: SHEET });
    expect(again.status()).toBe(200);

    const second = await (await request.get("/api/recipes/1/image/status", {
      headers: { Cookie: cookie(3) },
    })).json();

    // A second generation, not a second picture: the row records the newer one.
    expect(second.generatedAt).not.toBe(first.generatedAt);
    expect(second.status).toBe("fresh");

    // And the recipe still shows exactly one, still loading.
    await context.addCookies([sessionCookie(3)]);
    await page.goto("/recipes/1");
    await expect(page.locator(".recipe-image img")).toHaveCount(1);
    await expect(page.locator(".recipe-image img")).not.toHaveJSProperty("naturalWidth", 0);
  });
});

test.describe("alongside the manual path", () => {
  /**
   * The write is now conditional on the picture the caller read — see
   * `storeRecipeImage`. That guards the batch generator's three-minute window
   * against a manual upload landing in it, and the race itself is held down
   * deterministically in `dev/check-recipe-image-commit.ts`, because a browser
   * cannot hold that window open and `retries: 0` means a timing-dependent test
   * is not something this suite may contain.
   *
   * What is worth checking through the real stack is the opposite risk: that the
   * condition is not so strict that it refuses writes it should allow. Handing
   * the two paths the same recipe in turn is what would break if it were.
   */
  test("generated and uploaded pictures still take turns", async ({ request }) => {
    await generate(request, { recipeIds: [1], sheetBase64: SHEET });
    expect((await status(request, 1)).origin).toBe("generated");

    // A person uploads their own photograph over the generated one.
    const uploaded = await request.put("/api/recipes/1/image", {
      headers: { Cookie: cookie(3), "content-type": "image/png" },
      data: onePixelPng(),
    });
    expect(uploaded.status()).toBe(204);

    const manual = await status(request, 1);
    expect(manual.origin).toBe("manual");
    // A picture a person chose is never compared against the recipe.
    expect(manual.status).toBe("fresh");
    expect(manual.imageFingerprint).toBeNull();

    // And an admin who explicitly asks for this recipe again gets a generated
    // one back. Naming the id is the instruction; nothing here is refused.
    const again = await generate(request, { recipeIds: [1], sheetBase64: SHEET });
    expect(again.status()).toBe(200);
    expect((await again.json()).stored).toBe(1);
    expect((await status(request, 1)).origin).toBe("generated");
  });

  test("removing a picture leaves the recipe with none", async ({ request }) => {
    await generate(request, { recipeIds: [1], sheetBase64: SHEET });

    const removed = await request.delete("/api/recipes/1/image", {
      headers: { Cookie: cookie(3) },
    });
    expect(removed.status()).toBe(204);

    const after = await status(request, 1);
    expect(after.status).toBe("missing");
    expect(after.origin).toBeNull();
  });
});

test.describe("a sheet that cannot be cut", () => {
  test("an empty sheet is refused whole, and says so cell by cell", async ({ request }) => {
    const response = await generate(request, {
      recipeIds: [1, 2],
      sheetBase64: emptySheet(),
    });

    expect(response.status()).toBe(422);
    const body = await response.json();
    expect(body).toMatchObject({ stored: 0, rejected: true });
    expect(body.cells).toHaveLength(2);
    for (const cell of body.cells) {
      expect(cell.status).toBe("rejected");
      expect(cell.reason).toMatch(/no artwork/);
    }
  });

  test("a rejected sheet leaves the picture that was already there alone", async ({
    request,
  }) => {
    await generate(request, { recipeIds: [1], sheetBase64: SHEET });
    const before = await request.get("/api/recipes/1/image/status", {
      headers: { Cookie: cookie(3) },
    });
    const was = await before.json();

    const rejected = await generate(request, {
      recipeIds: [1],
      sheetBase64: emptySheet(),
    });
    expect(rejected.status()).toBe(422);

    const after = await request.get("/api/recipes/1/image/status", {
      headers: { Cookie: cookie(3) },
    });
    // Same picture, same verdict, same timestamp: nothing was touched.
    expect(await after.json()).toEqual(was);

    // And it is still served, rather than being a row pointing at nothing.
    const image = await request.get("/api/recipes/1/image", {
      headers: { Cookie: cookie(3) },
    });
    expect(image.status()).toBe(200);
  });

  test("a retry after a rejection is just another request", async ({ request }) => {
    expect((await generate(request, { recipeIds: [1], sheetBase64: emptySheet() })).status())
      .toBe(422);

    const retry = await generate(request, { recipeIds: [1], sheetBase64: SHEET });
    expect(retry.status()).toBe(200);
    expect((await retry.json()).stored).toBe(1);
  });

  test("bytes that are not an image are refused, not stored", async ({ request }) => {
    const response = await generate(request, {
      recipeIds: [1],
      sheetBase64: Buffer.from("<html>not a sheet</html>").toString("base64"),
    });

    expect(response.status()).toBe(502);
    expect(await response.json()).toHaveProperty("error");

    const status = await request.get("/api/recipes/1/image/status", {
      headers: { Cookie: cookie(3) },
    });
    expect((await status.json()).status).toBe("missing");
  });

  test("a body that is not JSON is refused", async ({ request }) => {
    const response = await request.post(GENERATE, {
      headers: { Cookie: cookie(3), "content-type": "application/json" },
      data: "not json at all",
    });
    expect(response.status()).toBe(400);
  });
});

test("a generated picture shows up on the screens that render one", async ({
  context,
  page,
  request,
}) => {
  await generate(request, { recipeIds: [1, 2, 3], sheetBase64: SHEET });
  await context.addCookies([sessionCookie(3)]);

  // The recipe list: a thumbnail per row, loaded rather than a broken icon.
  await page.goto("/recipes");
  const thumbs = page.locator(".recipe-image.is-thumb img");
  await expect(thumbs).toHaveCount(3);
  for (let at = 0; at < 3; at += 1) {
    await expect(thumbs.nth(at)).toHaveJSProperty("complete", true);
    await expect(thumbs.nth(at)).not.toHaveJSProperty("naturalWidth", 0);
  }

  // The recipe screen: the same object as the band above the title.
  await page.goto("/recipes/1");
  const hero = page.locator(".recipe-image img").first();
  await expect(hero).toBeVisible();
  await expect(hero).toHaveJSProperty("naturalWidth", 512);
});
