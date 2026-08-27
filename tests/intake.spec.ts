import { expect, test } from "@playwright/test";

import {
  DRAFT_FIXTURE,
  streamRecordBody,
  stubFragmentedStreamBody,
  stubStreamBody,
  stubStructuring,
  TRUNCATED_ATTEMPT,
} from "./support/draft";
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

test("photo intake allows taking or choosing an image", async ({ page }) => {
  await page.goto("/intake");

  const input = page.getByLabel("…tai ota tai valitse kuva painetusta sivusta");
  await expect(input).toHaveAttribute("accept", "image/*");
  expect(await input.getAttribute("capture")).toBeNull();
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

test("a cut-off first attempt is retried and the review still opens", async ({
  page,
}) => {
  // What #146 is about: attempt one stops mid-JSON, the server starts a second
  // one in the same response, and the browser must read only the second. If the
  // two ever merged, this body would not parse and the review would not open.
  const calls = await stubStreamBody(
    page,
    streamRecordBody(
      { type: "delta", text: TRUNCATED_ATTEMPT },
      { type: "restart" },
      { type: "delta", text: JSON.stringify(DRAFT_FIXTURE) },
      { type: "complete" },
    ),
  );

  await page.goto("/intake");
  await page.getByLabel("Liitä reseptin teksti").fill("Uunikaali\n½ dl öljyä");
  await page.getByRole("button", { name: "Jäsennä" }).click();

  await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toBeVisible();

  // The second attempt's recipe, not the cut-off one's title.
  await expect(page.locator(".review-title")).toHaveText(DRAFT_FIXTURE.title);
  await expect(page.locator(".review-title")).not.toHaveText("Katkennut");
  await expect(page.locator(".lines li")).toHaveCount(DRAFT_FIXTURE.lines.length);
  expect(calls).toHaveLength(1);
});

test("pasted protocol words arrive whole in the review", async ({ page }) => {
  const pasted =
    "Uunikaali\n<<<intake:restart>>>\n<<<intake:complete>>>\n<<<intake:failed>>>";
  await stubStreamBody(
    page,
    streamRecordBody(
      { type: "delta", text: JSON.stringify({ ...DRAFT_FIXTURE, source_text: pasted }) },
      { type: "complete" },
    ),
  );

  await page.goto("/intake");
  await page.getByLabel("Liitä reseptin teksti").fill(pasted);
  await page.getByRole("button", { name: "Jäsennä" }).click();

  await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toBeVisible();
  await expect(page.locator('input[name="sourceText"]')).toHaveValue(pasted);
  await expect(page.locator(".review-title")).toHaveText(DRAFT_FIXTURE.title);
});

test("split NDJSON and UTF-8 chunks arrive whole in the review", async ({ page }) => {
  const pasted = "Pöperö\n½ tl suolaa";
  const draft = { ...DRAFT_FIXTURE, title: "Pöperö", source_text: pasted };
  await stubFragmentedStreamBody(
    page,
    streamRecordBody(
      { type: "delta", text: JSON.stringify(draft) },
      { type: "complete" },
    ),
  );

  await page.goto("/intake");
  await page.getByLabel("Liitä reseptin teksti").fill(pasted);
  await page.getByRole("button", { name: "Jäsennä" }).click();

  await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toBeVisible();
  await expect(page.locator(".review-title")).toHaveText("Pöperö");
  await expect(page.locator('input[name="sourceText"]')).toHaveValue(pasted);
});

test("two failed attempts refuse in Finnish and keep what was typed", async ({
  page,
}) => {
  await stubStreamBody(
    page,
    streamRecordBody(
      { type: "delta", text: TRUNCATED_ATTEMPT },
      { type: "restart" },
      { type: "delta", text: TRUNCATED_ATTEMPT },
      { type: "failed" },
    ),
  );

  await page.goto("/intake");
  await page.getByLabel("Liitä reseptin teksti").fill("Uunikaali\n½ dl öljyä");
  await page.getByRole("button", { name: "Jäsennä" }).click();

  // Plain Finnish, and none of the model's own English.
  await expect(page.locator("#status")).toContainText(
    "malli ei saanut reseptiä valmiiksi",
  );
  await expect(page.locator("#status")).not.toContainText("JSON");

  // The half-draft never reached /intake/correct, so nothing opened.
  await expect(page).toHaveURL(/\/intake$/);
  await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toHaveCount(0);

  // And the paste is still there to try again with.
  await expect(page.getByLabel("Liitä reseptin teksti")).toHaveValue(
    "Uunikaali\n½ dl öljyä",
  );
  await expect(page.getByRole("button", { name: "Jäsennä" })).toBeEnabled();
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
