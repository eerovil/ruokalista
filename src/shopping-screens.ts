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
import { formatMultiplier } from "./scaling.ts";
import { SOstoslistaClient, type SOstoslistaProduct } from "./s-ostoslista.ts";
import {
  AMOUNT_IN_RECIPE,
  saveExternalProduct,
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
  ctx: RouteContext,
  member: Member,
  refused: string | null = null,
  notice: string | null = null,
  status = refused === null ? 200 : 400,
): Promise<Response> {
  const { env, url } = ctx;
  const state = await shoppingState(ctx, member);
  const { cookings, selectedIds, selected, buy, atHome } = state;
  const external = externalClient(env, member) !== null;
  const heading = headingFor(selected);

  return page(
    heading,
    html`<h1>${heading}</h1>
      ${picker(cookings, selectedIds)}
      ${refused === null ? "" : html`<p class="refused">${refused}</p>`}
      ${notice === null ? "" : html`<p class="shopping-sent">${notice}</p>`}
      ${cookings.length === 0
        ? html`<div class="nothing">
            <p class="empty">Seuraavan kahden viikon aikana ei kokata mitään.</p>
            <p><a class="button" href="/">Suunnittele viikko</a></p>
          </div>`
        : selected.length === 0
          ? html`<p class="empty">
              Valitse ainakin yksi ateria, niin ainekset lasketaan yhteen.
            </p>`
          : html`${externalSendPanel(buy, selectedIds, external)}
              ${sections(buy, atHome, selectedIds, external)}`}`,
    "shopping",
    member,
    status,
  );
}

interface ShoppingState {
  cookings: PlannedBatch[];
  selectedIds: Set<number>;
  selected: PlannedBatch[];
  buy: ShoppingItem[];
  atHome: ShoppingItem[];
}

/** Recompute every mutation target from this household's current week + pantry. */
async function shoppingState(
  { env, url }: RouteContext,
  member: Member,
): Promise<ShoppingState> {
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
  return { cookings, selectedIds, selected, buy, atHome };
}

/** `POST /ostoslista/laheta` — only the freshly recomputed `Ostettavat`. */
export async function sendShoppingListForm(
  ctx: RouteContext,
  member: Member,
): Promise<Response> {
  const client = externalClient(ctx.env, member);
  if (client === null) return new Response("Not found", { status: 404 });

  const form = await ctx.request.formData();
  const selectedUrl = selectionUrl(form, ctx.url);
  const stateCtx = { ...ctx, url: selectedUrl };
  const { buy } = await shoppingState(stateCtx, member);
  if (buy.length === 0) {
    return shoppingScreen(
      stateCtx,
      member,
      "Ostoslistalla ei ole lähetettäviä aineksia.",
    );
  }

  let sent = 0;
  try {
    for (const item of buy) {
      if (item.ean === null) {
        await client.add({ note: `${item.name} — ${item.total}` });
      } else {
        // The selected EAN identifies the product. A recipe amount is not a
        // package count, so no quantity is sent (#147's explicit boundary).
        await client.add({ ean: item.ean });
      }
      sent += 1;
    }
  } catch (error) {
    console.error(`S-ostoslista send failed: ${reason(error)}`);
    const progress = sent === 0
      ? "Mitään ei lähetetty."
      : `${sent}/${buy.length} ainesta ehdittiin lähettää. Uudelleen yrittäminen on turvallista.`;
    return shoppingScreen(
      stateCtx,
      member,
      `S-ostoslistaan ei saatu lähetettyä kaikkea. ${progress}`,
      null,
      502,
    );
  }

  return shoppingScreen(
    stateCtx,
    member,
    null,
    `${sent} ainesta lähetettiin S-ostoslistaan.`,
  );
}

/** `GET /ostoslista/tuote` — search and choose a product for one buy row. */
export async function productSearchScreen(
  ctx: RouteContext,
  member: Member,
): Promise<Response> {
  const client = externalClient(ctx.env, member);
  if (client === null) return new Response("Not found", { status: 404 });
  const state = await shoppingState(ctx, member);
  const item = selectedBuyItem(state.buy, ctx.url.searchParams.get("aines"));
  if (item === null) return new Response("Not found", { status: 404 });

  const query = (ctx.url.searchParams.get("haku") ?? item.name).trim();
  let products: SOstoslistaProduct[] = [];
  let refused: string | null = null;
  let status = 200;
  try {
    products = await client.search(query);
  } catch (error) {
    console.error(`S-ostoslista product search failed: ${reason(error)}`);
    refused = "S-ostoslistan tuotehakua ei saatu avattua. Yritä uudelleen.";
    status = 502;
  }
  return productPage(member, item, state.selectedIds, query, products, refused, status);
}

/** Re-search on selection so product metadata is never trusted from the form. */
export async function saveProductForm(
  ctx: RouteContext,
  member: Member,
): Promise<Response> {
  const client = externalClient(ctx.env, member);
  if (client === null) return new Response("Not found", { status: 404 });

  const form = await ctx.request.formData();
  const stateCtx = { ...ctx, url: productSelectionUrl(form, ctx.url) };
  const state = await shoppingState(stateCtx, member);
  const item = selectedBuyItem(state.buy, form.get("aines"));
  if (item === null) return new Response("Not found", { status: 404 });

  const query = String(form.get("haku") ?? "").trim();
  const ean = String(form.get("ean") ?? "").trim();
  let products: SOstoslistaProduct[];
  try {
    products = await client.search(query);
  } catch (error) {
    console.error(`S-ostoslista product selection search failed: ${reason(error)}`);
    return productPage(
      member,
      item,
      state.selectedIds,
      query,
      [],
      "Tuotetta ei voitu varmistaa S-ostoslistasta. Mitään ei tallennettu.",
      502,
    );
  }

  const selected = products.find((product) => product.ean === ean);
  if (selected === undefined) {
    return productPage(
      member,
      item,
      state.selectedIds,
      query,
      products,
      "Valittua tuotetta ei löytynyt uudesta hausta. Mitään ei tallennettu.",
      400,
    );
  }
  if (!(await saveExternalProduct(ctx.env.DB, item.ingredientId, selected))) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(null, {
    status: 303,
    headers: { Location: `/ostoslista?${selectionQueryFromIds(state.selectedIds)}` },
  });
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

function selectionUrl(form: FormData, base: URL): URL {
  return new URL(`/ostoslista?${selectionQuery(form)}`, base);
}

function productSelectionUrl(form: FormData, base: URL): URL {
  const url = selectionUrl(form, base);
  const ingredientId = Number(form.get("aines"));
  if (Number.isSafeInteger(ingredientId)) {
    url.searchParams.set("aines", String(ingredientId));
  }
  const query = String(form.get("haku") ?? "").trim();
  if (query !== "") url.searchParams.set("haku", query);
  return url;
}

function selectionQueryFromIds(selectedIds: Set<number>): string {
  const query = new URLSearchParams({ [CHOSEN]: "1" });
  for (const id of selectedIds) query.append(CHOICE, String(id));
  return query.toString();
}

function selectionFields(selectedIds: Set<number>): Raw {
  return html`<input type="hidden" name="${CHOSEN}" value="1" />
    ${[...selectedIds].map(
      (id) => html`<input type="hidden" name="${CHOICE}" value="${id}" />`,
    )}`;
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
                  · ${formatMultiplier(batch.multiplier)}</span
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
  external: boolean,
): Raw {
  // With nothing in the cupboard there is only one list, and a lone
  // "Ostettavat" heading under a heading that already says Ostoslista is a
  // word for its own sake.
  if (atHome.length === 0) return itemList(buy, selectedIds, false, external);

  return html`<h2 class="shopping-section">Ostettavat</h2>
    ${buy.length === 0
      ? html`<p class="empty">Kaikki tarvittava löytyy jo kaapista.</p>`
      : itemList(buy, selectedIds, false, external)}
    <h2 class="shopping-section">Löytyy</h2>
    <p class="empty">
      Näitä valitut ateriat tarvitsevat, mutta ne ovat jo
      <a href="/kaappi">kaapissa</a>.
    </p>
    ${itemList(atHome, selectedIds, true, external)}`;
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
  external: boolean,
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
          ${externalProductBlock(item, selectedIds, inPantry, external)}
          ${pantryButton(item, selectedIds, inPantry)}
        </details>
      </li>`,
    )}
  </ul>`;
}

function externalSendPanel(
  buy: ShoppingItem[],
  selectedIds: Set<number>,
  external: boolean,
): Raw {
  if (!external || buy.length === 0) return html``;
  const mapped = buy.filter((item) => item.ean !== null).length;
  const notes = buy.length - mapped;
  return html`<section class="s-shopping-send" aria-labelledby="s-shopping-title">
    <h2 id="s-shopping-title">S-ostoslista</h2>
    <p>
      ${mapped} ${mapped === 1 ? "tuote" : "tuotetta"}${notes === 0
        ? ""
        : ` · ${notes} ${notes === 1 ? "muistutus" : "muistutusta"}`}
    </p>
    <form method="post" action="/ostoslista/laheta">
      ${selectionFields(selectedIds)}
      <button type="submit" class="primary">Lähetä S-ostoslistaan</button>
    </form>
  </section>`;
}

function externalProductBlock(
  item: ShoppingItem,
  selectedIds: Set<number>,
  inPantry: boolean,
  external: boolean,
): Raw {
  if (!external) return html``;

  const mapped = item.ean !== null && item.externalProductName !== null;
  if (inPantry) {
    return mapped
      ? productSummary(item)
      : html``;
  }

  return html`<div class="s-shopping-product ${mapped ? "is-mapped" : "is-note"}">
    ${mapped
      ? productSummary(item)
      : html`<div class="s-shopping-product-copy">
          <strong>Muistutus</strong>
          <span class="meta">Lähetetään tekstinä: ${item.name} — ${item.total}</span>
        </div>`}
    <form method="get" action="/ostoslista/tuote" class="inline">
      <input type="hidden" name="aines" value="${item.ingredientId}" />
      <input type="hidden" name="haku" value="${item.name}" />
      ${selectionFields(selectedIds)}
      <button type="submit">${mapped ? "Vaihda tuote" : "Valitse tuote"}</button>
    </form>
  </div>`;
}

function productSummary(item: ShoppingItem): Raw {
  return html`<div class="s-shopping-product-summary">
    ${item.externalProductImageUrl === null
      ? ""
      : html`<img
          src="${item.externalProductImageUrl}"
          alt=""
          width="64"
          height="64"
          loading="lazy"
          onerror="this.hidden=true"
        />`}
    <span class="s-shopping-product-copy">
      <strong>${item.externalProductName ?? item.ean}</strong>
      <span class="meta">EAN ${item.ean}</span>
    </span>
  </div>`;
}

function productPage(
  member: Member,
  item: ShoppingItem,
  selectedIds: Set<number>,
  query: string,
  products: SOstoslistaProduct[],
  refused: string | null,
  status: number,
): Response {
  const back = `/ostoslista?${selectionQueryFromIds(selectedIds)}`;
  return page(
    `Valitse tuote: ${item.name}`,
    html`<p><a href="${back}">← Takaisin ostoslistaan</a></p>
      <h1>Valitse tuote: ${item.name}</h1>
      ${refused === null ? "" : html`<p class="refused">${refused}</p>`}
      <form method="get" action="/ostoslista/tuote" class="stacked product-search-form">
        <input type="hidden" name="aines" value="${item.ingredientId}" />
        ${selectionFields(selectedIds)}
        <label>
          Haku
          <input type="search" name="haku" value="${query}" required />
        </label>
        <button type="submit" class="primary">Hae tuotteita</button>
      </form>
      ${products.length === 0 && refused === null
        ? html`<p class="empty">Haulla ei löytynyt tuotteita.</p>`
        : productResults(item, selectedIds, query, products)}`,
    "shopping",
    member,
    status,
  );
}

function productResults(
  item: ShoppingItem,
  selectedIds: Set<number>,
  query: string,
  products: SOstoslistaProduct[],
): Raw {
  return html`<ul class="s-product-results">
    ${products.map(
      (product) => html`<li>
        <img
          src="${product.imageUrl}"
          alt=""
          width="80"
          height="80"
          loading="lazy"
          onerror="this.hidden=true"
        />
        <div class="s-product-result-copy">
          <strong>${product.name}</strong>
          <span class="meta">EAN ${product.ean}</span>
          ${product.price === null
            ? ""
            : html`<span class="meta"
                >${product.price.toLocaleString("fi-FI", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })} €${product.priceUnit === null
                  ? ""
                  : ` / ${product.priceUnit.toLocaleLowerCase("fi-FI")}`}</span
              >`}
          ${product.available === false
            ? html`<span class="meta">Ei saatavilla valitussa kaupassa</span>`
            : ""}
        </div>
        <form method="post" action="/ostoslista/tuote">
          <input type="hidden" name="aines" value="${item.ingredientId}" />
          <input type="hidden" name="haku" value="${query}" />
          <input type="hidden" name="ean" value="${product.ean}" />
          ${selectionFields(selectedIds)}
          <button type="submit" class="primary">Valitse</button>
        </form>
      </li>`,
    )}
  </ul>`;
}

function selectedBuyItem(
  buy: ShoppingItem[],
  rawId: FormDataEntryValue | string | null,
): ShoppingItem | null {
  const ingredientId = Number(rawId);
  if (!Number.isSafeInteger(ingredientId)) return null;
  return buy.find((item) => item.ingredientId === ingredientId) ?? null;
}

/**
 * A URL means "call the service over HTTP", which is how the browser tests
 * reach their fixture. Otherwise the bound Worker is the transport, and the
 * base URL only has to be a valid absolute URL for the client to resolve paths
 * against — the binding decides where the request actually goes, so the
 * hostname below is never resolved.
 */
const BOUND_SERVICE_BASE = "https://s-ostoslista-worker.invalid/";

function externalClient(env: RouteContext["env"], member: Member): SOstoslistaClient | null {
  const householdId = Number(env.SOSTOSLISTA_HOUSEHOLD_ID);
  if (!Number.isSafeInteger(householdId) || householdId !== member.householdId) {
    return null;
  }
  if (!env.SOSTOSLISTA_API_TOKEN) return null;
  const overrideUrl = env.SOSTOSLISTA_SERVICE_URL;
  const service = env.SOSTOSLISTA_SERVICE;
  if (!overrideUrl && !service) return null;
  try {
    return new SOstoslistaClient(
      overrideUrl || BOUND_SERVICE_BASE,
      env.SOSTOSLISTA_API_TOKEN,
      overrideUrl || !service
        ? undefined
        : (input, init) => service.fetch(input as RequestInfo, init),
    );
  } catch (error) {
    console.error(`S-ostoslista configuration is invalid: ${reason(error)}`);
    return null;
  }
}

/**
 * Workers Logs keeps a thrown Error's stack but not its message, so passing the
 * error as a second argument to console.error loses the one line that says what
 * went wrong. Interpolating it is what makes a failure diagnosable from the log.
 */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
