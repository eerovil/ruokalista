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

/**
 * 10.x, 172.16–31.x and 192.168.x — the addresses a home network hands out.
 *
 * Parsed rather than matched with a pattern. The first attempt was a regular
 * expression that counted octets wrong for `10.0.0.7`, and the failure mode of
 * getting this subtly wrong in the other direction is a shipped shortcut.
 */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;

  const octets = parts.map((part) =>
    /^\d{1,3}$/.test(part) ? Number(part) : -1,
  );
  if (octets.some((octet) => octet < 0 || octet > 255)) return false;

  const [first, second] = octets as [number, number, number, number];

  if (first === 10) return true;
  if (first === 192 && second === 168) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;

  // 100.64–127.x, the carrier-grade NAT range Tailscale hands out. Not
  // publicly routable, and how a tailnet peer addresses this host directly.
  return first === 100 && second >= 64 && second <= 127;
}

/**
 * Whether this request reached a development server rather than the deployment.
 *
 * Used to offer the sample draft on the intake screen, which is the one thing
 * in the app that must be impossible to reach in production. The test is the
 * address the browser used, not a flag or an env var: a deployed Worker is only
 * ever addressed by a public hostname, so no misconfiguration — and no
 * `wrangler secret put` — can turn this on live. An env override is exactly the
 * kind of thing that drifted in the closed attempt.
 *
 * Loopback covers this host; the private ranges cover a phone on the same
 * wifi pointed at `wrangler dev`.
 */
export function isLocalOrigin(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === PRODUCTION_HOST || host === WORKER_HOST) return false;

  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "::1" ||
    // A `tailscale serve` name. The suffix belongs to Tailscale and resolves
    // only inside a tailnet, so the deployment can never be reached at one —
    // and serving over it is how a phone gets HTTPS, which the session cookie
    // requires.
    host.endsWith(".ts.net") ||
    isPrivateIpv4(host)
  );
}
