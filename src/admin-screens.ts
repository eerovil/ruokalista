import { html, page } from "./html.ts";
import type { Member } from "./members.ts";
import type { RouteContext } from "./router.ts";

/**
 * The admin surface, which is deliberately almost empty. What #94 ships is the
 * boundary, not the tools behind it — the first one that needs it is the recipe
 * image generation in #96 — so this screen exists to be the place those land
 * and to be something the gate can be proved against.
 *
 * Everything here is behind `requireAdminScreen`. There is nothing on it that
 * an ordinary member would be shown a censored version of: the whole screen is
 * either yours or, as far as you can tell, not there.
 */

/** `GET /admin` */
export function adminScreen(_ctx: RouteContext, member: Member): Response {
  return page(
    "Ylläpito",
    html`<h1>Ylläpito</h1>
      <p>
        Ylläpitäjän työkalut ilmestyvät tänne; toistaiseksi niitä ei ole yhtään.
      </p>
      <p class="empty">
        Kirjautuneena: ${member.displayName}. Ylläpitäjyys merkitään käsin
        tietokantaan, samoin kuin jäsenyyskin.
      </p>`,
    "week",
  );
}

/**
 * `GET /api/admin/status` — the same gate with a JSON body, so the machine-side
 * half of it is exercised rather than assumed. It reports only what the caller
 * already knows about themselves.
 */
export function adminStatus(_ctx: RouteContext, member: Member): Response {
  return Response.json({
    admin: true,
    memberId: member.id,
    householdId: member.householdId,
  });
}
