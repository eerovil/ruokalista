import type { Page } from "@playwright/test";

/**
 * The fixture lives in `src/sample-draft.ts` because the development server
 * serves it too — one draft, so the thing tested by hand and the thing tested
 * by CI cannot drift apart.
 */
import { SAMPLE_DRAFT } from "../../src/sample-draft.ts";

export { SAMPLE_DRAFT as DRAFT_FIXTURE };
const DRAFT_FIXTURE = SAMPLE_DRAFT;

/**
 * One ingredient on several lines: two distinct amounts, one blank amount and
 * one repeated amount. A step mention must reveal `2 rkl / 1 dl` — every useful
 * value, with blanks dropped and repeats collapsed.
 */
export const DUPLICATE_AMOUNT_DRAFT = {
  title: "Perunasalaatti",
  yield_portions: 4,
  source_text:
    "Perunasalaatti\n4 annosta\n2 rkl öljyä\n500 g valkokaalia\nöljyä vuokaan\n2 rkl öljyä\n1 dl öljyä",
  steps: [
    {
      text: "Paista kaali öljyssä.",
      section: null,
      phase: null,
      ingredient_refs: [{ line: 0, matched_text: "öljyssä", approx_position: 13 }],
    },
    {
      text: "Sekoita loppu öljy joukkoon.",
      section: null,
      phase: null,
      ingredient_refs: [{ line: 4, matched_text: "öljy", approx_position: 14 }],
    },
  ],
  lines: [
    {
      quantity: 2, quantity_max: null, unit: "rkl",
      alt_quantity: null, alt_unit: null,
      ingredient_id: 1, ingredient_name: "öljy", source_line: "2 rkl öljyä",
      section: null, phase: null, note: null,
    },
    {
      quantity: 500, quantity_max: null, unit: "g",
      alt_quantity: null, alt_unit: null,
      ingredient_id: 3, ingredient_name: "valkokaali",
      source_line: "500 g valkokaalia",
      section: null, phase: null, note: null,
    },
    {
      quantity: null, quantity_max: null, unit: null,
      alt_quantity: null, alt_unit: null,
      ingredient_id: 1, ingredient_name: "öljy", source_line: "öljyä vuokaan",
      section: null, phase: null, note: null,
    },
    {
      quantity: 2, quantity_max: null, unit: "rkl",
      alt_quantity: null, alt_unit: null,
      ingredient_id: 1, ingredient_name: "öljy", source_line: "2 rkl öljyä",
      section: null, phase: null, note: null,
    },
    {
      quantity: 1, quantity_max: null, unit: "dl",
      alt_quantity: null, alt_unit: null,
      ingredient_id: 1, ingredient_name: "öljy", source_line: "1 dl öljyä",
      section: null, phase: null, note: null,
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

/**
 * Öljy on two lines with distinguishable amounts, and a step mentioning it.
 * The editor anchors the saved mention to the *first* öljy row, so repointing
 * only that row is the case where the mention must survive on the other one —
 * "2 rkl" leaves with the row it belonged to, "1 dl" stays.
 */
export const ANCHOR_REPOINT_DRAFT = {
  title: "Paistetut perunat",
  yield_portions: 4,
  source_text:
    "Paistetut perunat\n4 annosta\n2 rkl öljyä\n500 g valkokaalia\n1 dl öljyä",
  steps: [
    {
      text: "Paista kaikki öljyssä.",
      section: null,
      phase: null,
      ingredient_refs: [
        { line: 0, matched_text: "öljyssä", approx_position: 14 },
      ],
    },
  ],
  lines: [
    {
      quantity: 2, quantity_max: null, unit: "rkl",
      alt_quantity: null, alt_unit: null,
      ingredient_id: 1, ingredient_name: "öljy", source_line: "2 rkl öljyä",
      section: null, phase: null, note: null,
    },
    {
      quantity: 500, quantity_max: null, unit: "g",
      alt_quantity: null, alt_unit: null,
      ingredient_id: 3, ingredient_name: "valkokaali",
      source_line: "500 g valkokaalia",
      section: null, phase: null, note: null,
    },
    {
      quantity: 1, quantity_max: null, unit: "dl",
      alt_quantity: null, alt_unit: null,
      ingredient_id: 1, ingredient_name: "öljy", source_line: "1 dl öljyä",
      section: null, phase: null, note: null,
    },
  ],
};

/**
 * Three lines, and a step mentioning the middle one. Removing the first line on
 * the review screen closes the gap in what gets saved, so a mention that points
 * at a line by its place in that list would land on the third — the wrong
 * ingredient, with a real amount behind it.
 */
export const REMOVED_LINE_DRAFT = {
  title: "Haudutettu kaali",
  yield_portions: 4,
  source_text:
    "Haudutettu kaali\n4 annosta\n2 rkl öljyä\n500 g valkokaalia\n1 l vettä",
  steps: [
    {
      text: "Kuullota kaali pannulla.",
      section: null,
      phase: null,
      ingredient_refs: [
        { line: 1, matched_text: "kaali", approx_position: 9 },
      ],
    },
  ],
  lines: [
    {
      quantity: 2, quantity_max: null, unit: "rkl",
      alt_quantity: null, alt_unit: null,
      ingredient_id: 1, ingredient_name: "öljy", source_line: "2 rkl öljyä",
      section: null, phase: null, note: null,
    },
    {
      quantity: 500, quantity_max: null, unit: "g",
      alt_quantity: null, alt_unit: null,
      ingredient_id: 3, ingredient_name: "valkokaali",
      source_line: "500 g valkokaalia",
      section: null, phase: null, note: null,
    },
    {
      quantity: 1, quantity_max: null, unit: "l",
      alt_quantity: null, alt_unit: null,
      ingredient_id: 2, ingredient_name: "vesi", source_line: "1 l vettä",
      section: null, phase: null, note: null,
    },
  ],
};
