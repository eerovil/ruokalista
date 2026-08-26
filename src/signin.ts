import type { Env } from "./env.ts";
import {
  authorizeUrl,
  exchangeCode,
  readIdentity,
  type GoogleCredentials,
} from "./google.ts";
import { html, page, type Raw } from "./html.ts";
import {
  allMembers,
  findMemberById,
  findMemberByGoogleSub,
} from "./members.ts";
import { googleCallbackUrl, isLocalOrigin } from "./public-origin.ts";
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

// ---------------------------------------------------------------- screens

/** `GET /signin` */
export async function signInScreen({
  env,
  url,
}: RouteContext): Promise<Response> {
  const dev = isLocalOrigin(url) ? await devSignInForm(env) : "";

  if (credentials(env) === null) {
    return page(
      "Kirjautuminen",
      html`<h1>Ruokalista</h1>
        <p class="empty">
          Google-kirjautumista ei ole vielä määritetty tähän ympäristöön.
        </p>
        ${dev}`,
      "signed-out",
      null,
      // A development server with no Google credentials can still be walked
      // through, so this is only degraded when there is genuinely no way in.
      dev === "" ? 503 : 200,
    );
  }

  return page(
    "Kirjautuminen",
    html`<h1>Ruokalista</h1>
      <p><a class="button" href="/auth/google">Kirjaudu Google-tilillä</a></p>
      ${dev}`,
    "signed-out",
    null,
  );
}

/**
 * The development sign-in. Offered only by a development server, and refused by
 * the route itself rather than merely hidden — a gate that only removes a
 * button is not a gate.
 *
 * CLAUDE.md says a shipped auth bypass is one of the things that went wrong in
 * the closed attempt, and this is deliberately not that: the test is the
 * address the browser used (`isLocalOrigin`), so no flag, env var or secret can
 * turn it on for the deployment. It also creates nobody. It can only hand out a
 * session for a member row that already exists, which is the same rule Google
 * sign-in follows — there is still no signup path anywhere.
 */
async function devSignInForm(env: Env): Promise<Raw> {
  const members = await allMembers(env.DB);

  if (members.length === 0) {
    return html`<hr />
      <p class="empty">
        Kehityspalvelin: tietokannassa ei ole yhtään jäsentä. Aja
        <code>seed:local</code>.
      </p>`;
  }

  return html`<hr />
    <h2>Kehityskirjautuminen</h2>
    <p class="empty">
      Vain kehityspalvelimella. Julkaistussa sovelluksessa tätä ei ole, eikä
      tämä luo ketään — se antaa istunnon jäsenelle joka on jo olemassa.
    </p>
    ${members.map(
      (member) => html`<form method="post" action="/auth/dev-signin">
        <input type="hidden" name="memberId" value="${member.id}" />
        <button type="submit" class="quiet">
          Kirjaudu: ${member.displayName}
        </button>
      </form>`,
    )}`;
}

/** `POST /auth/dev-signin` — refuses anywhere but a development server. */
export async function devSignIn({
  env,
  url,
  request,
}: RouteContext): Promise<Response> {
  // Not a 403: on the deployment this route does not exist at all.
  if (!isLocalOrigin(url)) return new Response("Not found", { status: 404 });

  const secret = env.SESSION_SECRET;
  if (!secret) return failedScreen("Kirjautumista ei ole määritetty.");

  const form = await request.formData();
  const member = await findMemberById(env.DB, Number(form.get("memberId")));
  if (member === null) return failedScreen("Tuntematon jäsen.");

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": await issueSessionCookie(
        secret,
        member.id,
        Math.floor(Date.now() / 1000),
      ),
    },
  });
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
    null,
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
    null,
    400,
  );
}

// ----------------------------------------------------------------- routes

/** `GET /auth/google` — hand the browser to Google with a signed state. */
export async function startSignIn({
  env,
  url,
  request,
}: RouteContext): Promise<Response> {
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
      Location: authorizeUrl(
        google.clientId,
        googleCallbackUrl(url, request.headers),
        state,
      ),
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

  const idToken = await exchangeCode(
    google,
    googleCallbackUrl(url, request.headers),
    code,
  );
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
