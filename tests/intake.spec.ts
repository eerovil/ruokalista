import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DRAFT_FIXTURE,
  stubStructuring,
  UNSAVABLE_AMOUNT_DRAFT,
} from "./support/draft";
import { openDraftEditor, openMore, openSpareLines } from "./support/lines";
import { flatPng } from "./support/png";
import { captureReview } from "./support/review-capture";
import { executeLocalSql, reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * The intake island — the queued client, the camera downscale, and the
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
  await expect(page.getByRole("button", { name: "Muodosta resepti" })).toBeDisabled();
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

  await expect(page.getByRole("button", { name: "Muodosta resepti" })).toBeEnabled();
  await expect(page.locator("#camera")).toBeDisabled();
  await expect(page.locator("#photo")).toBeDisabled();
  await expect(page.locator("#photo-help")).toHaveText(
    "Kuvan tuonti ei ole käytettävissä tässä selaimessa.",
  );

  await page.getByLabel("Liitä reseptin teksti").fill("Uunikaali");
  await page.getByRole("button", { name: "Muodosta resepti" }).click();
  await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toBeVisible();
});

test("pasted intake no longer needs a stream decoder", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "TextDecoder", {
      value: undefined,
      configurable: true,
    });
  });

  await page.goto("/intake");

  await expect(page.getByRole("button", { name: "Muodosta resepti" })).toBeEnabled();
});

test("pasted intake no longer needs streamed responses", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "Response", {
      value: function ResponseWithoutBody() {
        return { body: null };
      },
      configurable: true,
    });
  });

  await page.goto("/intake");

  await expect(page.getByRole("button", { name: "Muodosta resepti" })).toBeEnabled();
});

test("an empty intake is refused without leaving the screen", async ({ page }) => {
  await page.goto("/intake");
  await page.getByRole("button", { name: "Muodosta resepti" }).click();

  await expect(page).toHaveURL(/\/intake$/);
  await expect(page.locator("#status")).toHaveText(
    "Anna reseptin osoite, liitä sen teksti tai valitse kuva.",
  );
});

/**
 * The quick save (#211): the name is all somebody has, and it must reach the
 * store without JavaScript, without a model call and without ingredients.
 */
test("a recipe can be saved from its name alone, with no model call", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  await context.addCookies([sessionCookie(1)]);
  const page = await context.newPage();

  // Nothing stubs the model here on purpose: a call would fail this test rather
  // than be answered, which is the acceptance criterion.
  await page.goto("/intake");
  await page.getByLabel("Reseptin nimi").fill("Mummin lihapullat");
  await page.getByRole("button", { name: "Tallenna keskeneräisenä" }).click();

  await expect(page).toHaveURL(/\/recipes\/\d+$/);
  await expect(
    page.getByRole("heading", { name: "Mummin lihapullat" }),
  ).toBeVisible();
  await expect(page.locator(".lines li")).toHaveCount(0);

  // And it is an ordinary recipe: the editor opens on it and fills it in.
  await page.getByRole("link", { name: "Muokkaa reseptiä" }).click();
  await page.locator("#yield").fill("4");
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();
  await expect(page.locator(".refused")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Mummin lihapullat" }),
  ).toBeVisible();

  await context.close();
  reseed();
});

test("the quick save refuses a nameless recipe and keeps the screen", async ({
  page,
}) => {
  await page.goto("/intake");
  await page.getByRole("button", { name: "Tallenna keskeneräisenä" }).click();

  await expect(page.locator(".refused")).toContainText(
    "Reseptillä pitää olla nimi.",
  );
  await expect(
    page.getByRole("button", { name: "Muodosta resepti" }),
  ).toBeVisible();
});

const LINKED_URL = "https://kotikokki.example/reseptit/uunikaali";
const LINKED_TEXT = "Uunikaali\n4 annosta\n½ dl öljyä\n500 g valkokaalia\n1 l vettä";
const variantLine = (sourceLine: string, ingredientName: string, section: string | null) => ({
  ...DRAFT_FIXTURE.lines[0]!,
  quantity: 1,
  unit: "rkl",
  ingredient_id: null,
  ingredient_name: ingredientName,
  source_line: sourceLine,
  section,
  phase: section === null ? "before_parts" : null,
  note: null,
});
const VARIANT_DRAFT = {
  ...DRAFT_FIXTURE,
  title: "Välipalapatukat",
  source_text: "Välipalapatukat\nPerusmassa\nSeuraavat makuvaihtoehdot",
  lines: [
    variantLine("100 g pähkinöitä", "pähkinä", null),
    variantLine("100 g taateleita", "taateli", null),
    variantLine("15 g vadelmia", "vadelma", "Vadelma"),
    variantLine("1 tl lakritsijauhetta", "lakritsijauhe", "Lakritsi"),
    variantLine("¾ tl kardemummaa", "kardemumma", "Piparkakku"),
    variantLine("4 rkl maapähkinävoita", "maapähkinävoi", "Maapähkinä"),
    variantLine("2 rkl kaakaojauhetta", "kaakaojauhe", "Appelsiini-kaakao"),
  ],
  steps: DRAFT_FIXTURE.steps.map((step) => ({
    ...step,
    section: null,
    phase: "after_parts",
    ingredient_refs: [],
  })),
};

test("a web address becomes a background import and is kept on the recipe", async ({
  page,
}) => {
  const calls = await stubStructuring(page, DRAFT_FIXTURE, {
    linkedText: LINKED_TEXT,
    linkedUrl: LINKED_URL,
  });

  await page.goto("/intake");
  await page
    .getByLabel("…tai hae resepti nettiosoitteesta")
    .fill("kotikokki.example/reseptit/uunikaali");
  await page.getByRole("button", { name: "Muodosta resepti" }).click();

  // The address is what was submitted — not page text. Nothing was fetched in
  // this request; the queue consumer is what reads the site.
  expect(calls).toHaveLength(1);
  expect(calls[0]?.body.url).toBe("kotikokki.example/reseptit/uunikaali");
  expect(calls[0]?.body.guidance).toBeUndefined();
  expect(calls[0]?.body.sourceText).toBeUndefined();

  await expect(
    page.getByRole("heading", { name: "Tarkista resepti" }),
  ).toBeVisible();

  // The review carries the route and the address into the save.
  await expect(page.locator('input[name="sourceRoute"]')).toHaveValue("linked");
  await expect(page.locator('input[name="sourceUrl"]')).toHaveValue(LINKED_URL);
  await expect(page.locator('input[name="sourceText"]')).toHaveValue(LINKED_TEXT);

  await page.getByRole("button", { name: "Tallenna resepti" }).click();
  await expect(page).toHaveURL(/\/recipes\/\d+$/);

  await page.getByText("Näytä alkuperäinen").click();
  const link = page.locator(".source-link a");
  await expect(link).toHaveText("kotikokki.example");
  await expect(link).toHaveAttribute("href", LINKED_URL);
});

for (const host of ["k-ruoka.fi", "www.k-ruoka.fi"]) {
  test(`a ${host} link is refused before a job starts`, async ({ page }) => {
    const address = `https://${host}/reseptit/helppo-texmex-broilerilasagne`;
    await page.goto("/intake");
    const before = await page.locator("[data-intake-job]").count();
    const sourceUrl = page.getByLabel("…tai hae resepti nettiosoitteesta");

    await sourceUrl.fill(address);
    await page.getByRole("button", { name: "Muodosta resepti" }).click();

    await expect(page.locator("#status")).toHaveText(
      "K-Ruoka-linkkejä ei tueta. Liitä reseptin teksti tai tuo resepti kuvasta.",
    );
    await expect(sourceUrl).toHaveValue(address);
    await expect(page.getByRole("button", { name: "Muodosta resepti" })).toBeEnabled();
    await expect(page.locator("[data-intake-job]")).toHaveCount(before);
    if (host === "www.k-ruoka.fi") {
      await captureReview(page, "docs/screenshots/115-intake-k-ruoka-unsupported.png");
    }
    // The list is server-rendered, so reload before using it as persistence
    // evidence: the rejected request must not have left a job behind.
    await page.reload();
    await expect(page.locator("[data-intake-job]")).toHaveCount(before);
  });
}

test("pasted text can replace a refused K-Ruoka link without clearing it", async ({
  page,
}) => {
  await page.goto("/intake");
  const sourceUrl = page.getByLabel("…tai hae resepti nettiosoitteesta");
  const address = "https://www.k-ruoka.fi/reseptit/helppo-texmex-broilerilasagne";

  await sourceUrl.fill(address);
  await page.getByRole("button", { name: "Muodosta resepti" }).click();
  await expect(page.locator("#status")).toContainText("K-Ruoka-linkkejä ei tueta");

  // The first request must reach the real server boundary above. Install the
  // no-model queue stand-in only for the pasted retry.
  const calls = await stubStructuring(page);
  await page.getByLabel("Liitä reseptin teksti").fill("Uunikaali\n½ dl öljyä");
  await page.getByRole("button", { name: "Muodosta resepti" }).click();

  expect(calls).toHaveLength(1);
  expect(calls[0]?.body.url).toBe(address);
  expect(calls[0]?.body.sourceText).toBe("Uunikaali\n½ dl öljyä");
});

test("an explicit flavor outline reviews as five parts with one shared base", async ({
  page,
}) => {
  await stubStructuring(page, VARIANT_DRAFT, {
    linkedText: VARIANT_DRAFT.source_text,
    linkedUrl: "https://www.kinuskikissa.fi/valipalapatukat",
  });

  await page.goto("/intake");
  await page
    .getByLabel("…tai hae resepti nettiosoitteesta")
    .fill("https://www.kinuskikissa.fi/valipalapatukat");
  await page.getByRole("button", { name: "Muodosta resepti" }).click();

  for (const flavor of [
    "Vadelma",
    "Lakritsi",
    "Piparkakku",
    "Maapähkinä",
    "Appelsiini-kaakao",
  ]) {
    await expect(page.getByRole("heading", { name: flavor, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "Perusmassa", exact: true }))
    .toHaveCount(0);
  await expect(page.getByText("100 g pähkinöitä", { exact: true }).first())
    .toBeVisible();
});

test("optional guidance follows a web address into its queued import", async ({
  page,
}) => {
  const calls = await stubStructuring(page, VARIANT_DRAFT, {
    linkedText: VARIANT_DRAFT.source_text,
    linkedUrl: "https://www.kinuskikissa.fi/valipalapatukat",
  });

  await page.goto("/intake");
  const guidance = page.getByLabel("Lisäohje tuontiin (valinnainen)");
  await expect(guidance).toBeHidden();
  await page
    .getByLabel("…tai hae resepti nettiosoitteesta")
    .fill("https://www.kinuskikissa.fi/valipalapatukat");
  await expect(guidance).toBeVisible();
  await guidance.fill("Sivulla on kaksi reseptiä; lue vain alempi.");
  await page.getByRole("button", { name: "Muodosta resepti" }).click();

  expect(calls).toHaveLength(1);
  expect(calls[0]?.body.guidance).toBe(
    "Sivulla on kaksi reseptiä; lue vain alempi.",
  );
  await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Appelsiini-kaakao" })).toBeVisible();
});

/** The picture the consumer found on the page, on disk for the stub to store. */
function foundPictureFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), "ruokalista-found-")), "found.png");
  writeFileSync(path, flatPng(900, 600, [180, 120, 60]));
  return path;
}

test("a picture found on the page is shown, and saved with the recipe", async ({
  page,
}) => {
  await stubStructuring(page, DRAFT_FIXTURE, {
    linkedText: LINKED_TEXT,
    linkedUrl: LINKED_URL,
    linkedImage: foundPictureFile(),
  });

  await page.goto("/intake");
  await page.getByLabel("…tai hae resepti nettiosoitteesta").fill(LINKED_URL);
  await page.getByRole("button", { name: "Muodosta resepti" }).click();

  // Seen before it is saved, and really loaded rather than a broken image: the
  // point of showing it is that somebody can tell the dish from a masthead.
  const shown = page.locator(".found-image img");
  await expect(shown).toBeVisible();
  await expect(shown).toHaveJSProperty("naturalWidth", 900);
  const keep = page.getByLabel("Tallenna sivulta löytynyt kuva reseptin kuvaksi");
  await expect(keep).toBeChecked();

  await page.getByRole("button", { name: "Tallenna resepti" }).click();
  await expect(page).toHaveURL(/\/recipes\/\d+$/);

  // And it is the recipe's own picture now, served from this app rather than
  // linked back to the site it came from.
  const hero = page.locator(".recipe-image img");
  await expect(hero).toBeVisible();
  await expect(hero).toHaveJSProperty("naturalWidth", 900);
  await expect(hero).toHaveAttribute("src", /^\/api\/recipes\/\d+\/image/);
});

test("unticking the found picture saves the recipe without one", async ({
  page,
}) => {
  await stubStructuring(page, DRAFT_FIXTURE, {
    linkedText: LINKED_TEXT,
    linkedUrl: LINKED_URL,
    linkedImage: foundPictureFile(),
  });

  await page.goto("/intake");
  await page.getByLabel("…tai hae resepti nettiosoitteesta").fill(LINKED_URL);
  await page.getByRole("button", { name: "Muodosta resepti" }).click();

  await page
    .getByLabel("Tallenna sivulta löytynyt kuva reseptin kuvaksi")
    .uncheck();
  await page.getByRole("button", { name: "Tallenna resepti" }).click();

  await expect(page).toHaveURL(/\/recipes\/\d+$/);
  await expect(page.locator(".recipe-image img")).toHaveCount(0);
});

test("an import that found no picture offers nothing to tick", async ({
  page,
}) => {
  await stubStructuring(page, DRAFT_FIXTURE, {
    linkedText: LINKED_TEXT,
    linkedUrl: LINKED_URL,
  });

  await page.goto("/intake");
  await page.getByLabel("…tai hae resepti nettiosoitteesta").fill(LINKED_URL);
  await page.getByRole("button", { name: "Muodosta resepti" }).click();

  await expect(
    page.getByRole("heading", { name: "Tarkista resepti" }),
  ).toBeVisible();
  await expect(page.locator(".found-image")).toHaveCount(0);
});

test("a partial fetched page is preserved through the review", async ({
  page,
}) => {
  await stubStructuring(page, DRAFT_FIXTURE, {
    linkedText: "Uunikaali\n1 valkokaali",
    linkedUrl: "https://kotikokki.example/vajaa",
  });

  await page.goto("/intake");
  await page
    .getByLabel("…tai hae resepti nettiosoitteesta")
    .fill("https://kotikokki.example/vajaa");
  await page.getByRole("button", { name: "Muodosta resepti" }).click();

  await expect(
    page.getByRole("heading", { name: "Tarkista resepti" }),
  ).toBeVisible();
  // An import that got only half the page is still an import: what was found
  // remains the source text carried into review and save.
  await expect(page.locator('input[name="sourceText"]')).toHaveValue(
    "Uunikaali\n1 valkokaali",
  );
});

test("a page with no recipe on it fails the import in Finnish, with a retry", async ({
  page,
}) => {
  await stubStructuring(page, DRAFT_FIXTURE, {
    linkedUrl: "https://kotikokki.example/etusivu",
    failWith:
      "Sivulta ei löytynyt reseptiä. Voit liittää tekstin itse tuontilomakkeelle.",
  });

  await page.goto("/intake");
  await page
    .getByLabel("…tai hae resepti nettiosoitteesta")
    .fill("https://kotikokki.example/etusivu");
  await page.getByRole("button", { name: "Muodosta resepti" }).click();

  // The failure lives on the import list, like every other background failure,
  // rather than as a message that disappears with the page.
  await expect(page).toHaveURL(/\/intake/);
  const job = page.locator("[data-intake-job]").first();
  await expect(job.locator(".refused")).toHaveText(
    "Sivulta ei löytynyt reseptiä. Voit liittää tekstin itse tuontilomakkeelle.",
  );
  // Named by its site, because a linked job that never read the page has no
  // text to be named by.
  await expect(job.getByText("kotikokki.example")).toBeVisible();
  await expect(job.locator(".meta")).toHaveText("Nettiosoite");
  await expect(job.getByRole("button", { name: "Yritä uudelleen" })).toBeVisible();

  // This file reseeds once, so a failed job left here would show up on every
  // later test's import list.
  executeLocalSql("DELETE FROM intake_job WHERE source_route = 'linked'");
});

test("an address that is not one is refused before a job exists", async ({
  page,
}) => {
  await page.goto("/intake");
  const before = await page.locator("[data-intake-job]").count();

  await page.getByLabel("…tai hae resepti nettiosoitteesta").fill("ei mikään osoite");
  await page.getByRole("button", { name: "Muodosta resepti" }).click();

  // Refused by the server while the member is still looking at the field, in
  // the server's own Finnish rather than the island's fallback wording.
  await expect(page.locator("#status")).toHaveText(
    "Osoite ei näytä nettiosoitteelta. Tarkista linkki.",
  );
  await expect(page.getByRole("button", { name: "Muodosta resepti" })).toBeEnabled();
  // Nothing was queued: an address that could never be fetched does not become
  // a job that is certain to fail.
  await expect(page.locator("[data-intake-job]")).toHaveCount(before);
});

test("pasting text queues a draft and opens the completed review", async ({
  page,
}) => {
  const calls = await stubStructuring(page);

  await page.goto("/intake");
  await page.getByLabel("Liitä reseptin teksti").fill("Uunikaali\n½ dl öljyä");
  await page.getByRole("button", { name: "Muodosta resepti" }).click();

  await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toBeVisible();

  // The browser really went through the queued endpoint, with the text.
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

test("a model's unsavable amounts are repaired before the review (#233)", async ({
  page,
}) => {
  await stubStructuring(page, UNSAVABLE_AMOUNT_DRAFT);
  await pasteAndStructure(page);

  const lines = page.locator(".lines li");

  // The pinch the model wrote as 0,0005 kg reads as the half gram it is.
  await expect(lines.nth(1)).toContainText("½ g");
  // The flat zero states no amount at all rather than "0 kg", and says so.
  await expect(lines.nth(0)).not.toContainText("0");
  await expect(lines.nth(0).locator(".line-note")).toBeVisible();
  // A zero upper end costs the range, not the line.
  await expect(lines.nth(2)).toContainText("1 kpl");
  await expect(lines.nth(2)).not.toContainText("–");

  // And the whole point: the draft saves without the member touching anything.
  await page.getByRole("button", { name: "Tallenna resepti" }).click();

  await expect(page).toHaveURL(/\/recipes\/\d+$/);
  await expect(page.locator(".refused")).toHaveCount(0);
  await expect(page.locator(".lines li").nth(1)).toContainText("½ g");
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

  await page.getByRole("button", { name: "Muodosta resepti" }).click();
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

  await page.getByRole("button", { name: "Muodosta resepti" }).click();
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

  await page.getByRole("button", { name: "Muodosta resepti" }).click();
  await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toBeVisible({
    timeout: 15_000,
  });

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

  await page.getByRole("button", { name: "Muodosta resepti" }).click();
  await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toBeVisible({
    timeout: 15_000,
  });

  expect(calls).toHaveLength(1);
  expect(calls[0]!.body.images).toHaveLength(3);
});

/**
 * Issue #218: four pages killed the tab, and the thumbnails were most of why.
 * A picture is decoded at its own size before it is drawn at 3 rem, so a list
 * of originals held tens of megabytes a page. Each page is now shrunk as it is
 * chosen and the original is let go, which is what this checks — the row shows
 * a small copy, not the photograph.
 */
test("a chosen page is shrunk as it is added, and shown as the small copy", async ({
  page,
}) => {
  await page.goto("/intake");

  await choosePages(page, "photo", [
    { text: "Iso sivu", width: 3000, height: 2250 },
  ]);
  await expect(page.locator("#chosen li")).toHaveCount(1);

  const thumb = page.locator("#chosen li img");
  // A blob: URL here would mean the original file is still being held.
  expect(await thumb.getAttribute("src")).toMatch(/^data:image\/jpeg;base64,/);

  const drawn = await thumb.evaluate(
    (image) => (image as HTMLImageElement).naturalWidth,
  );
  expect(drawn).toBeLessThanOrEqual(192);
});

test("nothing can be sent while a page is still being read", async ({ page }) => {
  await page.goto("/intake");

  // Held open until this test lets go, so the in-between state is observable
  // rather than something that flickers past on a fast machine.
  await page.evaluate(() => {
    const real = window.createImageBitmap;
    (window as unknown as { release: () => void }).release = () => {};
    window.createImageBitmap = ((...args: unknown[]) =>
      new Promise((resolve) => {
        (window as unknown as { release: () => void }).release = () => {
          resolve(
            (real as unknown as (...a: unknown[]) => Promise<ImageBitmap>)(...args),
          );
        };
      })) as typeof window.createImageBitmap;
  });

  await choosePages(page, "photo", [{ text: "Sivu A" }]);

  await expect(page.getByRole("button", { name: "Muodosta resepti" })).toBeDisabled();
  await expect(page.locator("#status")).toHaveText("Luetaan kuvaa 1/1…");

  await page.evaluate(() => (window as unknown as { release: () => void }).release());

  await expect(page.locator("#chosen li")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Muodosta resepti" })).toBeEnabled();
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

  await page.getByRole("button", { name: "Muodosta resepti" }).click();
  await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toBeVisible({
    timeout: 15_000,
  });

  expect(calls[0]!.body.images).toHaveLength(2);
});

test("too many pages are refused before the model is called", async ({ page }) => {
  await page.goto("/intake");

  // Straight at the endpoint: the browser stops at the cap, but the cap that
  // matters is the one no browser can talk past.
  const response = await page.request.post("/api/intake/imports", {
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
    const response = await page.request.post("/api/intake/imports", { data });

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
  await page.route("**/api/intake/imports", (route) => {
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

test("an import survives leaving and opens later without a second model call", async ({
  page,
}) => {
  const id = "background-return";
  let starts = 0;
  await page.route("**/api/intake/imports", async (route) => {
    starts += 1;
    executeLocalSql(
      `INSERT INTO intake_job
        (id, household_id, created_by, status, source_route, source_text,
         created_at, updated_at)
       VALUES ('${id}', 1, 1, 'queued', 'pasted', 'Uunikaali',
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    );
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ id, status: "queued" }),
    });
  });

  await page.goto("/intake");
  await page.getByLabel("Liitä reseptin teksti").fill("Uunikaali");
  await page.getByRole("button", { name: "Muodosta resepti" }).click();
  await expect(page.getByText("Reseptiä käsitellään taustalla.")).toBeVisible();

  await page.goto("/recipes");
  executeLocalSql(
    `UPDATE intake_job
        SET status = 'ready', draft_json = '${JSON.stringify(DRAFT_FIXTURE).replaceAll("'", "''")}',
            updated_at = CURRENT_TIMESTAMP
      WHERE id = '${id}'`,
  );

  await page.goto("/intake");
  const completed = page.locator('[data-intake-job="background-return"]');
  await expect(completed.getByText("Valmis tarkistettavaksi")).toBeVisible();
  await completed.getByRole("link", { name: "Tarkista resepti" }).click();
  await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toBeVisible();
  await expect(page.locator(".review-title")).toHaveText(DRAFT_FIXTURE.title);
  expect(starts).toBe(1);
});

test("another household cannot see an import or its status", async ({ browser, page }) => {
  executeLocalSql(
    `INSERT INTO intake_job
      (id, household_id, created_by, status, source_route, source_text,
       draft_json, error_message, created_at, updated_at)
     VALUES ('private-import', 1, 1, 'failed', 'pasted', 'Uunikaali',
       NULL, 'Reseptin jäsennys ei onnistunut. Yritä uudelleen.',
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  );

  const neighbour = await browser.newContext();
  await neighbour.addCookies([sessionCookie(2)]);

  const review = await neighbour.request.get("/intake/imports/private-import/review");
  expect(review.status()).toBe(404);
  const status = await neighbour.request.get("/api/intake/imports/private-import");
  expect(status.status()).toBe(404);
  const retry = await neighbour.request.post("/intake/imports/private-import/retry");
  expect(retry.status()).toBe(404);
  await page.goto("/intake");
  await expect(page.locator('[data-intake-job="private-import"] .refused'))
    .toBeVisible();
  executeLocalSql("DELETE FROM intake_job WHERE id = 'private-import'");

  await neighbour.close();
});

test("pasted protocol words arrive whole in the review", async ({ page }) => {
  const pasted =
    "Uunikaali\n<<<intake:restart>>>\n<<<intake:complete>>>\n<<<intake:failed>>>";
  await stubStructuring(page, { ...DRAFT_FIXTURE, source_text: pasted });

  await page.goto("/intake");
  await page.getByLabel("Liitä reseptin teksti").fill(pasted);
  await page.getByRole("button", { name: "Muodosta resepti" }).click();

  await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toBeVisible();
  await expect(page.locator('input[name="sourceText"]')).toHaveValue(pasted);
  await expect(page.locator(".review-title")).toHaveText(DRAFT_FIXTURE.title);
});

test("a queued import is still visible after refresh", async ({ page }) => {
  executeLocalSql(
    `INSERT INTO intake_job
      (id, household_id, created_by, status, lease_id, source_route, source_text,
       created_at, updated_at)
     VALUES ('still-running', 1, 1, 'running', 'test-lease', 'pasted', 'Pöperö',
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  );

  await page.goto("/intake");
  await expect(page.getByText("Käsitellään taustalla")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Käsitellään taustalla")).toBeVisible();
  await expect(page.getByText("Pöperö")).toBeVisible();
});

test("a failed import keeps its source and offers an explicit retry", async ({
  page,
}) => {
  executeLocalSql(
    `INSERT INTO intake_job
      (id, household_id, created_by, status, source_route, source_text,
       error_message, created_at, updated_at)
     VALUES ('failed-import', 1, 1, 'failed', 'pasted',
       'Uunikaali\n½ dl öljyä', 'Reseptin jäsennys ei onnistunut. Yritä uudelleen.',
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  );

  await page.goto("/intake");
  await expect(page.locator(".refused")).toContainText("jäsennys ei onnistunut");
  await page.getByText("Alkuperäinen teksti").click();
  await expect(page.getByText("Uunikaali\n½ dl öljyä")).toBeVisible();
  await expect(page.getByRole("button", { name: "Yritä uudelleen" })).toBeVisible();
});

test("a failed structuring keeps what was typed", async ({ page }) => {
  await page.route("**/api/intake/imports", (route) =>
    route.fulfill({ status: 503, body: '{"error":"Kokeile myöhemmin."}' }),
  );

  await page.goto("/intake");
  await page.getByLabel("Liitä reseptin teksti").fill("Uunikaali\n½ dl öljyä");
  await page.getByRole("button", { name: "Muodosta resepti" }).click();

  await expect(page.locator("#status")).toHaveText(
    "Palvelin ei ottanut reseptiä vastaan. Yritä hetken kuluttua uudelleen.",
  );
  await expect(page.locator("#status")).not.toContainText("Kokeile myöhemmin");
  await expect(page.getByLabel("Liitä reseptin teksti")).toHaveValue(
    "Uunikaali\n½ dl öljyä",
  );
  // And it lets you try again rather than stranding you.
  await expect(page.getByRole("button", { name: "Muodosta resepti" })).toBeEnabled();
});

/**
 * Issue #222: a photographed import that dies in the browser used to leave no
 * trace anywhere — not a request, not a log line, not a row — so the only
 * evidence a later investigation had was the absence of evidence.
 */

/** Every failure report the island sends, in the order it sends them. */
async function captureFailureReports(
  page: Page,
): Promise<Array<Record<string, unknown>>> {
  const reports: Array<Record<string, unknown>> = [];
  await page.route("**/api/intake/failures", async (route) => {
    reports.push(
      JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>,
    );
    await route.continue();
  });
  return reports;
}

test("a request that never leaves is reported, and says so", async ({
  page,
}) => {
  const reports = await captureFailureReports(page);
  // An aborted request is what a dropped connection looks like to the island:
  // the fetch rejects and nothing about it ever reaches the Worker.
  await page.route("**/api/intake/imports", (route) => route.abort());

  await page.goto("/intake");
  await page.getByLabel("Liitä reseptin teksti").fill("Uunikaali");
  await page.getByRole("button", { name: "Muodosta resepti" }).click();

  // The wording is the browser's own, not the server's, so a household is not
  // told the server refused something it never saw.
  await expect(page.locator("#status")).toHaveText(
    "Reseptin lähetys ei onnistunut tällä laitteella. Tarkista verkkoyhteys ja yritä uudelleen.",
  );

  await expect.poll(() => reports.length).toBe(1);
  expect(reports[0]!["step"]).toBe("send");
  expect(reports[0]!["route"]).toBe("pasted");
  expect(reports[0]!["status"]).toBe(0);
  // The real reason, in English, on its way to the log rather than the screen.
  expect(String(reports[0]!["detail"])).not.toBe("");
  await expect(page.locator("#status")).not.toContainText(
    String(reports[0]!["detail"]),
  );
});

test("a Worker that answered is not reported as the browser giving up", async ({
  page,
}) => {
  const reports = await captureFailureReports(page);
  await page.route("**/api/intake/imports", (route) =>
    route.fulfill({ status: 503, body: '{"error":"Kokeile myöhemmin."}' }),
  );

  await page.goto("/intake");
  await page.getByLabel("Liitä reseptin teksti").fill("Uunikaali");
  await page.getByRole("button", { name: "Muodosta resepti" }).click();

  // The server's own wording, distinct from the browser's, is still shown.
  await expect(page.locator("#status")).toHaveText(
    "Palvelin ei ottanut reseptiä vastaan. Yritä hetken kuluttua uudelleen.",
  );

  // And nothing is reported at all. The request reached the Worker, so the
  // Worker is what has a record of it — a line saying the browser gave up
  // would be a false one, and `intake.client_failed` is exactly that claim.
  await page.waitForTimeout(500);
  expect(reports).toHaveLength(0);
});

test("a reply the browser cannot read is not reported either", async ({
  page,
}) => {
  const reports = await captureFailureReports(page);
  // A 202 whose body is not JSON: the request arrived and was accepted, and
  // only the reading of the answer failed. Still not the browser giving up.
  await page.route("**/api/intake/imports", (route) =>
    route.fulfill({
      status: 202,
      contentType: "application/json",
      body: "not json at all",
    }),
  );

  await page.goto("/intake");
  await page.getByLabel("Liitä reseptin teksti").fill("Uunikaali");
  await page.getByRole("button", { name: "Muodosta resepti" }).click();

  await expect(page.locator("#status")).toHaveText(
    "Palvelin ei ottanut reseptiä vastaan. Yritä hetken kuluttua uudelleen.",
  );
  await page.waitForTimeout(500);
  expect(reports).toHaveLength(0);
});

test("a photographed import reports the pages it was carrying", async ({
  page,
}) => {
  const reports = await captureFailureReports(page);
  await page.route("**/api/intake/imports", (route) => route.abort());

  await page.goto("/intake");
  await choosePages(page, "photo", [
    { text: "Sivu yksi" },
    { text: "Sivu kaksi" },
  ]);
  await page.getByRole("button", { name: "Muodosta resepti" }).click();

  await expect.poll(() => reports.length).toBe(1);
  expect(reports[0]!["step"]).toBe("send");
  expect(reports[0]!["route"]).toBe("photographed");
  expect(reports[0]!["pages"]).toBe(2);
  // The size of the import is the number #218 turned on, so a report that
  // names the step should carry it too.
  expect(Number(reports[0]!["bytes"])).toBeGreaterThan(0);
});

test("a page that cannot be read is reported before anything is sent", async ({
  page,
}) => {
  const reports = await captureFailureReports(page);

  await page.goto("/intake");
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([new Uint8Array([1, 2, 3, 4])], "sivu.png", {
        type: "image/png",
      }),
    );
    const input = document.getElementById("photo") as HTMLInputElement;
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await expect(page.locator("#status")).toContainText(
    "Yhtä kuvista ei voitu lukea",
  );

  await expect.poll(() => reports.length).toBe(1);
  expect(reports[0]!["step"]).toBe("shrink");
  expect(reports[0]!["pages"]).toBe(0);
});

test("the failure route takes anything and answers 204", async ({ page }) => {
  await page.goto("/intake");

  // Best-effort by construction: a report that is nonsense, or not JSON at
  // all, must not become a second thing that can fail an import.
  for (const body of [
    JSON.stringify({ step: "send", detail: "Failed to fetch" }),
    JSON.stringify({ step: "smuggled", bytes: "lots" }),
    // A step the island never reports, from something that is not the island.
    JSON.stringify({ step: "refused", status: 503 }),
    "not json at all",
    "",
  ]) {
    const response = await page.request.post("/api/intake/failures", {
      headers: { "Content-Type": "application/json" },
      data: body,
    });
    expect(response.status()).toBe(204);
  }
});

test("reporting a failure is closed to a signed-out browser", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const response = await context.request.post("/api/intake/failures", {
    headers: { "Content-Type": "application/json" },
    data: JSON.stringify({ step: "send" }),
  });
  expect(response.status()).toBe(401);
  await context.close();
});

async function pasteAndStructure(page: import("@playwright/test").Page) {
  await page.goto("/intake");
  await page.getByLabel("Liitä reseptin teksti").fill("Uunikaali");
  await page.getByRole("button", { name: "Muodosta resepti" }).click();
  await expect(page.getByRole("heading", { name: "Tarkista resepti" })).toBeVisible();
}

async function ingredientNames(page: import("@playwright/test").Page) {
  const response = await page.request.get("/api/ingredients");
  const body = (await response.json()) as { ingredients: { name: string }[] };
  return body.ingredients.map((i) => i.name);
}
