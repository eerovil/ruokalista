/**
 * One draft shaped like one the model really returned, with a line of each
 * awkward shape in it: a plain amount, a range, a second measurement, a line
 * the source gave no amount for, and one the model could not match.
 *
 * It has two jobs, and they are the same job. The browser suite answers
 * `/api/intake/structure` from it, so no test ever calls Anthropic. And a
 * development server offers it on the intake screen, so the review, the editor
 * and the save can be walked through by hand for nothing — see `isLocalOrigin`
 * in `src/public-origin.ts` for why that cannot happen in production.
 *
 * Kept here rather than in `tests/` so there is one fixture and not two that
 * quietly drift apart.
 */
export const SAMPLE_DRAFT = {
  title: "Uunikaali",
  yield_portions: 4,
  source_text:
    "Uunikaali\n4 annosta\n½ dl öljyä\n1–1 ja ½ l vettä\n½ (500 g) valkokaali\nhieman sitruunaruohoa\n2 rkl hunajaa",
  steps: [
    {
      text: "Kuullota kaali öljyssä.",
      section: null,
      phase: null,
      // Issue #120: both words name a line below, in the wording the step used
      // — "kaali" for valkokaali, "öljyssä" for öljy. No amount here: the
      // ingredient line stays the only place one lives.
      ingredient_refs: [
        { line: 2, matched_text: "kaali", approx_position: 10 },
        { line: 0, matched_text: "öljyssä", approx_position: 16 },
      ],
    },
    {
      text: "Lisää vesi ja hauduta uunissa.",
      section: null,
      phase: null,
      ingredient_refs: [
        { line: 1, matched_text: "vesi", approx_position: 6 },
      ],
    },
  ],
  lines: [
    {
      quantity: 0.5, quantity_max: null, unit: "dl",
      alt_quantity: null, alt_unit: null,
      ingredient_id: 1, ingredient_name: "öljy", source_line: "½ dl öljyä",
      section: null, phase: null, note: null,
    },
    {
      quantity: 1, quantity_max: 1.5, unit: "l",
      alt_quantity: null, alt_unit: null,
      ingredient_id: 2, ingredient_name: "vesi", source_line: "1–1 ja ½ l vettä",
      section: null, phase: null, note: null,
    },
    {
      quantity: 0.5, quantity_max: null, unit: null,
      alt_quantity: 500, alt_unit: "g",
      ingredient_id: 3, ingredient_name: "valkokaali",
      source_line: "½ (500 g) valkokaali",
      section: null, phase: null, note: null,
    },
    {
      quantity: null, quantity_max: null, unit: null,
      alt_quantity: null, alt_unit: null,
      ingredient_id: 4, ingredient_name: "sitruunaruoho",
      source_line: "hieman sitruunaruohoa",
      section: null,
      phase: null,
      // The model saying so itself is what lets the screen be a read view.
      note: "Määrää ei kerrottu, vain \"hieman\".",
    },
    {
      quantity: 2, quantity_max: null, unit: "rkl",
      alt_quantity: null, alt_unit: null,
      // Unmatched on purpose: this is the line the gate must stop.
      ingredient_id: null, ingredient_name: "hunaja",
      source_line: "2 rkl hunajaa",
      section: null, phase: null, note: null,
    },
  ],
};
