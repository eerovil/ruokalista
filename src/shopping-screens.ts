import { problem } from "./auth.ts";
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
 *
 * Issue #159 proposes making the S-ostoslista half of the screen feel
 * immediate, and it is added strictly on top of that: every form below is still
 * the form it was, and a browser that cannot run `SHOPPING_ISLAND` still
 * navigates to `/ostoslista/tuote`, still posts the send form, and simply never
 * sees the current S-ostoslista panel. What the island adds is the product
 * search in a panel inside the row, an optimistic selection saved in the
 * background, a spinner on everything asynchronous, and the contents of the
 * S-ostoslista read after the page is already usable. It talks to the three
 * JSON answers below, and the save still re-searches server-side, so the
 * browser cannot invent an EAN, a name or an image whichever path it takes.
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
              ${sections(buy, atHome, selectedIds, external)}`}
      ${external ? html`<script>${raw(SHOPPING_ISLAND)}</script>` : ""}`,
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
  const asJson = wantsJson(form);
  const { buy } = await shoppingState(stateCtx, member);
  if (buy.length === 0) {
    const empty = "Ostoslistalla ei ole lähetettäviä aineksia.";
    return asJson
      ? problem(400, empty)
      : shoppingScreen(stateCtx, member, empty);
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
    const message = `S-ostoslistaan ei saatu lähetettyä kaikkea. ${progress}`;
    return asJson
      ? problem(502, message)
      : shoppingScreen(stateCtx, member, message, null, 502);
  }

  if (asJson) return Response.json({ sent, total: buy.length });
  return shoppingScreen(
    stateCtx,
    member,
    null,
    `${sent} ainesta lähetettiin S-ostoslistaan.`,
  );
}

/**
 * `GET /ostoslista/haku?haku=…` — the same catalogue search the product screen
 * runs, as JSON, so the island can search inside the row and warm the next
 * row's search before anybody asks for it.
 *
 * It answers with the query it actually ran, which is what lets the browser
 * throw away an answer that arrived for a term the member has already moved on
 * from. Nothing household-scoped is read or written here: the catalogue is the
 * shop's, and the only gate is that this household has the integration at all.
 */
export async function productSearchJson(
  ctx: RouteContext,
  member: Member,
): Promise<Response> {
  const client = externalClient(ctx.env, member);
  if (client === null) return new Response("Not found", { status: 404 });

  const query = (ctx.url.searchParams.get("haku") ?? "").trim();
  if (query === "") return problem(400, "Hakusana puuttuu.");

  try {
    return Response.json({ query, results: await client.search(query) });
  } catch (error) {
    console.error(`S-ostoslista product search failed: ${reason(error)}`);
    return problem(502, "S-ostoslistan tuotehakua ei saatu avattua. Yritä uudelleen.");
  }
}

/**
 * `GET /ostoslista/s-lista` — what is already on the S-ostoslista.
 *
 * Read after the screen is drawn rather than while it is being built (#159):
 * the household's own list is the thing somebody came here for, and a slow or
 * broken external read must not hold it up or take it down. A failure is one
 * line and a retry in the browser, not a refusal of the screen.
 */
export async function currentListJson(
  ctx: RouteContext,
  member: Member,
): Promise<Response> {
  const client = externalClient(ctx.env, member);
  if (client === null) return new Response("Not found", { status: 404 });

  try {
    return Response.json({ items: await client.list() });
  } catch (error) {
    console.error(`S-ostoslista list read failed: ${reason(error)}`);
    return problem(502, "S-ostoslistan sisältöä ei saatu luettua.");
  }
}

/** The island asks for JSON with a field, so one route serves both callers. */
function wantsJson(form: FormData): boolean {
  return String(form.get("muoto") ?? "") === "json";
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
  const asJson = wantsJson(form);
  const stateCtx = { ...ctx, url: productSelectionUrl(form, ctx.url) };
  const state = await shoppingState(stateCtx, member);
  const item = selectedBuyItem(state.buy, form.get("aines"));
  if (item === null) return new Response("Not found", { status: 404 });

  const query = String(form.get("haku") ?? "").trim();
  const ean = String(form.get("ean") ?? "").trim();

  /**
   * The island shows the choice before this answer arrives, so a refusal has to
   * be sayable to it. Both callers get the same words and the same status; only
   * the shape differs, and neither one has saved anything by this point.
   */
  const refuse = (
    message: string,
    status: number,
    products: SOstoslistaProduct[],
  ): Response =>
    asJson
      ? problem(status, message)
      : productPage(member, item, state.selectedIds, query, products, message, status);

  let products: SOstoslistaProduct[];
  try {
    products = await client.search(query);
  } catch (error) {
    console.error(`S-ostoslista product selection search failed: ${reason(error)}`);
    return refuse(
      "Tuotetta ei voitu varmistaa S-ostoslistasta. Mitään ei tallennettu.",
      502,
      [],
    );
  }

  const selected = products.find((product) => product.ean === ean);
  if (selected === undefined) {
    return refuse(
      "Valittua tuotetta ei löytynyt uudesta hausta. Mitään ei tallennettu.",
      400,
      products,
    );
  }
  if (!(await saveExternalProduct(ctx.env.DB, item.ingredientId, selected))) {
    return new Response("Not found", { status: 404 });
  }

  // The confirmed product, not the one the browser drew: a re-search may have
  // found a newer name, and the row should end up saying what was stored.
  if (asJson) {
    return Response.json({
      product: {
        ean: selected.ean,
        name: selected.name,
        imageUrl: selected.imageUrl,
      },
    });
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
        <details
          class="shopping-item"
          data-aines="${item.ingredientId}"
          data-haku="${item.name}"
        >
          <summary>
            <span class="shopping-thumb">${thumbnail(item)}</span>
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

/**
 * The chosen product's picture on the row itself (#159), small enough that the
 * row it sits in is the height it always was. Without a picture the slot stays
 * empty and collapses, so an unmapped ingredient — or one whose CDN image is
 * missing — reads exactly as it did before rather than as a broken box.
 */
function thumbnail(item: ShoppingItem): Raw {
  if (item.externalProductImageUrl === null) return html``;
  return html`<img
    src="${item.externalProductImageUrl}"
    alt=""
    width="26"
    height="26"
    loading="lazy"
    onerror="this.hidden=true"
  />`;
}

function externalSendPanel(
  buy: ShoppingItem[],
  selectedIds: Set<number>,
  external: boolean,
): Raw {
  if (!external) return html``;
  const mapped = buy.filter((item) => item.ean !== null).length;
  const notes = buy.length - mapped;
  return html`<section class="s-shopping-send" aria-labelledby="s-shopping-title">
    <h2 id="s-shopping-title">S-ostoslista</h2>
    ${buy.length === 0
      ? ""
      : html`<p class="s-send-counts" data-tuotteet="${mapped}" data-muistutukset="${notes}">
            ${mapped} ${mapped === 1 ? "tuote" : "tuotetta"}${notes === 0
              ? ""
              : ` · ${notes} ${notes === 1 ? "muistutus" : "muistutusta"}`}
          </p>
          <form method="post" action="/ostoslista/laheta" class="s-send-form">
            ${selectionFields(selectedIds)}
            <button type="submit" class="primary">Lähetä S-ostoslistaan</button>
          </form>`}
    ${currentListPanel()}
  </section>`;
}

/**
 * What the S-ostoslista already holds, filled in by the island.
 *
 * It ships hidden and empty on purpose. The contents are an external read, and
 * #159 asks for them without letting them delay — or break — the household's
 * own list, so they arrive after the screen does. A browser that runs nothing
 * simply never sees this block, which is the same bargain every other
 * enhancement on this screen makes.
 */
function currentListPanel(): Raw {
  return html`<div class="s-current" hidden>
    <h3>S-ostoslistalla nyt</h3>
    <p class="s-current-state"></p>
    <ul class="s-current-items"></ul>
  </div>`;
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

  // The body is one container the island can replace wholesale when a choice is
  // made, so an optimistic row and a server-rendered one are the same markup.
  return html`<div class="s-shopping-product ${mapped ? "is-mapped" : "is-note"}">
    <div class="s-shopping-product-body">
      ${mapped
        ? productSummary(item)
        : html`<div class="s-shopping-product-copy">
            <strong>Muistutus</strong>
            <span class="meta">Lähetetään tekstinä: ${item.name} — ${item.total}</span>
          </div>`}
    </div>
    <form method="get" action="/ostoslista/tuote" class="inline s-product-open">
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
 * Everything #159 asks the browser to do, in one island.
 *
 * Written in ES5 with no regular expressions, like the other three islands —
 * it is a template literal shipped untranspiled, see
 * `docs/codebase/screens.md`. It builds every node with `createElement` and
 * `createTextNode` rather than by pasting strings together, so a product name
 * from the shop cannot become markup.
 *
 * Four things it is careful about:
 *
 *   - **A search answer is bound to its question.** The cache is keyed by the
 *     search term and the server echoes the term it ran, so a prefetched answer
 *     for the next ingredient can never be drawn into the row a member is
 *     looking at.
 *   - **A save is optimistic but never silent.** The row shows the choice and
 *     the panel closes at once; a spinner says the save is still going, and a
 *     failure puts the row back the way it was with the refusal and a retry.
 *   - **One at a time.** A row that is saving ignores a second choice, and the
 *     send button refuses a second press until the first has answered.
 *   - **A failure is not cached.** An error clears its cache entry, so the next
 *     attempt really asks again.
 */
const SHOPPING_ISLAND = `
(function () {
  if (
    !window.XMLHttpRequest || !window.JSON ||
    typeof document.querySelectorAll !== 'function' ||
    typeof document.addEventListener !== 'function'
  ) return;

  var rows = [];
  var sending = false;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (typeof text === 'string') node.appendChild(document.createTextNode(text));
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function spinner() {
    var node = el('span', 'spinner');
    node.setAttribute('aria-hidden', 'true');
    return node;
  }

  function busy(node, text) {
    clear(node);
    node.appendChild(spinner());
    node.appendChild(document.createTextNode(text));
  }

  function request(method, url, body, done) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.setRequestHeader('accept', 'application/json');
    if (body !== null) {
      xhr.setRequestHeader('content-type', 'application/x-www-form-urlencoded');
    }
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var payload = null;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch (error) {
        payload = null;
      }
      done(xhr.status >= 200 && xhr.status < 300, payload);
    };
    xhr.send(body);
  }

  function fieldsOf(form, extra, skip) {
    var parts = [];
    var fields = form.elements;
    for (var index = 0; index < fields.length; index += 1) {
      var field = fields[index];
      if (!field.name || field.disabled) continue;
      if (skip && skip[field.name]) continue;
      if (field.type === 'submit' || field.type === 'button') continue;
      if ((field.type === 'checkbox' || field.type === 'radio') && !field.checked) {
        continue;
      }
      parts.push(
        encodeURIComponent(field.name) + '=' + encodeURIComponent(field.value)
      );
    }
    for (var key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) {
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(extra[key]));
      }
    }
    return parts.join('&');
  }

  // ------------------------------------------------ searches, kept by term

  var searches = {};

  function search(query, callback) {
    var key = 'q:' + query;
    var entry = searches[key];
    if (entry && entry.done) {
      if (callback) callback(entry.ok, entry.payload);
      return;
    }
    if (entry) {
      if (callback) entry.waiting.push(callback);
      return;
    }
    entry = { done: false, ok: false, payload: null, waiting: [] };
    if (callback) entry.waiting.push(callback);
    searches[key] = entry;
    request(
      'GET',
      '/ostoslista/haku?haku=' + encodeURIComponent(query),
      null,
      function (ok, payload) {
        entry.done = true;
        entry.ok = ok;
        entry.payload = payload;
        if (!ok) searches[key] = null;
        var waiting = entry.waiting;
        entry.waiting = [];
        for (var index = 0; index < waiting.length; index += 1) {
          waiting[index](ok, payload);
        }
      }
    );
  }

  // ------------------------------------------------------------- the rows

  function collect() {
    var items = document.querySelectorAll('.shopping-item[data-aines]');
    for (var index = 0; index < items.length; index += 1) {
      var details = items[index];
      var block = details.querySelector('.s-shopping-product');
      var opener = block ? block.querySelector('form.s-product-open') : null;
      if (!block || !opener) continue;
      rows.push({
        details: details,
        block: block,
        body: block.querySelector('.s-shopping-product-body'),
        thumb: details.querySelector('.shopping-thumb'),
        opener: opener,
        name: details.getAttribute('data-haku') || '',
        query: details.getAttribute('data-haku') || '',
        panel: null,
        results: null,
        state: null,
        status: null,
        error: null,
        saving: false
      });
    }
  }

  function productImage(url, size) {
    var image = document.createElement('img');
    image.setAttribute('alt', '');
    image.setAttribute('width', String(size));
    image.setAttribute('height', String(size));
    image.onerror = function () { this.hidden = true; };
    image.src = url;
    return image;
  }

  function price(product) {
    if (typeof product.price !== 'number') return null;
    var text = product.price.toFixed(2).split('.').join(',') + ' euroa';
    if (typeof product.priceUnit === 'string' && product.priceUnit !== '') {
      text += ' / ' + product.priceUnit.toLowerCase();
    }
    return text;
  }

  // --------------------------------------------------------- the row's panel

  function panelFor(row) {
    if (row.panel) return row.panel;

    var panel = el('div', 's-product-panel');
    var form = el('form', 's-product-search');
    var label = el('label', '', 'Haku ');
    var input = document.createElement('input');
    input.type = 'search';
    input.name = 'haku';
    input.value = row.query;
    label.appendChild(input);
    form.appendChild(label);
    var go = el('button', '', 'Hae');
    go.type = 'submit';
    form.appendChild(go);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var wanted = input.value.trim ? input.value.trim() : input.value;
      if (wanted === '') return;
      row.query = wanted;
      runSearch(row);
    });
    panel.appendChild(form);

    row.state = el('p', 's-product-panel-state', '');
    panel.appendChild(row.state);
    row.results = el('div', 's-product-panel-results');
    panel.appendChild(row.results);

    row.block.parentNode.insertBefore(panel, row.block.nextSibling);
    row.panel = panel;
    return panel;
  }

  function openPanel(row) {
    panelFor(row).hidden = false;
    runSearch(row);
    prefetchNext(row);
  }

  function closePanel(row) {
    if (row.panel) row.panel.hidden = true;
  }

  function say(row, text, working) {
    if (working) busy(row.state, text);
    else {
      clear(row.state);
      row.state.appendChild(document.createTextNode(text));
    }
    row.state.hidden = false;
  }

  function runSearch(row) {
    var query = row.query;
    clear(row.results);
    say(row, 'Haetaan tuotteita…', true);
    search(query, function (ok, payload) {
      // Two guards, and both matter: the row may have moved on to another
      // term, and an answer only counts for the term the server says it ran.
      if (row.query !== query) return;
      if (!ok || !payload || !payload.results) {
        say(
          row,
          (payload && payload.error) ||
            'S-ostoslistan tuotehakua ei saatu avattua. Yritä uudelleen.',
          false
        );
        return;
      }
      if (payload.query !== query) return;
      if (payload.results.length === 0) {
        say(row, 'Haulla ei löytynyt tuotteita.', false);
        return;
      }
      clear(row.state);
      row.state.hidden = true;
      showResults(row, query, payload.results);
    });
  }

  function showResults(row, query, results) {
    clear(row.results);
    var list = el('ul', 's-product-results');
    for (var index = 0; index < results.length; index += 1) {
      list.appendChild(resultRow(row, query, results[index]));
    }
    row.results.appendChild(list);
  }

  function resultRow(row, query, product) {
    var item = document.createElement('li');
    item.appendChild(productImage(product.imageUrl, 80));
    var copy = el('div', 's-product-result-copy');
    copy.appendChild(el('strong', '', product.name));
    copy.appendChild(el('span', 'meta', 'EAN ' + product.ean));
    var priceText = price(product);
    if (priceText) copy.appendChild(el('span', 'meta', priceText));
    if (product.available === false) {
      copy.appendChild(el('span', 'meta', 'Ei saatavilla valitussa kaupassa'));
    }
    item.appendChild(copy);
    var choose = el('button', 'primary', 'Valitse');
    choose.type = 'button';
    choose.addEventListener('click', function () {
      chooseProduct(row, query, product);
    });
    item.appendChild(choose);
    return item;
  }

  function prefetchNext(row) {
    for (var index = 0; index < rows.length; index += 1) {
      if (rows[index] !== row) continue;
      var next = rows[index + 1];
      if (next && next.name !== '') search(next.name, null);
      return;
    }
  }

  // ------------------------------------------------- choosing, optimistically

  function chooseProduct(row, query, product) {
    if (row.saving) return;
    closePanel(row);
    // Everything the optimistic draw touches, kept so a refusal can put the row
    // back exactly as the server still has it.
    var before = {
      body: row.body.innerHTML,
      thumb: row.thumb ? row.thumb.innerHTML : null,
      blockClass: row.block.className,
      openLabel: openerLabel(row)
    };
    showProduct(row, product);
    persist(row, query, product, before);
  }

  function openerLabel(row) {
    var button = row.opener.querySelector('button');
    return button ? button.innerHTML : null;
  }

  function setOpenerLabel(row, text) {
    var button = row.opener.querySelector('button');
    if (!button) return;
    clear(button);
    button.appendChild(document.createTextNode(text));
  }

  function restore(row, before) {
    row.body.innerHTML = before.body;
    if (row.thumb && before.thumb !== null) row.thumb.innerHTML = before.thumb;
    row.block.className = before.blockClass;
    var button = row.opener.querySelector('button');
    if (button && before.openLabel !== null) button.innerHTML = before.openLabel;
  }

  function persist(row, query, product, before) {
    row.saving = true;
    clearError(row);
    status(row, 'Tallennetaan…');
    var body = fieldsOf(
      row.opener,
      { haku: query, ean: product.ean, muoto: 'json' },
      { haku: 1 }
    );
    request('POST', '/ostoslista/tuote', body, function (ok, payload) {
      row.saving = false;
      status(row, null);
      if (ok && payload && payload.product) {
        showProduct(row, payload.product);
        // An ingredient that was going as a note is going as a product now, and
        // the line above the send button says how many of each there are.
        if (before.blockClass.indexOf('is-note') !== -1) countProduct();
        return;
      }
      restore(row, before);
      showError(
        row,
        (payload && payload.error) || 'Tuotteen tallennus epäonnistui.',
        function () {
          showProduct(row, product);
          persist(row, query, product, before);
        }
      );
    });
  }

  function showProduct(row, product) {
    row.block.className = 's-shopping-product is-mapped';

    clear(row.body);
    var summary = el('div', 's-shopping-product-summary');
    summary.appendChild(productImage(product.imageUrl, 64));
    var copy = el('span', 's-shopping-product-copy');
    copy.appendChild(el('strong', '', product.name));
    copy.appendChild(el('span', 'meta', 'EAN ' + product.ean));
    summary.appendChild(copy);
    row.body.appendChild(summary);

    if (row.thumb) {
      clear(row.thumb);
      row.thumb.appendChild(productImage(product.imageUrl, 26));
    }

    setOpenerLabel(row, 'Vaihda tuote');
  }

  function status(row, text) {
    if (text === null) {
      if (row.status && row.status.parentNode) {
        row.status.parentNode.removeChild(row.status);
      }
      row.status = null;
      return;
    }
    if (!row.status) {
      row.status = el('span', 's-status');
      row.status.setAttribute('role', 'status');
      row.block.appendChild(row.status);
    }
    busy(row.status, text);
  }

  function clearError(row) {
    if (row.error && row.error.parentNode) {
      row.error.parentNode.removeChild(row.error);
    }
    row.error = null;
  }

  function showError(row, message, retry) {
    clearError(row);
    row.error = el('p', 's-shopping-error', message + ' ');
    var again = el('button', '', 'Yritä uudelleen');
    again.type = 'button';
    again.addEventListener('click', function () {
      clearError(row);
      retry();
    });
    row.error.appendChild(again);
    row.block.parentNode.insertBefore(row.error, row.block.nextSibling);
  }

  function countProduct() {
    var line = document.querySelector('.s-send-counts');
    if (!line) return;
    var products = Number(line.getAttribute('data-tuotteet')) + 1;
    var notes = Number(line.getAttribute('data-muistutukset')) - 1;
    if (notes < 0) return;
    line.setAttribute('data-tuotteet', String(products));
    line.setAttribute('data-muistutukset', String(notes));
    var text = products + (products === 1 ? ' tuote' : ' tuotetta');
    if (notes > 0) {
      text += ' · ' + notes + (notes === 1 ? ' muistutus' : ' muistutusta');
    }
    clear(line);
    line.appendChild(document.createTextNode(text));
  }

  // ------------------------------------------------------------- the sending

  function wireSend() {
    var form = document.querySelector('.s-shopping-send form.s-send-form');
    if (!form) return;
    var button = form.querySelector('button');
    if (!button) return;

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (sending) return;
      sending = true;
      var label = button.innerHTML;
      button.disabled = true;
      busy(button, 'Lähetetään…');
      note(null, null);
      request(
        'POST',
        '/ostoslista/laheta',
        fieldsOf(form, { muoto: 'json' }, null),
        function (ok, payload) {
          sending = false;
          button.disabled = false;
          button.innerHTML = label;
          if (ok && payload && typeof payload.sent === 'number') {
            note(
              'shopping-sent',
              payload.sent + ' ainesta lähetettiin S-ostoslistaan.'
            );
            loadCurrent();
            return;
          }
          note(
            'refused',
            (payload && payload.error) ||
              'S-ostoslistaan ei saatu lähetettyä kaikkea.'
          );
        }
      );
    });
  }

  var sendNote = null;

  function note(className, text) {
    if (sendNote && sendNote.parentNode) sendNote.parentNode.removeChild(sendNote);
    sendNote = null;
    if (className === null) return;
    var panel = document.querySelector('.s-shopping-send');
    if (!panel) return;
    sendNote = el('p', className, text);
    panel.appendChild(sendNote);
  }

  // --------------------------------------------- what the S list already has

  function loadCurrent() {
    var panel = document.querySelector('.s-current');
    if (!panel) return;
    var state = panel.querySelector('.s-current-state');
    var list = panel.querySelector('.s-current-items');
    panel.hidden = false;
    clear(list);
    state.hidden = false;
    busy(state, 'Luetaan S-ostoslistaa…');

    request('GET', '/ostoslista/s-lista', null, function (ok, payload) {
      clear(state);
      if (!ok || !payload || !payload.items) {
        state.appendChild(
          document.createTextNode(
            ((payload && payload.error) ||
              'S-ostoslistan sisältöä ei saatu luettua.') + ' '
          )
        );
        var again = el('button', '', 'Yritä uudelleen');
        again.type = 'button';
        again.addEventListener('click', loadCurrent);
        state.appendChild(again);
        return;
      }
      var items = payload.items;
      if (items.length === 0) {
        state.appendChild(document.createTextNode('S-ostoslista on vielä tyhjä.'));
        return;
      }
      state.hidden = true;
      for (var index = 0; index < items.length; index += 1) {
        var entry = document.createElement('li');
        entry.className = items[index].ean ? 's-current-product' : 's-current-note';
        entry.appendChild(el('span', 's-current-name', items[index].name));
        entry.appendChild(
          el('span', 'meta', items[index].ean ? 'Tuote' : 'Muistutus')
        );
        list.appendChild(entry);
      }
    });
  }

  // ------------------------------------------------------------------ wiring

  collect();
  for (var index = 0; index < rows.length; index += 1) {
    (function (row) {
      row.opener.addEventListener('submit', function (event) {
        event.preventDefault();
        if (row.panel && !row.panel.hidden) {
          closePanel(row);
          return;
        }
        openPanel(row);
      });
    })(rows[index]);
  }
  wireSend();
  loadCurrent();
})();
`;

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
