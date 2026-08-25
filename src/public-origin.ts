const PRODUCTION_HOST = "ruokalista.vilpponen.fi";
const WORKER_HOST = "ruokalista.eerovil.workers.dev";

export const PRODUCTION_ORIGIN = `https://${PRODUCTION_HOST}`;

/**
 * The browser-facing origin for URLs that must be absolute.
 *
 * Production reaches the Worker through nginx on the VPS. nginx has to use the
 * workers.dev hostname upstream so Cloudflare can route and terminate TLS, which
 * means the Worker itself sees workers.dev in request.url. nginx preserves the
 * browser's host in X-Forwarded-Host and the original scheme in
 * X-Forwarded-Proto.
 *
 * Do not trust arbitrary forwarded hosts. We only accept the one exact proxy
 * shape we deploy: a request received at our known workers.dev origin, forwarded
 * from the one canonical production hostname over HTTPS. Local development and
 * direct workers.dev requests continue to use their request origin.
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
