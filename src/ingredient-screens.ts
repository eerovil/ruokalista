import { problem } from "./auth.ts";
import { html, page } from "./html.ts";
import { ingredientsFor } from "./ingredients.ts";
import type { Member } from "./members.ts";
import type { RouteContext } from "./router.ts";

/**
 * The shared list, alphabetical, each with the number of recipes using it.
 *
 * Rename is available to an admin; merging two that should have been one is
 * still not in v1. The list exists partly so drift can be seen early — two
 * near-twins sitting next to each other is the warning.
 *
 * Reading it is every member's business and renaming is not, and #143 is what
 * moved that line. The dictionary is global now: one `suola` shared by every
 * household. Coining a new name while writing a recipe is still ordinary work —
 * it adds a row nobody else was using. Renaming an existing one rewrites what
 * every household's recipes say, which is exactly the shape of thing
 * `requireAdmin` exists for. The gate is on the route (`src/index.ts`); the
 * form below is simply not drawn for somebody who cannot use it.
 */

export class RenameRefused extends Error {}

/** `GET /ingredients` */
export async function ingredientsScreen(
  { env }: RouteContext,
  member: Member,
): Promise<Response> {
  return page("Ainekset", await ingredientList(env.DB, member, null), "ingredients", member);
}

/** `POST /ingredients/:id/rename` */
export async function renameForm(
  { env, request, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const form = await request.formData();

  try {
    await renameIngredient(
      env.DB,
      member,
      Number(params["id"]),
      String(form.get("name") ?? ""),
    );
  } catch (error) {
    if (!(error instanceof RenameRefused)) throw error;
    return page(
      "Ainekset",
      await ingredientList(env.DB, member, error.message),
      "ingredients",
      member,
      400,
    );
  }

  return new Response(null, {
    status: 303,
    headers: { Location: "/ingredients" },
  });
}

/** `PATCH /api/ingredients/:id` */
export async function apiRename(
  { env, request, params }: RouteContext,
  member: Member,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return problem(400, "Expected a JSON body.");
  }

  try {
    await renameIngredient(
      env.DB,
      member,
      Number(params["id"]),
      String(body["name"] ?? ""),
    );
  } catch (error) {
    if (error instanceof RenameRefused) return problem(400, error.message);
    throw error;
  }

  return new Response(null, { status: 204 });
}

async function renameIngredient(
  db: D1Database,
  member: Member,
  id: number,
  rawName: string,
): Promise<void> {
  const name = rawName.trim();
  if (name === "") throw new RenameRefused("Aineksella pitää olla nimi.");

  const existing = await ingredientsFor(db, member.householdId);
  const target = existing.find((ingredient) => ingredient.id === id);
  if (target === undefined) throw new RenameRefused("Tuntematon aines.");

  // v1 has no merge, so renaming onto a name that already exists would either
  // break the unique index or quietly merge two ingredients. Say so instead.
  const clash = existing.find(
    (ingredient) =>
      ingredient.id !== id &&
      ingredient.name.toLocaleLowerCase("fi") === name.toLocaleLowerCase("fi"),
  );
  if (clash !== undefined) {
    throw new RenameRefused(
      `${clash.name} on jo olemassa. Yhdistäminen ei ole vielä mahdollista.`,
    );
  }

  await db
    .prepare("UPDATE ingredient SET name = ? WHERE id = ?")
    .bind(name, id)
    .run();
}

async function ingredientList(
  db: D1Database,
  member: Member,
  refused: string | null,
) {
  const ingredients = await ingredientsFor(db, member.householdId);

  return html`<h1>Ainekset</h1>
    <p class="empty">
      Kaikkien talouksien yhteinen sanasto. Kaksi lähes samaa nimeä vierekkäin
      on merkki siitä, että toinen kannattaa nimetä uudelleen — nimeäminen on
      ylläpitäjän työtä, koska se muuttaa nimen kaikille talouksille.
    </p>
    <!-- The cupboard is a short list of these same ingredients, so this is the
         screen it hangs off; it has no tab of its own (#125). -->
    <p><a href="/kaappi">Kaapin ainekset</a></p>
    ${refused === null ? "" : html`<p class="refused">${refused}</p>`}
    ${ingredients.length === 0
      ? html`<p class="empty">
          Aineksia ei ole vielä yhtään. Ne syntyvät reseptejä tuotaessa.
        </p>`
      : html`<ul class="ingredients">
          ${ingredients.map(
            // Read first: the row is the name and how much it is used. The
            // whole row is also the way in to renaming, so the affordance costs
            // no line of its own — a list of live text boxes read as a form
            // nobody had finished filling in.
            (ingredient) => html`<li>
              ${member.isAdmin
                ? html`<details class="rename">
                    <summary>
                      <span class="ingredient-name">${ingredient.name}</span>
                      <span class="meta"
                        >${ingredient.recipeCount === 0
                          ? "ei käytössä"
                          : `${ingredient.recipeCount} reseptissä`}</span
                      >
                    </summary>
                    <form
                      method="post"
                      action="/ingredients/${ingredient.id}/rename"
                      class="inline"
                    >
                      <input
                        name="name"
                        value="${ingredient.name}"
                        aria-label="Aineksen nimi"
                      />
                      <button type="submit">Tallenna</button>
                    </form>
                  </details>`
                : html`<div class="rename is-readonly">
                    <span class="ingredient-name">${ingredient.name}</span>
                    <span class="meta"
                      >${ingredient.recipeCount === 0
                        ? "ei käytössä"
                        : `${ingredient.recipeCount} reseptissä`}</span
                    >
                  </div>`}
            </li>`,
          )}
        </ul>`}`;
}
