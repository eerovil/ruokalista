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
