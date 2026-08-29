import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

/**
 * The fixture lives in `src/sample-draft.ts` because the development server
 * serves it too — one draft, so the thing tested by hand and the thing tested
 * by CI cannot drift apart.
 */
import { SAMPLE_DRAFT } from "../../src/sample-draft.ts";
import { executeLocalSql, putLocalObject } from "./seed";

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

/** What the queued intake endpoint was asked for, once a stub has answered it. */
export interface StubbedCall {
  body: {
    sourceText?: string;
    image?: string;
    mediaType?: string;
    images?: Array<{ image?: string; mediaType?: string }>;
    url?: string;
    recipeId?: string;
    mode?: "extend" | "replace";
  };
}

/**
 * Persist a ready fixture when the browser starts an import. The request never
 * reaches the Queue or Anthropic, but the return-to-review route reads the same
 * D1 row production does.
 */
export async function stubStructuring(
  page: Page,
  draft: unknown = DRAFT_FIXTURE,
  options: StubOptions = {},
): Promise<StubbedCall[]> {
  const calls: StubbedCall[] = [];

  await page.route("**/api/intake/imports", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as StubbedCall["body"];
    calls.push({ body });

    const id = `test-${randomUUID()}`;
    const photographed = Array.isArray(body.images) && body.images.length > 0;
    const linked = !photographed && typeof body.url === "string" && body.url !== "";
    // A linked job's text is what the consumer read off the page, so the
    // fixture stands in for the page rather than for anything the browser sent.
    const sourceText = linked
      ? options.linkedText ?? ""
      : typeof body.sourceText === "string"
        ? body.sourceText
        : "";
    const imageRefs = photographed
      ? body.images!.map((image, index) => ({
          key: `test/${id}/${index + 1}`,
          mediaType: image.mediaType ?? "image/jpeg",
        }))
      : null;

    // The picture the consumer would have found on the page and stored (#205),
    // in the bucket under the job's own key before the review screen asks for it.
    const pageImageKey = linked && options.linkedImage !== undefined
      ? `intake/${id}/found.png`
      : null;
    if (pageImageKey !== null) {
      putLocalObject(pageImageKey, options.linkedImage!, "image/png");
    }
    const route_ = photographed ? "photographed" : linked ? "linked" : "pasted";

    if (options.failWith !== undefined) {
      executeLocalSql(
        `INSERT INTO intake_job
          (id, household_id, created_by, status, source_route, source_text,
           source_url, image_refs, page_image_key, page_image_type,
           error_message, created_at, updated_at)
         VALUES (${sql(id)}, 1, 1, 'failed', ${sql(route_)},
           ${linked ? "NULL" : sql(sourceText)},
           ${linked ? sql(options.linkedUrl ?? body.url!) : "NULL"},
           ${imageRefs === null ? "NULL" : sql(JSON.stringify(imageRefs))},
           ${pageImageKey === null ? "NULL" : sql(pageImageKey)},
           ${pageImageKey === null ? "NULL" : "'image/png'"},
           ${sql(options.failWith)}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      );
    } else {
      executeLocalSql(
        `INSERT INTO intake_job
          (id, household_id, created_by, status, source_route, source_text,
           source_url, image_refs, page_image_key, page_image_type,
           draft_json, created_at, updated_at)
         VALUES (${sql(id)}, 1, 1, 'ready', ${sql(route_)},
           ${photographed ? "NULL" : sql(sourceText)},
           ${linked ? sql(options.linkedUrl ?? body.url!) : "NULL"},
           ${imageRefs === null ? "NULL" : sql(JSON.stringify(imageRefs))},
           ${pageImageKey === null ? "NULL" : sql(pageImageKey)},
           ${pageImageKey === null ? "NULL" : "'image/png'"},
           ${sql(JSON.stringify(draft))}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      );
      if (body.recipeId !== undefined && options.targetRecipe !== undefined) {
        executeLocalSql(
          `UPDATE intake_job
              SET target_recipe_id = ${Number(body.recipeId)},
                  target_revision = ${Number((options.targetRecipe as { revision?: number }).revision ?? 0)},
                  edit_mode = ${sql(body.mode ?? "extend")},
                  target_recipe_json = ${sql(JSON.stringify(options.targetRecipe))}
            WHERE id = ${sql(id)}`,
        );
      }
    }

    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ id, status: "queued" }),
    });
  });

  return calls;
}

/**
 * How the stubbed queue consumer should have finished (#192).
 *
 * A browser run has no network and no queue, so these stand in for what the
 * consumer would have written: the text it read off a linked page, the address
 * it finally read, or the Finnish it failed with. The fetch itself is covered
 * without a browser by `dev/check-recipe-fetch.ts`, and the job half by
 * `dev/check-intake-jobs.ts`.
 */
export interface StubOptions {
  /** The text the consumer read off the page, for a linked import. */
  linkedText?: string;
  /** The address it finally read, after any redirect. */
  linkedUrl?: string;
  /** Finnish failure wording, when the job should land as failed instead. */
  failWith?: string;
  /**
   * A PNG on disk that the consumer found on the page and stored (#205), put
   * into the local bucket under the job's own key.
   */
  linkedImage?: string;
  /** The server-owned recipe snapshot an edit job was started against (#215). */
  targetRecipe?: unknown;
}

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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
