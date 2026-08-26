import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Cookie } from "@playwright/test";

/**
 * Signs a session cookie the way the Worker does, so a test can be signed in
 * without a Google round trip. Same trick as scripts/mint-cookie.mjs: the app
 * has no way to sign anyone in without Google, and this does not give it one —
 * it only works here because .dev.vars is readable.
 */

const COOKIE_NAME = "ruokalista_session";
const LIFETIME_SECONDS = 30 * 24 * 60 * 60;

function sessionSecret(): string {
  const text = readFileSync(new URL("../../.dev.vars", import.meta.url), "utf8");

  for (const line of text.split("\n")) {
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    if (line.slice(0, separator).trim() !== "SESSION_SECRET") continue;
    return line
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }

  throw new Error("No SESSION_SECRET in .dev.vars — copy .dev.vars.example.");
}

/**
 * A cookie for a seeded member. 1 is Koti's Eero, an ordinary member; 2 is the
 * neighbour, in the other household; 3 is Koti's admin.
 */
export function sessionCookie(memberId = 1, lifetime = LIFETIME_SECONDS): Cookie {
  const expiresAt = Math.floor(Date.now() / 1000) + lifetime;
  const payload = `${memberId}.${expiresAt}`;
  const signature = createHmac("sha256", sessionSecret())
    .update(payload)
    .digest("base64url");

  return {
    name: COOKIE_NAME,
    value: `${payload}.${signature}`,
    domain: "127.0.0.1",
    path: "/",
    expires: expiresAt,
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
  };
}
