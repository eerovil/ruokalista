import { expect, test } from "@playwright/test";

import { DRAFT_FIXTURE, stubStructuring } from "./support/draft";
import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * The intake island — the streaming client, the camera downscale, and the
 * approval gate as a person actually meets them.
 *
 * The model is stubbed throughout: these tests never spend anything.
 */

test.beforeAll(reseed);

test.beforeEach(async ({ context }) => {
  await context.addCookies([sessionCookie(1)]);
});

test("pasting text streams a draft and opens the correction screen", async ({
  page,
}) => {
  const calls = await stubStructuring(page);

  await page.goto("/intake");
  await page.getByLabel("Liitä reseptin teksti").fill("Uunikaali\n½ dl öljyä");
  await page.getByRole("button", { name: "Jäsennä" }).click();

  await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toBeVisible();

  // The browser really went through the streaming endpoint, with the text.
  expect(calls).toHaveLength(1);
  expect(calls[0]?.body.sourceText).toContain("Uunikaali");
  expect(calls[0]?.body.image).toBeUndefined();

  await expect(page.locator("#title")).toHaveValue("Uunikaali");
  await expect(page.locator("#yield")).toHaveValue("4");
  await expect(page.locator(".line")).toHaveCount(DRAFT_FIXTURE.lines.length + 3);
});

test("the unmatched line is the only one marked new", async ({ page }) => {
  await stubStructuring(page);
  await pasteAndStructure(page);

  await expect(page.locator(".badge")).toHaveCount(1);
  await expect(page.locator(".line.is-new")).toContainText("hunaja");
});

test("the gate refuses a save while a line is unanswered", async ({ page }) => {
  await stubStructuring(page);
  await pasteAndStructure(page);

  await page.getByRole("button", { name: "Tallenna resepti" }).click();

  await expect(page.locator(".refused")).toContainText(
    "Jokaiselle uudelle ainekselle pitää vastata",
  );
  // Still on the correction screen, with the work intact.
  await expect(page.locator("#title")).toHaveValue("Uunikaali");
});

test("answering the new line saves the recipe", async ({ page }) => {
  await stubStructuring(page);
  await pasteAndStructure(page);

  await page
    .locator(".line.is-new select")
    .selectOption("new");
  await page.getByRole("button", { name: "Tallenna resepti" }).click();

  await expect(page).toHaveURL(/\/recipes\/\d+$/);
  await expect(page.getByRole("heading", { name: "Uunikaali" })).toBeVisible();

  // The awkward shapes survived the whole round trip.
  const lines = page.locator(".lines li");
  await expect(lines.nth(1)).toContainText("1–1½ l");
  await expect(lines.nth(2)).toContainText("(500 g)");

  // And the approved name became a shared ingredient.
  const response = await page.request.get("/api/ingredients");
  const body = (await response.json()) as { ingredients: { name: string }[] };
  expect(body.ingredients.map((i) => i.name)).toContain("hunaja");
});

test("pointing a new line at an existing ingredient creates nothing", async ({
  page,
}) => {
  await stubStructuring(page);
  await pasteAndStructure(page);

  const before = await ingredientNames(page);

  await page.locator(".line.is-new select").selectOption({ label: "vesi" });
  await page.getByRole("button", { name: "Tallenna resepti" }).click();
  await expect(page).toHaveURL(/\/recipes\/\d+$/);

  expect(await ingredientNames(page)).toEqual(before);
});

test("a photographed page is downscaled in the browser before it is sent", async ({
  page,
}) => {
  const calls = await stubStructuring(page);
  await page.goto("/intake");

  // A page far larger than the long edge the client is supposed to enforce.
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 3000;
    canvas.height = 2000;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#000000";
    context.font = "120px sans-serif";
    context.fillText("Uunikaali", 120, 400);

    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => resolve(b!), "image/png"),
    );
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "sivu.png", { type: "image/png" }));

    const input = document.getElementById("photo") as HTMLInputElement;
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await page.getByRole("button", { name: "Jäsennä" }).click();
  await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toBeVisible();

  expect(calls).toHaveLength(1);
  const sent = calls[0]!.body;
  expect(sent.mediaType).toBe("image/jpeg");
  expect(sent.image).toBeTruthy();
  // Re-encoded as JPEG, not passed through as the PNG that was chosen.
  expect(sent.image!.startsWith("/9j/")).toBe(true);

  // Measure what was actually sent, rather than trusting the code that sent it.
  const size = await page.evaluate(async (base64) => {
    const response = await fetch(`data:image/jpeg;base64,${base64}`);
    const bitmap = await createImageBitmap(await response.blob());
    return { width: bitmap.width, height: bitmap.height };
  }, sent.image!);

  expect(Math.max(size.width, size.height)).toBe(1500);
  expect(size.height).toBe(1000);
});

test("a photographed recipe keeps the model's transcription as its source", async ({
  page,
}) => {
  await stubStructuring(page);
  await page.goto("/intake");

  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    canvas.getContext("2d")!.fillRect(0, 0, 10, 10);
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => resolve(b!), "image/png"),
    );
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "sivu.png", { type: "image/png" }));
    const input = document.getElementById("photo") as HTMLInputElement;
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await page.getByRole("button", { name: "Jäsennä" }).click();
  await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toBeVisible();

  const kept = await page.locator('input[name="sourceText"]').inputValue();
  expect(kept).toBe(DRAFT_FIXTURE.source_text);
});

test("a failed structuring keeps what was typed", async ({ page }) => {
  await page.route("**/api/intake/structure", (route) =>
    route.fulfill({ status: 503, body: '{"error":"Kokeile myöhemmin."}' }),
  );

  await page.goto("/intake");
  await page.getByLabel("Liitä reseptin teksti").fill("Uunikaali\n½ dl öljyä");
  await page.getByRole("button", { name: "Jäsennä" }).click();

  await expect(page.locator("#status")).toContainText("epäonnistui");
  await expect(page.getByLabel("Liitä reseptin teksti")).toHaveValue(
    "Uunikaali\n½ dl öljyä",
  );
  // And it lets you try again rather than stranding you.
  await expect(page.getByRole("button", { name: "Jäsennä" })).toBeEnabled();
});

async function pasteAndStructure(page: import("@playwright/test").Page) {
  await page.goto("/intake");
  await page.getByLabel("Liitä reseptin teksti").fill("Uunikaali");
  await page.getByRole("button", { name: "Jäsennä" }).click();
  await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toBeVisible();
}

async function ingredientNames(page: import("@playwright/test").Page) {
  const response = await page.request.get("/api/ingredients");
  const body = (await response.json()) as { ingredients: { name: string }[] };
  return body.ingredients.map((i) => i.name);
}
