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

export function problem(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}
