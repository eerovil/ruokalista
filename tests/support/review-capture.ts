import type { Page } from "@playwright/test";

/** Write review evidence only when the repository's screenshot flag is on. */
export async function captureReview(
  page: Page,
  path: string,
  fullPage = true,
): Promise<void> {
  if (process.env["PLAYWRIGHT_SCREENSHOTS"] !== "1") return;
  await page.screenshot({ path, fullPage });
}

