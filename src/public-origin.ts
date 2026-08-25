const PRODUCTION_HOST = "ruokalista.vilpponen.fi";
const WORKER_HOST = "ruokalista.eerovil.workers.dev";

export const PRODUCTION_ORIGIN = `https://${PRODUCTION_HOST}`;

/**
 * Browser-facing origin for absolute URLs that leave the app, such as OAuth.
 *
 * Production is reverse-proxied through the VPS. nginx addresses the Worker by
 * its workers.dev hostname, so request.url uses that upstream origin. Trust the
 * forwarded public origin only for the one exact proxy shape we deploy; local
 * development and direct workers.dev requests keep their request origin.
 */
export function publicOrigin(url: URL, headers: Headers): string {
  if (
    url.hostname === WORKER_HOST &&
    headers.get("X-Forwarded-Host") === PRODUCTION_HOST &&
    headers.get("X-Forwarded-Proto") === "https"
  ) {
    return PRODUCTION_ORIGIN;
  }

  return url.origin;
}

export function googleCallbackUrl(url: URL, headers: Headers): string {
  return new URL("/auth/google/callback", publicOrigin(url, headers)).toString();
}
