import { html, page } from "./html.ts";
import type { Member } from "./members.ts";
import type { RouteContext } from "./router.ts";

/**
 * The admin surface. #94 shipped the boundary and one nearly empty screen
 * behind it; #106 proposes that this screen become the *only* way an admin tool
 * is found. So it is a list of tools, one row each, and adding the next one is
 * adding a row here rather than a link to somewhere an ordinary member looks.
 *
 * It is reached from the account button in the shell, which shows the entry
 * only to an admin. That is courtesy, not the boundary: everything here and
 * everything it links to is behind `requireAdminScreen`, so an ordinary member
 * is told the route is not there whether or not they saw a link.
 *
 * There is nothing on this screen that an ordinary member would be shown a
 * censored version of: the whole screen is either yours or, as far as you can
 * tell, not there.
 */

/** `GET /admin` */
export function adminScreen(_ctx: RouteContext, member: Member): Response {
  return page(
    "Ylläpito",
    html`<h1>Ylläpito</h1>
      <ul class="recipes">
        <li>
          <a href="/admin/recipe-images">
            <span class="recipes-text">
              Reseptikuvat
              <span class="meta">
                Katso mistä resepteistä kuva puuttuu tai on vanhentunut, ja
                hallitse niiden kuvia.
              </span>
            </span>
          </a>
        </li>
        <li>
          <a href="/admin/households">
            <span class="recipes-text">
              Householdit
              <span class="meta">
                Katso ja hallitse kaikkia talouksia ja niiden jäseniä. Täältä
                lisätään uusi jäsen ilman käsin kirjoitettua SQL:ää.
              </span>
            </span>
          </a>
        </li>
        <li>
          <a href="/intake/batch">
            <span class="recipes-text">
              Tuo AgentDeck-reseptejä
              <span class="meta">
                Tarkista AgentDeckin tekemä JSON-nippu ja tallenna se
                kokonaisuutena. Ei kutsu jäsentävää mallia.
              </span>
            </span>
          </a>
        </li>
      </ul>
      <p class="empty">
        Kirjautuneena: ${member.displayName}. Ylläpitäjyys merkitään käsin
        tietokantaan, samoin kuin jäsenyyskin.
      </p>`,
    "week",
    member,
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
