import type { Page } from "@playwright/test";

/**
 * A draft shaped like one the model really returned, kept as a fixture so the
 * browser tests never call Anthropic. One line of each awkward shape, plus one
 * the model could not match — which is what makes the approval gate testable.
 */
export const DRAFT_FIXTURE = {
  title: "Uunikaali",
  yield_portions: 4,
  source_text:
    "Uunikaali\n4 annosta\n½ dl öljyä\n1–1 ja ½ l vettä\n½ (500 g) valkokaali\nhieman sitruunaruohoa\n2 rkl hunajaa",
  steps: [
    { text: "Kuullota kaali öljyssä.", section: null },
    { text: "Lisää vesi ja hauduta uunissa.", section: null },
  ],
  lines: [
    {
      quantity: 0.5, quantity_max: null, unit: "dl",
      alt_quantity: null, alt_unit: null,
      ingredient_id: 1, ingredient_name: "öljy", source_line: "½ dl öljyä",
      section: null, note: null,
    },
    {
      quantity: 1, quantity_max: 1.5, unit: "l",
      alt_quantity: null, alt_unit: null,
      ingredient_id: 2, ingredient_name: "vesi", source_line: "1–1 ja ½ l vettä",
      section: null, note: null,
    },
    {
      quantity: 0.5, quantity_max: null, unit: null,
      alt_quantity: 500, alt_unit: "g",
      ingredient_id: 3, ingredient_name: "valkokaali",
      source_line: "½ (500 g) valkokaali",
      section: null, note: null,
    },
    {
      quantity: null, quantity_max: null, unit: null,
      alt_quantity: null, alt_unit: null,
      ingredient_id: 4, ingredient_name: "sitruunaruoho",
      source_line: "hieman sitruunaruohoa",
      section: null,
      // The model saying so itself is what lets the screen be a read view.
      note: "Määrää ei kerrottu, vain \"hieman\".",
    },
    {
      quantity: 2, quantity_max: null, unit: "rkl",
      alt_quantity: null, alt_unit: null,
      // Unmatched on purpose: this is the line the gate must stop.
      ingredient_id: null, ingredient_name: "hunaja",
      source_line: "2 rkl hunajaa",
      section: null, note: null,
    },
  ],
};

/** What the streaming endpoint was asked for, once a stub has answered it. */
export interface StubbedCall {
  body: { sourceText?: string; image?: string; mediaType?: string };
}

/**
 * Answer POST /api/intake/structure from the fixture instead of the model.
 * Returns a record of what the browser actually sent, which is how the camera
 * downscale gets checked without a real photograph reaching anything.
 */
export async function stubStructuring(
  page: Page,
  draft: unknown = DRAFT_FIXTURE,
): Promise<StubbedCall[]> {
  const calls: StubbedCall[] = [];

  await page.route("**/api/intake/structure", async (route) => {
    calls.push({ body: JSON.parse(route.request().postData() ?? "{}") });

    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(draft),
    });
  });

  return calls;
}
