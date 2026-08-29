import { expect, test, type Page } from "@playwright/test";

import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * Editing a saved recipe with a sentence (#208).
 *
 * The model call is the one part of this that costs money, and it is
 * deliberately not the part being tested: `POST /recipes/:id/prompt/review`
 * takes a proposal already made, exactly as `/intake/correct` does, so
 * everything after the model — the wire check, the review, the corrections a
 * member makes by hand and the ordinary save — runs here for nothing.
 *
 * Recipe 1 is Kaalilaatikko: öljy, vesi, valkokaali, sitruunaruoho, and three
 * steps. Every case below is really "did anything move that the prompt did not
 * ask about".
 */

test.beforeEach(async ({ context }) => {
  reseed();
  await context.addCookies([sessionCookie(1)]);
});

interface WireLine {
  quantity: number | null;
  quantity_max: number | null;
  unit: string | null;
  alt_quantity: number | null;
  alt_unit: string | null;
  ingredient_id: number | null;
  ingredient_name: string;
  source_line: string;
  section: string | null;
  phase: null;
  alternative_group: number | null;
  note: string | null;
}

function existing(
  id: number,
  name: string,
  quantity: number | null,
  unit: string | null,
  sourceLine: string,
  over: Partial<WireLine> = {},
): WireLine {
  return {
    quantity,
    quantity_max: null,
    unit,
    alt_quantity: null,
    alt_unit: null,
    ingredient_id: id,
    ingredient_name: name,
    source_line: sourceLine,
    section: null,
    phase: null,
    alternative_group: null,
    note: null,
    ...over,
  };
}

/** Kaalilaatikko exactly as it is stored, which is what an edit starts from. */
function kaalilaatikko() {
  return {
    title: "Kaalilaatikko",
    yield_portions: 4,
    source_text: "",
    steps: [
      { text: "Kuullota kaali öljyssä.", section: null, phase: null, ingredient_refs: [] },
      { text: "Lisää vesi ja hauduta.", section: null, phase: null, ingredient_refs: [] },
      {
        text: "Mausta sitruunaruoholla ja tarjoa.",
        section: null,
        phase: null,
        ingredient_refs: [],
      },
    ],
    lines: [
      existing(1, "öljy", 0.5, "dl", "½ dl öljyä"),
      existing(2, "vesi", 1, "l", "1–1 ja ½ l vettä", { quantity_max: 1.5 }),
      existing(3, "valkokaali", 0.5, "kpl", "½ (500 g) valkokaali", {
        alt_quantity: 500,
        alt_unit: "g",
      }),
      existing(4, "sitruunaruoho", null, null, "hieman sitruunaruohoa"),
    ],
  };
}

/**
 * Hand a proposal to the review screen the way the model's own answer reaches
 * it. A form built in the page rather than a bare request, so what comes back
 * is the rendered screen a member would be looking at.
 */
async function review(
  page: Page,
  recipeId: number,
  draft: unknown,
  instruction: string,
): Promise<void> {
  await page.goto(`/recipes/${recipeId}/prompt`);
  await page.evaluate(
    ({ action, draft, instruction }) => {
      const form = document.createElement("form");
      form.method = "post";
      form.action = action;
      for (const [name, value] of [
        ["draft", draft],
        ["instruction", instruction],
      ]) {
        const field = document.createElement("input");
        field.type = "hidden";
        field.name = name!;
        field.value = value!;
        form.appendChild(field);
      }
      document.body.appendChild(form);
      form.submit();
    },
    {
      action: `/recipes/${recipeId}/prompt/review`,
      draft: JSON.stringify(draft),
      instruction,
    },
  );
  await page.waitForURL(/\/prompt\/review$/);
}

function save(page: Page) {
  return page.locator(".editor-actions button").click();
}

test("the recipe offers a prompt edit, and it asks for one sentence", async ({
  page,
}) => {
  await page.goto("/recipes/1");
  await page.getByRole("link", { name: "Muokkaa promptilla" }).click();

  await expect(page).toHaveURL(/\/recipes\/1\/prompt$/);
  await expect(page.locator("#instruction")).toBeVisible();
  await expect(page.getByRole("button", { name: "Luo ehdotus" })).toBeVisible();
});

test("a proposal that adds an ingredient opens in the editor and saves", async ({
  page,
}) => {
  const draft = kaalilaatikko();
  draft.lines.push(
    existing(null, "kermaviili", 2, "dl", "2 dl kermaviiliä", {
      note: "Lisätty pyynnön mukaan.",
    }),
  );

  await review(page, 1, draft, "Lisää kastikkeeseen puuttuvat ainekset.");

  await expect(
    page.getByRole("heading", { name: "Ehdotus tarkistettavaksi" }),
  ).toBeVisible();
  await expect(page.locator(".prompt-changes")).toContainText(
    "Lisätty — Aines: kermaviili",
  );
  // Five rows: the four that were there and the one being proposed.
  await expect(page.locator(".line")).toHaveCount(5);

  await save(page);

  await expect(page).toHaveURL(/\/recipes\/1$/);
  const lines = page.locator(".lines li");
  await expect(lines).toContainText(["öljy", "vesi", "valkokaali", "sitruunaruoho", "kermaviili"]);
});

test("a side dish arrives as this recipe's own lines and steps", async ({
  page,
}) => {
  const draft = kaalilaatikko();
  draft.lines.push(
    existing(null, "jäävuorisalaatti", 1, "kpl", "1 kpl jäävuorisalaattia"),
  );
  draft.steps.push({
    text: "Revi salaatti lisukkeeksi ja tarjoa laatikon kanssa.",
    section: null,
    phase: null,
    ingredient_refs: [],
  });

  await review(page, 1, draft, "Lisää salaatti tämän ruoan lisukkeeksi.");

  await expect(page.locator(".prompt-changes")).toContainText(
    "Lisätty — Aines: jäävuorisalaatti",
  );
  await expect(page.locator(".prompt-changes")).toContainText(
    "Lisätty — 1 valmistusvaihe",
  );

  await save(page);

  await expect(page).toHaveURL(/\/recipes\/1$/);
  await expect(page.locator(".lines li")).toContainText([
    "öljy",
    "vesi",
    "valkokaali",
    "sitruunaruoho",
    "jäävuorisalaatti",
  ]);
  await expect(page.locator(".steps li")).toContainText([
    "Kuullota kaali öljyssä.",
    "Lisää vesi ja hauduta.",
    "Mausta sitruunaruoholla ja tarjoa.",
    "Revi salaatti lisukkeeksi ja tarjoa laatikon kanssa.",
  ]);
});

test("everything the prompt did not ask about survives the save", async ({
  page,
}) => {
  const draft = kaalilaatikko();
  draft.steps.push({
    text: "Ripottele pinnalle korppujauhoja ennen paistamista.",
    section: null,
    phase: null,
    ingredient_refs: [],
  });

  await review(page, 1, draft, "Lisää puuttuva valmistusohje.");
  // The only thing that moved is the step, and the screen says so.
  await expect(page.locator(".prompt-changes li")).toHaveCount(1);
  await save(page);

  await expect(page.getByRole("heading", { name: "Kaalilaatikko" })).toBeVisible();
  await expect(page.locator(".lines li")).toHaveCount(4);
  // The range and the second measurement round-trip, not just the names.
  await expect(page.locator(".lines li").nth(1)).toContainText("1–1½ l");
  await expect(page.locator(".lines li").nth(2)).toContainText("500 g");
  // Source text is the record of what arrived, and a prompt never touches it.
  await expect(page.locator(".source-text")).toContainText("½ dl öljyä");
});

test("the proposal can still be corrected by hand before it is saved", async ({
  page,
}) => {
  const draft = kaalilaatikko();
  draft.lines.push(existing(null, "kermaviili", 2, "dl", "2 dl kermaviiliä"));

  await review(page, 1, draft, "Lisää kastikkeeseen puuttuvat ainekset.");

  // The model proposed two decilitres; the cook says one.
  await page.locator(".line").nth(4).locator("input[name$=quantity]").fill("1");
  await save(page);

  await expect(page.locator(".lines li").nth(4)).toContainText("1 dl");
});

test("nothing is written until the member saves", async ({ page }) => {
  const draft = kaalilaatikko();
  draft.title = "Aivan toinen ruoka";

  await review(page, 1, draft, "Nimeä resepti uudelleen.");
  await expect(page.locator(".prompt-changes")).toContainText("Nimi:");

  // Walk away instead of saving. The recipe is exactly as it was.
  await page.goto("/recipes/1");
  await expect(page.getByRole("heading", { name: "Kaalilaatikko" })).toBeVisible();
});

test("a proposal that is not a valid draft never reaches a form", async ({
  page,
}) => {
  const draft = kaalilaatikko() as unknown as { lines: unknown[] };
  // An amount that is not a number: the wire check refuses it, and the member
  // gets Finnish rather than a half-built editor.
  draft.lines = [{ ...kaalilaatikko().lines[0], quantity: "puoli" }];

  await review(page, 1, draft, "Lisää lisuke.");

  await expect(page.locator(".refused")).toBeVisible();
  await expect(page.locator(".edit-lines")).toHaveCount(0);
  await expect(page.locator("#instruction")).toHaveValue("Lisää lisuke.");
});

test("another household's shared recipe cannot be prompt-edited", async ({
  page,
}) => {
  // Recipe 6 is Naapuri's, published, so household 1 can read it — and a
  // prompt is a way of writing, which the publish never opened.
  await page.goto("/recipes/6");
  await expect(page.getByRole("link", { name: "Muokkaa promptilla" })).toHaveCount(0);

  expect((await page.goto("/recipes/6/prompt"))?.status()).toBe(404);
  expect(
    (await page.request.post("/recipes/6/prompt/review", {
      form: { draft: JSON.stringify(kaalilaatikko()), instruction: "Lisää lisuke." },
    })).status(),
  ).toBe(404);
});
