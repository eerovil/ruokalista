import { html, page } from "./html.ts";
import { findMemberById, type Member } from "./members.ts";
import type { Handler, RouteContext } from "./router.ts";
import { readSession } from "./session.ts";

/**
 * The one place a request is turned into a member. Every route that touches
 * household data is wrapped in this, and every query below it takes the
 * member's household_id as a parameter — that is the whole of "tenancy is
 * modelled, not built".
 */

export type MemberHandler = (
  ctx: RouteContext,
  member: Member,
) => Response | Promise<Response>;

/**
 * Same wall, but for a screen: a browser that is not signed in should be sent
 * to sign in, not handed a JSON error it cannot read.
 */
export function requireMemberScreen(handler: MemberHandler): Handler {
  return guard(handler, () => signInRedirect());
}

export function requireMember(handler: MemberHandler): Handler {
  return guard(handler, (status, message) => problem(status, message));
}

function signInRedirect(): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: "/signin" },
  });
}

function guard(
  handler: MemberHandler,
  refuse: (status: number, message: string) => Response,
): Handler {
  return async (ctx) => {
    const secret = ctx.env.SESSION_SECRET;

    // Without a secret nothing can be signed or verified. Refusing every
    // request is the only safe answer; there is no unauthenticated fallback.
    if (!secret) {
      return refuse(503, "Sign-in is not configured on this deployment.");
    }

    const session = await readSession(
      ctx.request,
      secret,
      Math.floor(Date.now() / 1000),
    );
    if (session === null) return refuse(401, "Sign in to continue.");

    // A valid cookie for a member who no longer exists is still not entry.
    const member = await findMemberById(ctx.env.DB, session.memberId);
    if (member === null) return refuse(401, "Sign in to continue.");

    return handler(ctx, member);
  };
}

/**
 * The second wall, and the only one there is: a member either is an admin or is
 * not. This is not a role system and is not meant to become one — it exists for
 * the operations that are not every member's to run, the ones that spend money
 * or rewrite what the household already has.
 *
 * It wraps the member wall rather than replacing it, so an admin route is still
 * a signed-in route and still carries a household_id. Nothing here reads the
 * request: admin comes from the member row, so no header, origin, form field or
 * piece of markup can claim it.
 *
 * An ordinary member is told the route is not there, which is the same answer
 * this app gives for another household's record — whether an admin route exists
 * is not an ordinary member's business. Hiding the link is a courtesy; this is
 * the boundary.
 */
export function requireAdmin(handler: MemberHandler): Handler {
  return requireMember((ctx, member) =>
    member.isAdmin ? handler(ctx, member) : problem(404, "Not found."),
  );
}

/** Same wall, for a screen: a 404 page rather than a JSON body. */
export function requireAdminScreen(handler: MemberHandler): Handler {
  return requireMemberScreen((ctx, member) =>
    member.isAdmin ? handler(ctx, member) : adminNotFound(member),
  );
}

function adminNotFound(member: Member): Response {
  return page(
    "Ei löytynyt",
    html`<h1>Ei löytynyt</h1>
      <p class="empty">Tätä sivua ei ole.</p>
      <p><a href="/">Takaisin viikkoon</a></p>`,
    "week",
    member,
    404,
  );
}

export function problem(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}
