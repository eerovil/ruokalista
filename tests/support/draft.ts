import type { Page } from "@playwright/test";

/**
 * The fixture lives in `src/sample-draft.ts` because the development server
 * serves it too — one draft, so the thing tested by hand and the thing tested
 * by CI cannot drift apart.
 */
import { SAMPLE_DRAFT } from "../../src/sample-draft.ts";

export { SAMPLE_DRAFT as DRAFT_FIXTURE };
const DRAFT_FIXTURE = SAMPLE_DRAFT;

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
