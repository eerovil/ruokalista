import {
  addToCookList,
  changeMultiplier,
  CookListRefused,
  cookList,
  findListedDish,
  markCooked,
  removeFromCookList,
  type ListedDish,
} from "./cook-list.ts";
import { html, multiplierField, page, type Raw } from "./html.ts";
import type { Member } from "./members.ts";
import { externalClient } from "./product-picker.ts";
import { recipeImage } from "./recipe-picture.ts";
import { findReadableRecipe, renderRecipe } from "./recipes.ts";
import type { RouteContext } from "./router.ts";
import { formatMultiplier, parseMultiplier } from "./scaling.ts";

/**
 * `GET /` — the dishes this household means to cook (#345).
 *
 * It replaced the meal calendar. There are no days and no meals: a dish gets
 * here from its recipe page, and leaves when somebody taps **Kokattu** or
 * takes it off. The order is the order they were added in, which is the only
 * order the list knows.
 *
 * Each row's own tap opens the recipe at this dish's size, because cooking is
 * what the list is for. Changing the size or taking it off without cooking is
 * the quiet `Muokkaa` beside it, the way the calendar's card had it (#309).
 */
export async function cookListScreen(
  { env }: RouteContext,
  member: Member,
): Promise<Response> {
  const dishes = await cookList(env.DB, member.householdId);
  return page(
    "Kokattavat",
    html`<h1>Kokattavat</h1>
      ${dishes.length === 0
        ? html`<div class="nothing">
            <p class="empty">
              Listalla ei ole vielä mitään. Lisää ruoka listalle sen reseptin
              sivulta.
            </p>
            <p><a class="button" href="/recipes">Selaa reseptejä</a></p>
          </div>`
        : html`<ul class="cook-list">
              ${dishes.map(listRow)}
            </ul>
            <p class="cook-more"><a href="/recipes">Lisää ruokia resepteistä</a></p>`}`,
    "cook-list",
    member,
  );
}

function listRow(dish: ListedDish): Raw {
  return html`<li class="cook-item" data-batch-id="${dish.id}">
    <a class="cook-dish" href="/recipes/${dish.recipeId}?multiplier=${String(dish.multiplier)}">
      ${recipeImage({ id: dish.recipeId, imageKey: dish.imageKey }, "thumb")}
      <span class="cook-title">${dish.title}</span>
      <span class="cook-size">${formatMultiplier(dish.multiplier)}</span>
    </a>
    <div class="cook-actions">
      <a class="cook-edit" href="/batches/${dish.id}" aria-label="Muokkaa: ${dish.title}"
        >Muokkaa</a
      >
      <form method="post" action="/batches/${dish.id}/cooked" class="inline">
        <input type="hidden" name="instanceKey" value="${dish.instanceKey}" />
        <button type="submit" class="primary" aria-label="Kokattu: ${dish.title}">Kokattu</button>
      </form>
    </div>
  </li>`;
}

/** `GET /batches/:id` — one dish on the list: its size, or off the list. */
export async function listedDishScreen(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const dish = await findListedDish(env.DB, member.householdId, Number(params["id"]));
  if (dish === null) return notOnList(member);
  return page(dish.title, dishActions(dish, null), "cook-list", member);
}

/**
 * On a refused multiplier the box holds what was typed, not what is stored, so
 * the member can see and fix it (the repo's screen-refusal rule).
 */
function dishActions(
  dish: ListedDish,
  refusal: { message: string; typed: string } | null,
): Raw {
  return html`${recipeImage({ id: dish.recipeId, imageKey: dish.imageKey })}
    <h1>${dish.title}</h1>
    ${refusal === null ? "" : html`<p class="refused">${refusal.message}</p>`}

    <p class="batch-actions">
      <a class="button" href="/recipes/${dish.recipeId}?multiplier=${String(dish.multiplier)}"
        >Avaa resepti</a
      >
    </p>

    <form method="post" action="/batches/${dish.id}/multiplier" class="stacked">
      <input type="hidden" name="instanceKey" value="${dish.instanceKey}" />
      <p class="preference-label">Kerroin</p>
      ${multiplierField({
        current: refusal === null ? dish.multiplier : null,
        typed: refusal?.typed ?? formatMultiplier(dish.multiplier).slice(0, -1),
        label: "Kerroin",
        submit: "Tallenna",
      })}
    </form>

    <form method="post" action="/batches/${dish.id}/delete" class="stacked">
      <input type="hidden" name="instanceKey" value="${dish.instanceKey}" />
      <button type="submit" class="quiet">Poista listalta kokkaamatta</button>
    </form>
    <p><a href="/">Takaisin kokattaviin</a></p>`;
}

/**
 * `POST /batches/:id/multiplier` — how much of the recipe this cooking makes.
 *
 * A tapped chip arrives as `preset`, a typed value as `multiplier`, and the
 * chip wins where both are present: pressing 2× means 2×, whatever is left in
 * the box beside it.
 */
export async function changeListedMultiplierForm(
  { env, request, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const form = await request.formData();
  const dish = await findListedDish(env.DB, member.householdId, Number(params["id"]));
  const instanceKey = String(form.get("instanceKey") ?? "");
  if (dish === null || dish.instanceKey !== instanceKey) return notOnList(member);
  const chosen = chosenMultiplier(form);
  try {
    const changed = await changeMultiplier(
      env.DB,
      member,
      dish.id,
      instanceKey,
      parseMultiplier(chosen) ?? Number.NaN,
    );
    if (!changed) return notOnList(member);
  } catch (error) {
    if (!(error instanceof CookListRefused)) throw error;
    return page(
      dish.title,
      dishActions(dish, { message: error.message, typed: chosen }),
      "cook-list",
      member,
      400,
    );
  }
  return backToList();
}

/** `POST /batches/:id/cooked` — cooked today, and off the list. */
export async function markCookedForm(
  { env, request, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const form = await request.formData();
  const done = await markCooked(
    env.DB,
    member,
    Number(params["id"]),
    String(form.get("instanceKey") ?? ""),
  );
  return done ? backToList() : notOnList(member);
}

/** `POST /batches/:id/delete` — off the list without being cooked. */
export async function removeListedForm(
  { env, request, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const form = await request.formData();
  const removed = await removeFromCookList(
    env.DB,
    member,
    Number(params["id"]),
    String(form.get("instanceKey") ?? ""),
  );
  return removed ? backToList() : notOnList(member);
}

/**
 * `POST /recipes/:id/kokattaviin` — this dish onto the list, at the size the
 * member tapped.
 *
 * A refusal re-renders the recipe it came from, with the refusal at the top,
 * rather than a dead end somewhere else.
 */
export async function addToCookListForm(
  { env, request, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipe = await findReadableRecipe(
    env.DB,
    member.householdId,
    Number(params["id"]),
  );
  if (recipe === null || recipe.parentId !== null) {
    return page(
      "Ei löytynyt",
      html`<h1>Ei löytynyt</h1><p class="empty">Tätä reseptiä ei ole.</p>`,
      "recipes",
      member,
      404,
    );
  }

  const form = await request.formData();
  const chosen = chosenMultiplier(form);
  const multiplier = parseMultiplier(chosen);
  try {
    await addToCookList(env.DB, member, {
      recipeId: recipe.id,
      multiplier: multiplier ?? Number.NaN,
    });
  } catch (error) {
    if (!(error instanceof CookListRefused)) throw error;
    return renderRecipe(
      env.DB,
      member,
      recipe,
      multiplier ?? 1,
      error.message,
      env.CAST_APP_ID,
      undefined,
      externalClient(env, member) !== null,
    );
  }
  return backToList();
}

function chosenMultiplier(form: FormData): string {
  const preset = String(form.get("preset") ?? "").trim();
  return preset === "" ? String(form.get("multiplier") ?? "").trim() : preset;
}

function backToList(): Response {
  return new Response(null, { status: 303, headers: { Location: "/" } });
}

function notOnList(member: Member): Response {
  return page(
    "Ei löytynyt",
    html`<h1>Ei löytynyt</h1>
      <p class="empty">Tätä ruokaa ei ole kokattavien listalla.</p>
      <p><a href="/">Takaisin kokattaviin</a></p>`,
    "cook-list",
    member,
    404,
  );
}
