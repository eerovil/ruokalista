import { cookieValue, sign, verify } from "./signing.ts";

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
