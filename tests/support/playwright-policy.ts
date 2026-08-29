/**
 * Keep one local failure actionable instead of letting a dead dev server turn
 * it into dozens of connection refusals. CI keeps running so its one attempt
 * still reports the complete cross-browser surface.
 */
export function browserMaxFailures(
  environment: Readonly<Record<string, string | undefined>>,
): number {
  return environment["GITHUB_ACTIONS"] === "true" ? 0 : 1;
}
