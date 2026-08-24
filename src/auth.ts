interface AuthEnv {
  DB: D1Database;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
}

export interface AuthMember {
  id: number;
  household_id: number;
  display_name: string;
}

const SESSION_COOKIE = "ruokalista_session";
const STATE_COOKIE = "ruokalista_oauth_state";
const SESSION_SECONDS = 60 * 60 * 24 * 30;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlText(text: string): string {
  return base64Url(new TextEncoder().encode(text));
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

function cookies(request: Request): Map<string, string> {
  const result = new Map<string, string>();
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    result.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return result;
}

async function hmacKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);
}

async function hmac(secret: string, message: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret, ["sign"]), new TextEncoder().encode(message));
  return base64Url(new Uint8Array(signature));
}

async function hmacMatches(secret: string, message: string, signature: string): Promise<boolean> {
  let expected: ArrayBuffer;
  try {
    expected = fromBase64Url(signature).slice().buffer as ArrayBuffer;
  } catch {
    return false;
  }
  // crypto.subtle.verify compares in constant time; `===` on the base64 would not.
  return crypto.subtle.verify("HMAC", await hmacKey(secret, ["verify"]), expected, new TextEncoder().encode(message));
}

function secureCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export async function createSessionCookie(memberId: number, secret: string): Promise<string> {
  const payload = base64UrlText(JSON.stringify({ member_id: memberId, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS }));
  return secureCookie(SESSION_COOKIE, `${payload}.${await hmac(secret, payload)}`, SESSION_SECONDS);
}

export async function readSessionMember(request: Request, env: AuthEnv): Promise<AuthMember | null> {
  if (!env.SESSION_SECRET) return null;
  const session = cookies(request).get(SESSION_COOKIE);
  if (!session) return null;
  const dot = session.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = session.slice(0, dot);
  const signature = session.slice(dot + 1);
  if (!await hmacMatches(env.SESSION_SECRET, payload, signature)) return null;
  let parsed: { member_id?: unknown; exp?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
  } catch {
    return null;
  }
  const memberId = Number(parsed.member_id);
  const exp = Number(parsed.exp);
  if (!Number.isInteger(memberId) || memberId <= 0 || !Number.isFinite(exp) || exp <= Date.now() / 1000) return null;
  return env.DB.prepare(`SELECT id, household_id, display_name FROM member WHERE id = ?`).bind(memberId).first<AuthMember>();
}

export function clearSessionCookie(): string {
  return secureCookie(SESSION_COOKIE, "", 0);
}

export function authConfigured(env: AuthEnv): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.SESSION_SECRET);
}

export function startGoogleAuth(request: Request, env: AuthEnv): Response {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.SESSION_SECRET) {
    return new Response("Google-kirjautumisen asetukset puuttuvat.", { status: 503 });
  }
  const state = base64Url(crypto.getRandomValues(new Uint8Array(24)));
  const origin = new URL(request.url).origin;
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account"
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      "set-cookie": secureCookie(STATE_COOKIE, state, 600)
    }
  });
}

interface GoogleTokenResponse {
  id_token?: string;
}

interface GoogleTokenInfo {
  aud?: string;
  sub?: string;
  email?: string;
  name?: string;
  exp?: string;
}

export async function finishGoogleAuth(request: Request, env: AuthEnv): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.SESSION_SECRET) {
    return new Response("Google-kirjautumisen asetukset puuttuvat.", { status: 503 });
  }
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = cookies(request).get(STATE_COOKIE);
  if (!code || !state || !expectedState || state !== expectedState) return new Response("Kirjautumisen state-tarkistus epäonnistui.", { status: 400 });

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/auth/google/callback`,
      grant_type: "authorization_code"
    })
  });
  if (!tokenResponse.ok) return new Response("Google-tokenin vaihto epäonnistui.", { status: 502 });
  const tokenPayload = await tokenResponse.json<GoogleTokenResponse>();
  if (!tokenPayload.id_token) return new Response("Google ei palauttanut id tokenia.", { status: 502 });

  const verifyResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokenPayload.id_token)}`);
  if (!verifyResponse.ok) return new Response("Google id token ei kelpaa.", { status: 401 });
  const identity = await verifyResponse.json<GoogleTokenInfo>();
  if (identity.aud !== env.GOOGLE_CLIENT_ID || !identity.sub || Number(identity.exp ?? 0) <= Date.now() / 1000) {
    return new Response("Google id tokenin tiedot eivät kelpaa.", { status: 401 });
  }
  const member = await env.DB.prepare(`SELECT id, household_id, display_name FROM member WHERE google_sub = ?`).bind(identity.sub).first<AuthMember>();
  if (!member) {
    return new Response(`<!doctype html><html lang="fi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ei pääsyä · Ruokalista</title><body><main><h1>Ruokalista</h1><p>Tällä Google-tilillä ei ole jäsenyyttä kotitaloudessa.</p><p>Pyydä kotitaloutta lisäämään Google-tilisi ennen kirjautumista.</p></main></body></html>`, { status: 403, headers: { "content-type": "text/html; charset=utf-8", "set-cookie": secureCookie(STATE_COOKIE, "", 0) } });
  }
  const headers = new Headers({ location: "/" });
  headers.append("set-cookie", await createSessionCookie(member.id, env.SESSION_SECRET));
  headers.append("set-cookie", secureCookie(STATE_COOKIE, "", 0));
  return new Response(null, { status: 303, headers });
}
