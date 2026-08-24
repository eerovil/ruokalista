/**
 * The session is a signed cookie and nothing else — there is no session table.
 * With one household and a handful of members, revoking a session means rotating
 * SESSION_SECRET, which is acceptable and saves a table plus a read on every
 * request. See docs/spec.md, "Sign-in".
 *
 * The cookie carries `<member_id>.<expires_at>.<signature>`, where the signature
 * is HMAC-SHA256 over `<member_id>.<expires_at>` and expires_at is a Unix
 * timestamp in seconds.
 */

const COOKIE_NAME = "ruokalista_session";
const SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

export interface Session {
  memberId: number;
  expiresAt: number;
}

/** The `Set-Cookie` value that signs `memberId` in for the next 30 days. */
export async function issueSessionCookie(
  secret: string,
  memberId: number,
  nowSeconds: number,
): Promise<string> {
  const expiresAt = nowSeconds + SESSION_LIFETIME_SECONDS;
  const payload = `${memberId}.${expiresAt}`;
  const signature = await sign(secret, payload);

  return [
    `${COOKIE_NAME}=${payload}.${signature}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${SESSION_LIFETIME_SECONDS}`,
  ].join("; ");
}

/** The `Set-Cookie` value that clears the session. */
export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/**
 * The session this request carries, or null when it carries none, the signature
 * does not verify, or it has expired. Callers cannot tell those apart on
 * purpose — every one of them means "not signed in".
 */
export async function readSession(
  request: Request,
  secret: string,
  nowSeconds: number,
): Promise<Session | null> {
  const raw = cookieValue(request.headers.get("Cookie"), COOKIE_NAME);
  if (raw === null) return null;

  const parts = raw.split(".");
  if (parts.length !== 3) return null;

  const [memberIdText, expiresAtText, signature] = parts as [
    string,
    string,
    string,
  ];

  const verified = await verify(
    secret,
    `${memberIdText}.${expiresAtText}`,
    signature,
  );
  if (!verified) return null;

  const memberId = Number(memberIdText);
  const expiresAt = Number(expiresAtText);
  if (!Number.isSafeInteger(memberId) || !Number.isSafeInteger(expiresAt)) {
    return null;
  }
  if (expiresAt <= nowSeconds) return null;

  return { memberId, expiresAt };
}

async function hmacKey(
  secret: string,
  usage: "sign" | "verify",
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await hmacKey(secret, "sign");
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return base64UrlEncode(new Uint8Array(signature));
}

/**
 * crypto.subtle.verify does the comparison in constant time. Comparing the
 * signatures with `!==` would short-circuit on the first differing character and
 * leak how much of a forgery was right.
 */
async function verify(
  secret: string,
  payload: string,
  signature: string,
): Promise<boolean> {
  const bytes = base64UrlDecode(signature);
  if (bytes === null) return false;

  const key = await hmacKey(secret, "verify");
  return crypto.subtle.verify(
    "HMAC",
    key,
    bytes,
    new TextEncoder().encode(payload),
  );
}

function cookieValue(header: string | null, name: string): string | null {
  if (header === null) return null;

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== name) continue;
    return pair.slice(separator + 1).trim();
  }

  return null;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(text: string): Uint8Array | null {
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
