import { expect, test, type Page } from "@playwright/test";

import { DRAFT_FIXTURE, stubStructuring } from "./support/draft";
import { openDraftEditor, openMore, openSpareLines } from "./support/lines";
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

test("intake requires JavaScript instead of posting a plain fallback", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  await context.addCookies([sessionCookie(1)]);
  const page = await context.newPage();

  await page.goto("/intake");

  await expect(page.locator("#status")).toHaveText(
    "Reseptin tuonti tarvitsee JavaScriptin.",
  );
  await expect(page.getByRole("button", { name: "Jäsennä" })).toBeDisabled();
  await expect(page.locator("#intake")).not.toHaveAttribute("action", /.+/);

  const response = await context.request.post("/intake", {
    form: { sourceText: "Uunikaali" },
  });
  expect(response.status()).toBe(405);

  await context.close();
});

test("pasted text works without the photo resize API", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "createImageBitmap", {
      value: undefined,
      configurable: true,
    });
  });
  await stubStructuring(page);

  await page.goto("/intake");

  await expect(page.getByRole("button", { name: "Jäsennä" })).toBeEnabled();
  await expect(page.locator("#camera")).toBeDisabled();
  await expect(page.locator("#photo")).toBeDisabled();
  await expect(page.locator("#photo-help")).toHaveText(
    "Kuvan tuonti ei ole käytettävissä tässä selaimessa.",
  );

  await page.getByLabel("Liitä reseptin teksti").fill("Uunikaali");
  await page.getByRole("button", { name: "Jäsennä" }).click();
  await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toBeVisible();
});

test("intake stays unavailable without the stream decoder", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "TextDecoder", {
      value: undefined,
      configurable: true,
    });
  });

  await page.goto("/intake");

  await expect(page.locator("#status")).toHaveText(
    "Reseptin tuonti tarvitsee JavaScriptin.",
  );
  await expect(page.getByRole("button", { name: "Jäsennä" })).toBeDisabled();
});

test("intake stays unavailable without streamed responses", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "Response", {
      value: function ResponseWithoutBody() {
        return { body: null };
      },
      configurable: true,
    });
  });

  await page.goto("/intake");

  await expect(page.locator("#status")).toHaveText(
    "Reseptin tuonti tarvitsee JavaScriptin.",
  );
  await expect(page.getByRole("button", { name: "Jäsennä" })).toBeDisabled();
});

test("an empty intake is refused without leaving the screen", async ({ page }) => {
  await page.goto("/intake");
  await page.getByRole("button", { name: "Jäsennä" }).click();

  await expect(page).toHaveURL(/\/intake$/);
  await expect(page.locator("#status")).toHaveText(
    "Liitä ensin reseptin teksti tai valitse kuva.",
  );
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

  // What lands is the recipe as it will be saved, not a form to fill in.
  await expect(page.locator(".review-title")).toHaveText("Uunikaali");
  await expect(page.locator(".lines li")).toHaveCount(DRAFT_FIXTURE.lines.length);
  await expect(page.locator("#title")).toBeHidden();

  await openDraftEditor(page);
  await expect(page.locator("#title")).toHaveValue("Uunikaali");
  await expect(page.locator("#yield")).toHaveValue("4");
  await expect(page.locator(".line")).toHaveCount(DRAFT_FIXTURE.lines.length + 3);
});

test("a draft that needs nothing saves in one tap", async ({ page }) => {
  await stubStructuring(page);
  await pasteAndStructure(page);

  // No selects touched, no fields filled, no disclosure opened. This is the
  // 99% case, and it is now one button.
  await page.getByRole("button", { name: "Tallenna resepti" }).click();

  await expect(page).toHaveURL(/\/recipes\/\d+$/);
  await expect(page.getByRole("heading", { name: "Uunikaali" })).toBeVisible();

  // The unmatched name became a shared ingredient, as the screen said it would.
  const response = await page.request.get("/api/ingredients");
  const body = (await response.json()) as { ingredients: { name: string }[] };
  expect(body.ingredients.map((i) => i.name)).toContain("hunaja");
});

test("the ingredients a step names arrive on the saved recipe", async ({
  page,
}) => {
  await stubStructuring(page);
  await pasteAndStructure(page);
  await page.getByRole("button", { name: "Tallenna resepti" }).click();
  await expect(page).toHaveURL(/\/recipes\/\d+$/);

  // The draft pointed at its own ingredient lines by index; saving turned those
  // into ingredient ids, including for the line whose ingredient the save had
  // to create. Nothing about the amount travelled with them (issue #120).
  const kaali = page
    .locator(".steps .mention")
    .filter({ has: page.locator(".mention-word", { hasText: "kaali" }) });
  await expect(kaali.locator(".mention-amount")).toBeHidden();
  await kaali.locator("label").click();
  await expect(kaali.locator(".mention-amount")).toHaveText("½ (500 g)");
});

test("the review reads as the recipe it will become", async ({ page }) => {
  await stubStructuring(page);
  await pasteAndStructure(page);

  const lines = page.locator(".lines li");
  // The same awkward shapes the saved recipe prints, printed the same way —
  // not the decimals the form happens to hold.
  await expect(lines.nth(0)).toContainText("½ dl");
  await expect(lines.nth(1)).toContainText("1–1½ l");
  // The fixture's line states no unit, so it reads exactly as the source did.
  await expect(lines.nth(2)).toContainText("½ (500 g)");
  await expect(lines.nth(3)).not.toContainText("0");
});

test("what will be created is stated before saving", async ({ page }) => {
  await stubStructuring(page);
  await pasteAndStructure(page);

  await expect(page.locator(".creating")).toContainText("hunaja");
});

test("the model's own doubts are gathered at the top", async ({ page }) => {
  await stubStructuring(page);
  await pasteAndStructure(page);

  const report = page.locator(".needs-answer");
  await expect(report).toContainText("Yksi rivi");
  await expect(report).toContainText("hieman");

  // And the doubted line carries it too, where the line is read.
  await expect(page.locator(".lines .line-note")).toHaveCount(1);
});

test("the unmatched line is the only one marked new", async ({ page }) => {
  await stubStructuring(page);
  await pasteAndStructure(page);

  await openDraftEditor(page);
  await expect(page.locator(".line .badge")).toHaveCount(1);
  await expect(page.locator(".line.is-new")).toContainText("hunaja");
});

test("a normal line shows what to check, not the storage schema", async ({
  page,
}) => {
  await stubStructuring(page);
  await pasteAndStructure(page);

  await openDraftEditor(page);

  // Line 0 is "½ dl öljyä": an ordinary amount, unit and ingredient.
  const ordinary = page.locator(".line").nth(0);
  await expect(ordinary.locator('input[name$=".quantity"]')).toBeVisible();
  await expect(ordinary.locator('input[name$=".unit"]')).toBeVisible();
  await expect(ordinary.locator("select")).toBeVisible();

  // The rare fields exist and will submit, but they are not in the way.
  await expect(ordinary.locator('input[name$=".quantityMax"]')).toBeHidden();
  await expect(ordinary.locator('input[name$=".altQuantity"]')).toBeHidden();
  await expect(ordinary.locator('input[name$=".section"]')).toBeHidden();
  await expect(ordinary.locator('input[name$=".source"]')).toBeHidden();
  await expect(ordinary.locator('input[type=checkbox]')).toBeHidden();
});

test("a line that uses a rare field is already showing it", async ({ page }) => {
  await stubStructuring(page);
  await pasteAndStructure(page);

  await openDraftEditor(page);

  // Line 1 is the range "1–1 ja ½ l vettä"; line 2 the second measurement
  // "½ (500 g) valkokaali". Neither may be hiding what it actually holds.
  await expect(
    page.locator(".line").nth(1).locator('input[name$=".quantityMax"]'),
  ).toBeVisible();
  await expect(
    page.locator(".line").nth(2).locator('input[name$=".altQuantity"]'),
  ).toBeVisible();

  // The ordinary line beside them stays folded.
  await expect(
    page.locator(".line").nth(0).locator('input[name$=".quantityMax"]'),
  ).toBeHidden();
});

test("nothing on the review is dressed as a refusal", async ({ page }) => {
  await stubStructuring(page);
  await pasteAndStructure(page);

  // The screen has things to point out, but nothing has gone wrong.
  await expect(page.locator(".refused")).toHaveCount(0);
});

test("blank rows are not the last thing on the screen", async ({ page }) => {
  await stubStructuring(page);
  await pasteAndStructure(page);

  await openDraftEditor(page);

  // Five real lines are shown; the spares are behind an explicit add.
  await expect(page.locator(".edit-lines").first().locator("> li")).toHaveCount(5);
  await expect(
    page.locator(".add-lines").getByText("+ Lisää ainesrivi"),
  ).toBeVisible();
  await expect(
    page.locator(".add-lines .line").first().locator('input[name$=".quantity"]'),
  ).toBeHidden();
});

test("the gate still refuses a line with no answer at all", async ({ page }) => {
  await stubStructuring(page);
  await pasteAndStructure(page);

  // The model's own proposals are preselected, so this has to be undone by
  // hand. The gate is narrowed, not removed.
  await openDraftEditor(page);
  await page.locator(".line.is-new select").selectOption("");
  await page.getByRole("button", { name: "Tallenna resepti" }).click();

  await expect(page.locator(".refused")).toContainText(
    "Jokaiselle uudelle ainekselle pitää vastata",
  );
  // Still on the review, with the work intact.
  await openDraftEditor(page);
  await expect(page.locator("#title")).toHaveValue("Uunikaali");
});

test("answering the new line saves the recipe", async ({ page }) => {
  await stubStructuring(page);
  await pasteAndStructure(page);

  await openDraftEditor(page);
  await page.locator(".line.is-new select").selectOption("new");
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

  await openDraftEditor(page);
  await page.locator(".line.is-new select").selectOption({ label: "vesi" });
  await page.getByRole("button", { name: "Tallenna resepti" }).click();
  await expect(page).toHaveURL(/\/recipes\/\d+$/);

  expect(await ingredientNames(page)).toEqual(before);
});

/**
 * Put a page into one of the two file inputs the way a phone would — the camera
 * one replaces its single file, the library one can be given several at once.
 * The text is drawn large so a person looking at a screenshot can tell the
 * pages apart.
 */
async function choosePages(
  page: Page,
  inputId: "camera" | "photo",
  pages: Array<{ text: string; width?: number; height?: number }>,
): Promise<void> {
  await page.evaluate(
    async ({ inputId, pages }) => {
      const transfer = new DataTransfer();

      for (const spec of pages) {
        const canvas = document.createElement("canvas");
        canvas.width = spec.width ?? 800;
        canvas.height = spec.height ?? 600;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#000000";
        context.font = `${Math.round(canvas.height / 8)}px sans-serif`;
        context.fillText(spec.text, 40, Math.round(canvas.height / 3));

        const blob = await new Promise<Blob>((resolve) =>
          canvas.toBlob((b) => resolve(b!), "image/png"),
        );
        transfer.items.add(
          new File([blob], `${spec.text}.png`, { type: "image/png" }),
        );
      }

      const input = document.getElementById(inputId) as HTMLInputElement;
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { inputId, pages },
  );
}

test("intake offers both a camera and the picture library", async ({ page }) => {
  await page.goto("/intake");

  // Taking the photograph here is the point: no leaving the app for the camera
  // app and coming back through the library.
  const camera = page.getByLabel("…tai ota kuva painetusta sivusta");
  await expect(camera).toHaveAttribute("accept", "image/*");
  await expect(camera).toHaveAttribute("capture", "environment");
  expect(await camera.getAttribute("multiple")).toBeNull();

  // Choosing an existing picture stays, and now takes several at once.
  const library = page.getByLabel("…tai valitse kuvia kuvakirjastosta");
  await expect(library).toHaveAttribute("accept", "image/*");
  await expect(library).toHaveAttribute("multiple", "");
  expect(await library.getAttribute("capture")).toBeNull();
});

test("a photographed page is downscaled in the browser before it is sent", async ({
  page,
}) => {
  const calls = await stubStructuring(page);
  await page.goto("/intake");

  // A page far larger than the long edge the client is supposed to enforce.
  await choosePages(page, "photo", [
    { text: "Uunikaali", width: 3000, height: 2000 },
  ]);

  await page.getByRole("button", { name: "Jäsennä" }).click();
  await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toBeVisible();

  expect(calls).toHaveLength(1);
  const sent = calls[0]!.body.images![0]!;
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

  await choosePages(page, "photo", [{ text: "Uunikaali" }]);

  await page.getByRole("button", { name: "Jäsennä" }).click();
  await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toBeVisible();

  const kept = await page.locator('input[name="sourceText"]').inputValue();
  expect(kept).toBe(DRAFT_FIXTURE.source_text);
});

/**
 * The case #156 exists for: a recipe printed across a spread. Two pages, one
 * recipe, and the order they were added is the order the model reads them in.
 */
test("several pages make one recipe, in the order they were added", async ({
  page,
}) => {
  const calls = await stubStructuring(page);
  await page.goto("/intake");

  await choosePages(page, "photo", [{ text: "Sivu A" }, { text: "Sivu B" }]);

  await expect(page.locator("#chosen li")).toHaveCount(2);
  await expect(page.locator("#chosen li .page-name")).toHaveText([
    "Sivu 1",
    "Sivu 2",
  ]);

  await page.getByRole("button", { name: "Jäsennä" }).click();
  await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toBeVisible();

  // One call, not one per page — the pages are material for one recipe.
  expect(calls).toHaveLength(1);
  const images = calls[0]!.body.images!;
  expect(images).toHaveLength(2);
  expect(calls[0]!.body.image).toBeUndefined();

  // And the order survived. Read the pages back and compare the pixels, rather
  // than trusting that the list the browser built was the list it sent.
  const words = await page.evaluate(async (sent) => {
    const read = async (base64: string) => {
      const response = await fetch(`data:image/jpeg;base64,${base64}`);
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
      // The two pages differ in how much ink they carry; that is enough to
      // tell them apart without reading the text back.
      const pixels = canvas.getContext("2d")!.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ).data;
      let dark = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i]! < 128) dark++;
      }
      return dark;
    };

    return Promise.all(sent.map((image) => read(image.image!)));
  }, images);

  expect(words[0]).toBeGreaterThan(0);
  expect(words[1]).toBeGreaterThan(0);
  expect(words[0]).not.toBe(words[1]);
});

test("camera shots and library pictures collect into the same recipe", async ({
  page,
}) => {
  const calls = await stubStructuring(page);
  await page.goto("/intake");

  // A camera input holds one file at a time, so this is the sequence that
  // used to lose everything but the last page.
  await choosePages(page, "camera", [{ text: "Kamera 1" }]);
  await choosePages(page, "camera", [{ text: "Kamera 2" }]);
  await choosePages(page, "photo", [{ text: "Kirjasto" }]);

  await expect(page.locator("#chosen li")).toHaveCount(3);

  await page.getByRole("button", { name: "Jäsennä" }).click();
  await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toBeVisible();

  expect(calls).toHaveLength(1);
  expect(calls[0]!.body.images).toHaveLength(3);
});

test("a page can be dropped before the recipe is parsed", async ({ page }) => {
  const calls = await stubStructuring(page);
  await page.goto("/intake");

  await choosePages(page, "photo", [
    { text: "Sivu A" },
    { text: "Sivu B" },
    { text: "Sivu C" },
  ]);
  await expect(page.locator("#chosen li")).toHaveCount(3);

  // Drop the middle page; the ones left renumber rather than leaving a gap.
  await page.locator("#chosen li").nth(1).getByRole("button", { name: "Poista" }).click();

  await expect(page.locator("#chosen li")).toHaveCount(2);
  await expect(page.locator("#chosen li .page-name")).toHaveText([
    "Sivu 1",
    "Sivu 2",
  ]);

  await page.getByRole("button", { name: "Jäsennä" }).click();
  await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toBeVisible();

  expect(calls[0]!.body.images).toHaveLength(2);
});

test("too many pages are refused before the model is called", async ({ page }) => {
  await page.goto("/intake");

  // Straight at the endpoint: the browser stops at the cap, but the cap that
  // matters is the one no browser can talk past.
  const response = await page.request.post("/api/intake/structure", {
    data: {
      images: Array.from({ length: 40 }, () => ({
        image: "iVBORw0KGgo=",
        mediaType: "image/jpeg",
      })),
    },
  });

  expect(response.status()).toBe(400);
});

test("a body carrying no usable picture is refused, not sent to the model", async ({
  page,
}) => {
  await page.goto("/intake");

  // An empty list and a list of nothing usable both mean "no picture", and the
  // refusal has to happen here rather than as an empty model call.
  for (const data of [{ images: [] }, { images: [{ mediaType: "image/jpeg" }] }]) {
    const response = await page.request.post("/api/intake/structure", { data });

    expect(response.status()).toBe(400);
  }
});

test("steps can be reordered before saving", async ({ page }) => {
  await stubStructuring(page);
  await pasteAndStructure(page);

  await openDraftEditor(page);

  // The draft's two steps, swapped by their position boxes.
  const positions = page.locator(".edit-step input[name$=position]");
  await expect(positions).toHaveCount(2);
  await positions.nth(0).fill("2");
  await positions.nth(1).fill("1");

  await page.getByRole("button", { name: "Tallenna resepti" }).click();
  await expect(page).toHaveURL(/\/recipes\/\d+$/);

  // `useInnerText`, because a step now carries each linked ingredient's amount
  // in the markup with `display: none` on it until it is tapped (issue #120).
  // Nobody reads it, nothing copies it and no screen reader announces it, but
  // it is in `textContent` — so a step's wording is asserted as rendered.
  const steps = page.locator("ol li");
  await expect(steps.nth(0)).toContainText("Lisää vesi", { useInnerText: true });
  await expect(steps.nth(1)).toContainText("Kuullota kaali", {
    useInnerText: true,
  });
});

test("the sample draft opens the review without calling anything", async ({
  page,
}) => {
  // Deliberately no stub: if this reached the model the request would fail,
  // because CI writes a .dev.vars with no key at all.
  let called = 0;
  await page.route("**/api/intake/structure", (route) => {
    called += 1;
    return route.abort();
  });

  await page.goto("/intake");
  await page.getByRole("button", { name: "Avaa esimerkkiluonnos" }).click();

  await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toBeVisible();
  await expect(page.locator(".review-title")).toHaveText("Uunikaali");
  expect(called).toBe(0);

  // And it is the real save, not a mock of one.
  await page.getByRole("button", { name: "Tallenna resepti" }).click();
  await expect(page).toHaveURL(/\/recipes\/\d+$/);
  await expect(page.locator(".lines li")).toHaveCount(5);
});

test("a failed structuring keeps what was typed", async ({ page }) => {
  await page.route("**/api/intake/structure", (route) =>
    route.fulfill({ status: 503, body: '{"error":"Kokeile myöhemmin."}' }),
  );

  await page.goto("/intake");
  await page.getByLabel("Liitä reseptin teksti").fill("Uunikaali\n½ dl öljyä");
  await page.getByRole("button", { name: "Jäsennä" }).click();

  await expect(page.locator("#status")).toHaveText(
    "Jäsennys epäonnistui. Yritä hetken kuluttua uudelleen.",
  );
  await expect(page.locator("#status")).not.toContainText("Kokeile myöhemmin");
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
