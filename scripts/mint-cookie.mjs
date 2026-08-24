/**
 * Mint a local session cookie, so protected routes can be exercised before the
 * Google handshake exists.
 *
 *   ./scripts/node.sh node scripts/mint-cookie.mjs 1
 *   ./scripts/node.sh node scripts/mint-cookie.mjs 1 -60   # already expired
 *
 * This is a developer tool, not a route. The Worker has no way to sign anyone in
 * without Google — deliberately, because an auth bypass that ships is how the
 * last attempt went wrong. It only works here because .dev.vars is readable.
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

const memberId = Number(process.argv[2] ?? 1);
if (!Number.isSafeInteger(memberId) || memberId <= 0) {
  console.error("usage: node scripts/mint-cookie.mjs <member_id> [lifetime_s]");
  process.exit(1);
}

// A negative lifetime mints an already-expired cookie, which is how the expiry
// branch gets exercised.
const lifetime = Number(process.argv[3] ?? SESSION_LIFETIME_SECONDS);
if (!Number.isSafeInteger(lifetime)) {
  console.error("lifetime_s must be a whole number of seconds");
  process.exit(1);
}

const secret = process.env.SESSION_SECRET ?? fromDevVars("SESSION_SECRET");
if (!secret) {
  console.error("No SESSION_SECRET in the environment or .dev.vars.");
  process.exit(1);
}

const expiresAt = Math.floor(Date.now() / 1000) + lifetime;
const payload = `${memberId}.${expiresAt}`;
const signature = createHmac("sha256", secret)
  .update(payload)
  .digest("base64url");

process.stdout.write(`ruokalista_session=${payload}.${signature}\n`);

function fromDevVars(name) {
  let text;
  try {
    text = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
  } catch {
    return null;
  }

  for (const line of text.split("\n")) {
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    if (line.slice(0, separator).trim() !== name) continue;
    return line
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }

  return null;
}
