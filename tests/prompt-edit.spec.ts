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
  mode: "extend" | "replace" = "extend",
): Promise<void> {
  await page.goto(`/recipes/${recipeId}/prompt`);
  await page.evaluate(
    ({ action, draft, instruction, mode }) => {
      const form = document.createElement("form");
      form.method = "post";
      form.action = action;
      for (const [name, value] of [
        ["draft", draft],
        ["instruction", instruction],
        ["mode", mode],
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
      mode,
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

  // The mode is chosen before the request is written, and it is a real control
  // rather than something read out of the wording (#208).
  await expect(page.getByRole("radio", { name: /Täydennä nykyistä/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: /Korvaa resepti/ })).not.toBeChecked();
});

test("a request with no mode is refused rather than answered by guessing", async ({
  page,
}) => {
  const refused = await page.request.post("/recipes/1/prompt/review", {
    form: {
      draft: JSON.stringify(kaalilaatikko()),
      instruction: "Tee tästä parempi kokonainen resepti.",
    },
  });

  expect(refused.status()).toBe(400);
  expect(await refused.text()).toContain(
    "Valitse, täydennetäänkö nykyistä vai korvataanko se.",
  );
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
  await expect(page.locator(".prompt-proposal")).toContainText("Täydennä nykyistä");
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

/**
 * Recipe 3 is Lasagne, written in named parts: Jauhelihakastike (400 g
 * jauhelihaa, two steps) and Juustokastike (5 dl maitoa, 2 dl juustoa, one
 * step), with the dish itself owning the lasagne sheets and the assembly.
 *
 * A part is a recipe row of its own (ADR-0002), and the draft format says which
 * row a line belongs to with `section` — so the whole dish goes to the model
 * and comes back as one document. These are the cases #208 names when it asks
 * for "lisää kastikkeeseen puuttuvat ainekset".
 */
function lasagne() {
  return {
    title: "Lasagne",
    yield_portions: 6,
    source_text: "",
    steps: [
      { text: "Voitele vuoka.", section: null, phase: null, ingredient_refs: [] },
      {
        text: "Lämmitä uuni 200 asteeseen.",
        section: null,
        phase: "before_parts",
        ingredient_refs: [],
      },
      {
        text: "Kokoa vuokaan ja paista 40 minuuttia.",
        section: null,
        phase: "after_parts",
        ingredient_refs: [],
      },
      {
        text: "Ruskista jauheliha.",
        section: "Jauhelihakastike",
        phase: null,
        ingredient_refs: [],
      },
      {
        text: "Anna jauhelihan hautua hetki.",
        section: "Jauhelihakastike",
        phase: null,
        ingredient_refs: [],
      },
      {
        text: "Kuumenna maito ja sulata juusto joukkoon.",
        section: "Juustokastike",
        phase: null,
        ingredient_refs: [],
      },
    ],
    lines: [
      existing(10, "lasagnelevy", 12, "kpl", "12 lasagnelevyä", {
        phase: "after_parts" as unknown as null,
      }),
      existing(7, "jauheliha", 400, "g", "400 g jauhelihaa", {
        section: "Jauhelihakastike",
      }),
      existing(9, "maito", 5, "dl", "5 dl maitoa", { section: "Juustokastike" }),
      existing(8, "juusto", 2, "dl", "2 dl juustoa", { section: "Juustokastike" }),
    ],
  };
}

test("missing sauce ingredients land on the sauce, not on the dish", async ({
  page,
}) => {
  const draft = lasagne();
  // What "lisää kastikkeeseen puuttuvat ainekset" means for a juustokastike
  // that has milk and cheese but no butter, flour or salt.
  draft.lines.push(
    existing(null, "voi", 50, "g", "50 g voita", { section: "Juustokastike" }),
    existing(null, "vehnäjauho", 3, "rkl", "3 rkl vehnäjauhoja", {
      section: "Juustokastike",
    }),
  );
  draft.steps.push({
    text: "Sulata voi ja sekoita joukkoon vehnäjauhot.",
    section: "Juustokastike",
    phase: null,
    ingredient_refs: [],
  });

  await review(page, 3, draft, "Lisää kastikkeeseen puuttuvat ainekset.");

  // The review names the part the change lands in, so it cannot be mistaken
  // for a change to the dish.
  await expect(page.locator(".prompt-changes")).toContainText(
    "Lisätty — Juustokastike: Aines: voi",
  );
  await expect(page.locator(".prompt-changes")).toContainText(
    "Lisätty — Juustokastike: Aines: vehnäjauho",
  );

  await save(page);
  await expect(page).toHaveURL(/\/recipes\/3$/);

  // The sauce's own recipe row has them, and its old contents are still there.
  await page.goto("/recipes/5");
  await expect(page.locator(".lines li")).toContainText([
    "maito",
    "juusto",
    "voi",
    "vehnäjauho",
  ]);
  await expect(page.locator(".steps li")).toContainText([
    "Kuumenna maito ja sulata juusto joukkoon.",
    "Sulata voi ja sekoita joukkoon vehnäjauhot.",
  ]);

  // And nothing leaked onto the dish or the other part.
  await page.goto("/recipes/4");
  await expect(page.locator(".lines li")).toHaveCount(1);

  await page.goto("/recipes/3");
  const parts = page.locator(".part");
  await expect(parts).toHaveCount(2);
  await expect(parts.nth(1).locator("h2")).toHaveText("Juustokastike");
  await expect(parts.nth(1)).toContainText("voi");
  await expect(parts.nth(0)).not.toContainText("voi");
});

test("a part edit does not make a second recipe for the same part", async ({
  page,
}) => {
  const draft = lasagne();
  draft.lines.push(
    existing(null, "muskottipähkinä", null, null, "ripaus muskottipähkinää", {
      section: "Juustokastike",
    }),
  );

  await review(page, 3, draft, "Lisää kastikkeeseen ripaus muskottia.");
  await save(page);

  await page.goto("/recipes/3");
  // Still exactly two parts, and the sauce is still recipe 5.
  await expect(page.locator(".part")).toHaveCount(2);
  await page.goto("/recipes/5");
  await expect(page.getByRole("heading", { name: "Juustokastike" })).toBeVisible();
});

test("replace mode rewrites the recipe in place, into the same record", async ({
  page,
}) => {
  // Nothing of the old recipe kept except the dish it is: a wholly rewritten
  // Kaalilaatikko, which is what "tee tästä parempi kokonainen resepti" asks
  // for. It is still recipe 1 afterwards.
  const rewritten = {
    title: "Uunikaalilaatikko",
    yield_portions: 6,
    source_text: "",
    steps: [
      { text: "Lämmitä uuni 175 asteeseen.", section: null, phase: null, ingredient_refs: [] },
      { text: "Suikaloi kaali ja kuullota se öljyssä.", section: null, phase: null, ingredient_refs: [] },
      { text: "Lisää riisi, vesi ja siirappi ja hauduta.", section: null, phase: null, ingredient_refs: [] },
      { text: "Paista vuoassa tunti.", section: null, phase: null, ingredient_refs: [] },
    ],
    lines: [
      existing(3, "valkokaali", 1, "kpl", "1 kpl valkokaalia"),
      existing(1, "öljy", 2, "rkl", "2 rkl öljyä"),
      existing(2, "vesi", 5, "dl", "5 dl vettä"),
      existing(null, "riisi", 2, "dl", "2 dl riisiä"),
      existing(null, "siirappi", 2, "rkl", "2 rkl siirappia"),
    ],
  };

  await review(page, 1, rewritten, "Tee tästä parempi kokonainen resepti.", "replace");

  await expect(page.locator(".prompt-proposal")).toContainText("Korvaa resepti");
  // The whole result is shown, so unintended changes can be seen too — the
  // dropped ingredient is named rather than silently gone.
  await expect(page.locator(".prompt-changes")).toContainText(
    "Muutettu — Nimi: Kaalilaatikko → Uunikaalilaatikko",
  );
  await expect(page.locator(".prompt-changes")).toContainText("Lisätty — Aines: riisi");
  await expect(page.locator(".prompt-changes")).toContainText(
    "Poistettu — Aines: sitruunaruoho",
  );

  await save(page);

  // Same recipe, new contents. No second record: the list still has one.
  await expect(page).toHaveURL(/\/recipes\/1$/);
  await expect(page.getByRole("heading", { name: "Uunikaalilaatikko" })).toBeVisible();
  await expect(page.locator(".lines li")).toHaveCount(5);
  await expect(page.locator(".lines li")).toContainText([
    "valkokaali",
    "öljy",
    "vesi",
    "riisi",
    "siirappi",
  ]);
  await expect(page.locator(".steps li")).toHaveCount(4);
  // Source text is the record of what arrived, and even a replace leaves it.
  await expect(page.locator(".source-text")).toContainText("½ dl öljyä");

  await page.goto("/recipes");
  await expect(page.getByRole("link", { name: /Kaalilaatikko/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Uunikaalilaatikko/ })).toHaveCount(1);
});

test("a part the replacement stops naming is kept, not destroyed", async ({
  page,
}) => {
  // A rewrite that folds the lasagne's parts back into the dish. The parts are
  // recipe rows somebody may have on a menu, so they stay — and the review says
  // so rather than leaving it to be discovered.
  const flattened = {
    title: "Lasagne",
    yield_portions: 6,
    source_text: "",
    steps: [
      { text: "Ruskista jauheliha.", section: null, phase: null, ingredient_refs: [] },
      { text: "Kuumenna maito ja sulata juusto.", section: null, phase: null, ingredient_refs: [] },
      { text: "Kokoa ja paista.", section: null, phase: null, ingredient_refs: [] },
    ],
    lines: [
      existing(10, "lasagnelevy", 12, "kpl", "12 lasagnelevyä"),
      existing(7, "jauheliha", 400, "g", "400 g jauhelihaa"),
      existing(9, "maito", 5, "dl", "5 dl maitoa"),
      existing(8, "juusto", 2, "dl", "2 dl juustoa"),
    ],
  };

  await review(page, 3, flattened, "Tee tästä parempi kokonainen resepti.", "replace");

  await expect(page.locator(".prompt-changes")).toContainText(
    'Säilyy — Osa "Jauhelihakastike" jää ennalleen omaksi reseptikseen',
  );

  await save(page);

  // The sauce is untouched, with its own ingredients still on it.
  await page.goto("/recipes/5");
  await expect(page.locator(".lines li")).toContainText(["maito", "juusto"]);
});
