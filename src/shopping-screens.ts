import { addDays, shortDate, shortDayName, today } from "./dates.ts";
import { html, page, raw, type Raw } from "./html.ts";
import type { Member } from "./members.ts";
import { menuBetween, type PlannedBatch } from "./menu.ts";
import {
  PantryRefused,
  addToPantry,
  pantryIngredientIds,
  removeFromPantry,
  splitByPantry,
} from "./pantry.ts";
import type { RouteContext } from "./router.ts";
import {
  AMOUNT_IN_RECIPE,
  shoppingLinesFor,
  shoppingList,
  type ShoppingItem,
} from "./shopping.ts";

/**
 * `GET /ostoslista` — what the selected cookings need bought.
 *
 * The selection lives in the query string and nowhere else. There is no
 * shopping-list table and no saved basket: the screen is a view over the week
 * that was already planned, and reopening it recomputes the default rather
 * than remembering what was ticked last time (issue #123 asks for exactly this
 * and no more).
 *
 * The one thing it does read and write is the cupboard (#125) — and that is a
 * fact about the kitchen, not about this list: adding oregano to the cupboard
 * here is the same act as adding it on the cupboard's own screen, and it
 * outlives this trip. Nothing about a particular trip is stored either way.
 *
 * That also keeps the screen server-rendered. The picker is a plain GET form
 * with checkboxes and a submit button, and each cupboard button is a small
 * POST form, so the screen works with no JavaScript at all, which is the
 * standing frontend requirement from #65.
 */

/** How far ahead there is anything to shop for. */
const WINDOW_DAYS = 14;

/** Cookings this close are the ones worth a trip to the shop right now. */
const DEFAULT_DAYS = 5;

/** Beyond this many dishes the heading stops naming them all. */
const TITLES_IN_HEADING = 3;

/** The checkbox name, so the parser and the form cannot drift apart. */
const CHOICE = "ateria";

/**
 * Present in the query string once the member has actually chosen. Without it
 * an empty selection means "just opened the screen", and the defaults apply;
 * with it, an empty selection means "I unticked everything", which is a thing
 * a member is allowed to mean.
 */
const CHOSEN = "valittu";

export async function shoppingScreen(
  { env, url }: RouteContext,
  member: Member,
  refused: string | null = null,
): Promise<Response> {
  const from = today();
  const to = addDays(from, WINDOW_DAYS - 1);

  // A batch that was cooked before today is already in the fridge, so there is
  // nothing to buy for it: the list offers the cookings still ahead.
  const cookings = (await menuBetween(env.DB, member.householdId, from, to))
    .filter((batch) => batch.startDate >= from)
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id - b.id);

  const selectedIds = chosenIds(url, cookings, from);
  const selected = cookings.filter((batch) => selectedIds.has(batch.id));

  const [lines, inPantry] = await Promise.all([
    shoppingLinesFor(env.DB, member.householdId, [...selectedIds]),
    pantryIngredientIds(env.DB, member.householdId),
  ]);

  // The cupboard is applied after the totals are added up, not before: an
  // ingredient the household already has is still part of what the cooking
  // needs, it is just not part of what the trip has to buy. Both sections keep
  // the amounts and the breakdown #123 worked out (#125).
  const { buy, atHome } = splitByPantry(shoppingList(lines), inPantry);

  const heading = headingFor(selected);

  return page(
    heading,
    html`<h1>${heading}</h1>
      ${picker(cookings, selectedIds)}
      ${refused === null ? "" : html`<p class="refused">${refused}</p>`}
      ${cookings.length === 0
        ? html`<div class="nothing">
            <p class="empty">Seuraavan kahden viikon aikana ei kokata mitään.</p>
            <p><a class="button" href="/">Suunnittele viikko</a></p>
          </div>`
        : selected.length === 0
          ? html`<p class="empty">
              Valitse ainakin yksi ateria, niin ainekset lasketaan yhteen.
            </p>`
          : sections(buy, atHome, selectedIds)}`,
    "shopping",
    member,
    refused === null ? 200 : 400,
  );
}

/**
 * `POST /ostoslista/kaappi` — the cupboard, changed from the list itself.
 *
 * The list is where somebody notices that they never actually buy oregano, so
 * this is the way the cupboard grows. The selected cookings ride along as
 * hidden fields and are rebuilt into the redirect, so the member lands back on
 * the same list they were reading with the row moved between its sections —
 * not on a default list they have to re-tick.
 */
export async function shoppingPantryForm(
  ctx: RouteContext,
  member: Member,
): Promise<Response> {
  const form = await ctx.request.formData();
  const ingredientId = Number(form.get("aines"));
  const removing = form.get("toiminto") === "poista";

  try {
    if (removing) {
      await removeFromPantry(ctx.env.DB, member.householdId, ingredientId);
    } else {
      await addToPantry(
        ctx.env.DB,
        member.householdId,
        member.id,
        ingredientId,
      );
    }
  } catch (error) {
    if (!(error instanceof PantryRefused)) throw error;
    return shoppingScreen(
      { ...ctx, url: new URL(`/ostoslista?${selectionQuery(form)}`, ctx.url) },
      member,
      error.message,
    );
  }

  return new Response(null, {
    status: 303,
    headers: { Location: `/ostoslista?${selectionQuery(form)}` },
  });
}

/**
 * The selection the form carried, re-serialised from integers we checked
 * ourselves. Nothing the browser sent is echoed into the redirect as-is.
 */
function selectionQuery(form: FormData): string {
  const query = new URLSearchParams({ [CHOSEN]: "1" });
  for (const value of form.getAll(CHOICE)) {
    const id = Number(value);
    if (Number.isSafeInteger(id)) query.append(CHOICE, String(id));
  }
  return query.toString();
}

/**
 * The batches to add up: what the query string says, or — the first time the
 * screen is opened — everything cooked today or in the next four days.
 *
 * An id that is not one of this household's upcoming cookings is dropped
 * rather than refused. The query string is a selection, not a command, and a
 * stale link should still show a list.
 */
function chosenIds(
  url: URL,
  cookings: PlannedBatch[],
  from: string,
): Set<number> {
  const offered = new Set(cookings.map((batch) => batch.id));

  if (url.searchParams.get(CHOSEN) === null) {
    const soon = addDays(from, DEFAULT_DAYS - 1);
    return new Set(
      cookings
        .filter((batch) => batch.startDate <= soon)
        .map((batch) => batch.id),
    );
  }

  const chosen = new Set<number>();
  for (const value of url.searchParams.getAll(CHOICE)) {
    const id = Number(value);
    if (Number.isSafeInteger(id) && offered.has(id)) chosen.add(id);
  }
  return chosen;
}

/** `Ostoslista: Makaronilaatikko + Tortillalasagne`. */
function headingFor(selected: PlannedBatch[]): string {
  if (selected.length === 0) return "Ostoslista";

  const titles = selected.map((batch) => batch.title);
  if (titles.length <= TITLES_IN_HEADING) {
    return `Ostoslista: ${titles.join(" + ")}`;
  }

  const named = titles.slice(0, TITLES_IN_HEADING).join(" + ");
  return `Ostoslista: ${named} ja ${titles.length - TITLES_IN_HEADING} muuta`;
}

/**
 * The cookings to choose from, closed by default — the list is what somebody
 * came here to read, and the summary already says how much of the fortnight is
 * in it. It opens itself when nothing is selected, because then the list has
 * nothing to show and the choice is the only thing to do.
 */
function picker(cookings: PlannedBatch[], selectedIds: Set<number>): Raw {
  if (cookings.length === 0) return html``;

  return html`<details class="shopping-picker" ${selectedIds.size === 0 ? rawOpen : ""}>
    <summary>
      Ateriat
      <span class="meta">${selectedIds.size}/${cookings.length} valittu</span>
    </summary>
    <form method="get" action="/ostoslista" class="stacked">
      <input type="hidden" name="${CHOSEN}" value="1" />
      <ul class="shopping-meals">
        ${cookings.map(
          (batch) => html`<li>
            <label>
              <input
                type="checkbox"
                name="${CHOICE}"
                value="${batch.id}"
                ${selectedIds.has(batch.id) ? rawChecked : ""}
              />
              <span class="shopping-meal">
                <span class="shopping-meal-title">${batch.title}</span>
                <span class="meta"
                  >${shortDayName(batch.startDate)} ${shortDate(batch.startDate)}
                  · ${batch.portions} annosta</span
                >
              </span>
            </label>
          </li>`,
        )}
      </ul>
      <button type="submit" class="primary">Päivitä lista</button>
    </form>
  </details>`;
}

const rawOpen = raw("open");
const rawChecked = raw("checked");

/**
 * The list in two parts: what to buy, then what the cupboard already covers.
 *
 * The second part is not a footnote about rows that were removed — they are
 * still the week's ingredients, with the same totals and the same breakdown.
 * It only answers a different question: this one you have (#125). A list that
 * silently dropped them would be indistinguishable from one that forgot them,
 * and the household would find out at the hob.
 */
function sections(
  buy: ShoppingItem[],
  atHome: ShoppingItem[],
  selectedIds: Set<number>,
): Raw {
  // With nothing in the cupboard there is only one list, and a lone
  // "Ostettavat" heading under a heading that already says Ostoslista is a
  // word for its own sake.
  if (atHome.length === 0) return itemList(buy, selectedIds, false);

  return html`<h2 class="shopping-section">Ostettavat</h2>
    ${buy.length === 0
      ? html`<p class="empty">Kaikki tarvittava löytyy jo kaapista.</p>`
      : itemList(buy, selectedIds, false)}
    <h2 class="shopping-section">Löytyy</h2>
    <p class="empty">
      Näitä valitut ateriat tarvitsevat, mutta ne ovat jo
      <a href="/kaappi">kaapissa</a>.
    </p>
    ${itemList(atHome, selectedIds, true)}`;
}

/**
 * One row per ingredient, each one openable to say where its total came from
 * and to move it in or out of the cupboard.
 *
 * A `<details>` rather than a script: the breakdown is the answer to "why does
 * it say five", and that answer should not depend on the browser being able to
 * run anything.
 */
function itemList(
  items: ShoppingItem[],
  selectedIds: Set<number>,
  inPantry: boolean,
): Raw {
  if (items.length === 0) {
    return html`<p class="empty">Valituissa aterioissa ei ole aineksia.</p>`;
  }

  return html`<ul class="shopping-list">
    ${items.map(
      (item) => html`<li>
        <details class="shopping-item">
          <summary>
            <span class="shopping-name">${item.name}</span>
            <span class="${item.total === AMOUNT_IN_RECIPE
              ? "shopping-total is-unstated"
              : "shopping-total"}"
              >${item.total}</span
            >
          </summary>
          <ul class="shopping-from">
            ${item.contributions.map(
              (one) => html`<li>
                <span class="shopping-from-what"
                  >${one.batchTitle}${one.partTitle === null
                    ? ""
                    : ` · ${one.partTitle}`}</span
                >
                <span class="shopping-from-amount"
                  >${one.amount === "" ? AMOUNT_IN_RECIPE : one.amount}</span
                >
                ${one.sourceLine === ""
                  ? ""
                  : html`<span class="source">${one.sourceLine}</span>`}
              </li>`,
            )}
          </ul>
          ${pantryButton(item, selectedIds, inPantry)}
        </details>
      </li>`,
    )}
  </ul>`;
}

/**
 * The one thing a shopping-list row can be told: we always have this, or we
 * have run out of it. It sits inside the opened row rather than on the summary
 * line, because the summary is what somebody reads while shopping and a button
 * per line would compete with the amounts.
 */
function pantryButton(
  item: ShoppingItem,
  selectedIds: Set<number>,
  inPantry: boolean,
): Raw {
  return html`<form
    method="post"
    action="/ostoslista/kaappi"
    class="inline pantry-action"
  >
    <input type="hidden" name="aines" value="${item.ingredientId}" />
    ${inPantry
      ? html`<input type="hidden" name="toiminto" value="poista" />`
      : ""}
    ${[...selectedIds].map(
      (id) => html`<input type="hidden" name="${CHOICE}" value="${id}" />`,
    )}
    <button type="submit">
      ${inPantry ? "Poista kaapista" : "Löytyy jo kaapista"}
    </button>
  </form>`;
}
