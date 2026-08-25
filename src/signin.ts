import type { Env } from "./env.ts";
import {
  authorizeUrl,
  exchangeCode,
  readIdentity,
  type GoogleCredentials,
} from "./google.ts";
import { html, page } from "./html.ts";
import { findMemberByGoogleSub } from "./members.ts";
import type { RouteContext } from "./router.ts";
import { clearSessionCookie, issueSessionCookie } from "./session.ts";
import { base64UrlEncode, cookieValue, sign, verify } from "./signing.ts";

/**
 * Sign-in, end to end. Google is the gate and there is no signup path anywhere:
 * a Google account with no member row is told the household has to add them,
 * and nothing is created.
 */

const STATE_COOKIE = "ruokalista_oauth_state";
const STATE_LIFETIME_SECONDS = 10 * 60;

function credentials(env: Env): GoogleCredentials | null {
  const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret } = env;
  return id && secret ? { clientId: id, clientSecret: secret } : null;
}

/** Google requires an exact match, so it is derived from the request's origin. */
function redirectUri(url: URL): string {
  return new URL("/auth/google/callback", url.origin).toString();
}

// ---------------------------------------------------------------- screens

/** `GET /signin` */
export function signInScreen({ env }: RouteContext): Response {
  if (credentials(env) === null) {
    return page(
      "Kirjautuminen",
      html`<h1>Ruokalista</h1>
        <p class="empty">
          Google-kirjautumista ei ole vielä määritetty tähän ympäristöön.
        </p>`,
      "signed-out",
      503,
    );
  }

  return page(
    "Kirjautuminen",
    html`<h1>Ruokalista</h1>
      <p><a class="button" href="/auth/google">Kirjaudu Google-tilillä</a></p>`,
    "signed-out",
  );
}

/**
 * The wall. Signed in with Google, but nobody in the household has added them.
 *
 * It shows the Google account id, because without it the household has no way to
 * add the person: the id is only knowable from a sign-in attempt, and v1 inserts
 * member rows by hand. It is an identifier, not a credential, and it is only
 * ever shown to the person it belongs to.
 */
function notAMemberScreen(sub: string, email: string | null): Response {
  return page(
    "Ei käyttöoikeutta",
    html`<h1>Talous ei tunne sinua</h1>
      <p>
        Kirjautuminen Google-tilillä onnistui${email === null
          ? ""
          : ` (${email})`}, mutta tälle tilille ei ole
        käyttöoikeutta. Talouden jäsen lisää sinut käsin.
      </p>
      <p class="empty">Anna hänelle tämä tunniste: <code>${sub}</code></p>`,
    "signed-out",
    403,
  );
}

function failedScreen(message: string): Response {
  return page(
    "Kirjautuminen epäonnistui",
    html`<h1>Kirjautuminen epäonnistui</h1>
      <p class="empty">${message}</p>
      <p><a href="/signin">Yritä uudelleen</a></p>`,
    "signed-out",
    400,
  );
}

// ----------------------------------------------------------------- routes

/** `GET /auth/google` — hand the browser to Google with a signed state. */
export async function startSignIn({ env, url }: RouteContext): Promise<Response> {
  const google = credentials(env);
  const secret = env.SESSION_SECRET;
  if (google === null || !secret) {
    return failedScreen("Kirjautumista ei ole määritetty.");
  }

  const nonce = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const expiresAt = Math.floor(Date.now() / 1000) + STATE_LIFETIME_SECONDS;
  const payload = `${nonce}.${expiresAt}`;
  const state = `${payload}.${await sign(secret, payload)}`;

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl(google.clientId, redirectUri(url), state),
      "Set-Cookie": [
        `${STATE_COOKIE}=${state}`,
        "Path=/auth",
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
        `Max-Age=${STATE_LIFETIME_SECONDS}`,
      ].join("; "),
    },
  });
}

/** `GET /auth/google/callback` */
export async function completeSignIn({
  env,
  url,
  request,
}: RouteContext): Promise<Response> {
  const google = credentials(env);
  const secret = env.SESSION_SECRET;
  if (google === null || !secret) {
    return failedScreen("Kirjautumista ei ole määritetty.");
  }

  if (url.searchParams.get("error") !== null) {
    return failedScreen("Google ei myöntänyt käyttöoikeutta.");
  }

  // The state has to be both the one we signed and the one this browser was
  // given; either alone would let somebody else's callback through.
  const state = url.searchParams.get("state");
  const cookie = cookieValue(request.headers.get("Cookie"), STATE_COOKIE);
  if (
    state === null ||
    cookie === null ||
    state !== cookie ||
    !(await validState(secret, state))
  ) {
    return failedScreen("Kirjautumispyyntö vanheni. Yritä uudelleen.");
  }

  const code = url.searchParams.get("code");
  if (code === null) return failedScreen("Google ei palauttanut koodia.");

  const idToken = await exchangeCode(google, redirectUri(url), code);
  if (idToken === null) return failedScreen("Google ei myöntänyt tunnistetta.");

  const identity = readIdentity(
    idToken,
    google.clientId,
    Math.floor(Date.now() / 1000),
  );
  if (identity === null) return failedScreen("Tunniste ei kelvannut.");

  const member = await findMemberByGoogleSub(env.DB, identity.sub);
  if (member === null) return notAMemberScreen(identity.sub, identity.email);

  // Two Set-Cookie headers, appended rather than joined: comma-joining them is
  // not something a browser is obliged to unpick.
  const headers = new Headers({ Location: "/" });
  headers.append(
    "Set-Cookie",
    await issueSessionCookie(secret, member.id, Math.floor(Date.now() / 1000)),
  );
  headers.append(
    "Set-Cookie",
    // The state cookie has done its job.
    `${STATE_COOKIE}=; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  );

  return new Response(null, { status: 302, headers });
}

/** `POST /auth/signout` */
export function signOut(): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: "/signin", "Set-Cookie": clearSessionCookie() },
  });
}

async function validState(secret: string, state: string): Promise<boolean> {
  const parts = state.split(".");
  if (parts.length !== 3) return false;

  const [nonce, expiresAtText, signature] = parts as [string, string, string];
  if (!(await verify(secret, `${nonce}.${expiresAtText}`, signature))) {
    return false;
  }

  const expiresAt = Number(expiresAtText);
  return (
    Number.isSafeInteger(expiresAt) && expiresAt > Math.floor(Date.now() / 1000)
  );
}
