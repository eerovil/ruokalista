import { html, page, type Raw } from "./html.ts";
import type { Member } from "./members.ts";
import {
  PantryRefused,
  pantryContents,
  removeFromPantry,
  type PantryItem,
} from "./pantry.ts";
import type { RouteContext } from "./router.ts";

/**
 * The cupboard's own screen: the short list of things the household keeps in.
 *
 * It shows what is in the cupboard and nothing else. A page listing every
 * ingredient the household has ever named, each with a switch, would be the
 * Ainekset screen again with an extra column — and it would make a two-item
 * cupboard look like a warehouse to manage. What is here is what is true, and
 * the only thing to do to it is take something out when it runs out.
 *
 * Things get in from the shopping list (#125): that is where somebody notices
 * that oregano is on it again and that they have had a jar of it for a year.
 */

/** `GET /kaappi` */
export async function pantryScreen(
  { env }: RouteContext,
  member: Member,
): Promise<Response> {
  return page("Kaappi", await pantryPage(env.DB, member, null), "ingredients", member);
}

/** `POST /kaappi/:id/poista` */
export async function pantryRemoveForm(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  try {
    await removeFromPantry(env.DB, member.householdId, Number(params["id"]));
  } catch (error) {
    if (!(error instanceof PantryRefused)) throw error;
    return page(
      "Kaappi",
      await pantryPage(env.DB, member, error.message),
      "ingredients",
      member,
      400,
    );
  }

  return new Response(null, {
    status: 303,
    headers: { Location: "/kaappi" },
  });
}

async function pantryPage(
  db: D1Database,
  member: Member,
  refused: string | null,
): Promise<Raw> {
  const items = await pantryContents(db, member.householdId);

  return html`<h1>Kaappi</h1>
    <p class="empty">
      Perusaineet, joita talossa on aina. Ne siirtyvät ostoslistalla Löytyy-osioon
      sen sijaan että niitä pitäisi ostaa.
    </p>
    ${refused === null ? "" : html`<p class="refused">${refused}</p>`}
    ${items.length === 0
      ? html`<div class="nothing">
          <p class="empty">
            Kaappi on tyhjä. Kun ostoslistalla on jotain, mitä kotoa jo löytyy,
            merkitse se siellä kaappiin.
          </p>
          <p><a class="button" href="/ostoslista">Avaa ostoslista</a></p>
        </div>`
      : html`<ul class="pantry">
          ${items.map(pantryRow)}
        </ul>`}`;
}

function pantryRow(item: PantryItem): Raw {
  return html`<li>
    <span class="ingredient-name">${item.name}</span>
    <span class="meta"
      >${item.recipeCount === 0
        ? "ei käytössä"
        : `${item.recipeCount} reseptissä`}</span
    >
    <!-- Removal is the whole point of this screen, so it is a button on the
         row and not something to open first. -->
    <form method="post" action="/kaappi/${item.ingredientId}/poista">
      <button type="submit">Loppui</button>
    </form>
  </li>`;
}
