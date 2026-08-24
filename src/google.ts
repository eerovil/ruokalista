import { base64UrlDecode } from "./signing.ts";

/**
 * Google sign-in, authorization-code flow, handled entirely in the Worker.
 *
 * On the signature of the id token: it is never handled by the browser. The
 * Worker posts the authorization code straight to Google's token endpoint over
 * TLS and reads the id token out of that response, so the transport already
 * establishes who sent it. What is checked here is that its claims are the ones
 * we asked for — issuer, audience and expiry — which is what catches a token
 * that is genuine but meant for somebody else's application.
 */

const AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export interface GoogleIdentity {
  /** Google's stable account id. What a member is matched on — never email. */
  sub: string;
  name: string;
  email: string | null;
}

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
}

/** Where to send the browser to start sign-in. */
export function authorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  // No refresh token is wanted: the app never acts for a member out of session.
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

/** Swap the authorization code for an id token, or null if Google refuses. */
export async function exchangeCode(
  credentials: GoogleCredentials,
  redirectUri: string,
  code: string,
): Promise<string | null> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) return null;

  const body = (await response.json()) as { id_token?: unknown };
  return typeof body.id_token === "string" ? body.id_token : null;
}

/**
 * The identity an id token claims, once issuer, audience and expiry check out.
 * Null means the token is not one this application should act on.
 */
export function readIdentity(
  idToken: string,
  clientId: string,
  nowSeconds: number,
): GoogleIdentity | null {
  const segments = idToken.split(".");
  if (segments.length !== 3) return null;

  const decoded = base64UrlDecode(segments[1]!);
  if (decoded === null) return null;

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(new TextDecoder().decode(decoded));
  } catch {
    return null;
  }

  const { iss, aud, exp, sub, name, email } = claims;

  if (typeof iss !== "string" || !ISSUERS.includes(iss)) return null;
  if (aud !== clientId) return null;
  if (typeof exp !== "number" || exp <= nowSeconds) return null;
  if (typeof sub !== "string" || sub === "") return null;

  return {
    sub,
    name: typeof name === "string" && name !== "" ? name : "Tuntematon",
    email: typeof email === "string" ? email : null,
  };
}
