import { problem } from "./auth.ts";
import shoppingClient from "./generated/shopping.ts";
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
import {
  removeIngredientProduct,
  removeRecipeProduct,
  saveIngredientProduct,
  saveRecipeProduct,
} from "./ingredient-products.ts";
import { baseAmount, packageSizeFromName } from "./packaging.ts";
import { formatDecimal } from "./quantities.ts";
import type { RouteContext } from "./router.ts";
import { formatMultiplier } from "./scaling.ts";
import { sendToSOstoslista } from "./s-ostoslista-sync.ts";
import {
  SOstoslistaClient,
  SOstoslistaError,
  sProductImageAtWidth,
  type SOstoslistaKey,
  type SOstoslistaProduct,
} from "./s-ostoslista.ts";
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
 *
 * Issue #159 proposes making the S-ostoslista half of the screen feel
 * immediate, and it is added strictly on top of that: every form below is still
 * the form it was, and a browser that cannot run the optional shopping client
 * still navigates to `/ostoslista/tuote`, still posts the send form, and simply
 * never sees the current S-ostoslista panel. What the typed shopping client adds
 * is the fixed product sheet, an optimistic selection saved in the background,
 * a spinner on everything asynchronous, and the contents of the
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
              ${sections(buy, atHome, selectedIds, external)}
              ${external ? currentListPanel() : ""}`}
      ${external ? html`<script>${raw(shoppingClient)}</script>` : ""}`,
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

  const outcome = await sendToSOstoslista(
    ctx.env.DB,
    member.householdId,
    client,
    buy,
  );

  if (outcome.status === "partial") {
    console.error(`S-ostoslista send failed: ${reason(outcome.error)}`);
    const progress = outcome.sent === 0
      ? "Mitään ei lähetetty."
      : `${outcome.sent}/${outcome.total} ainesta ehdittiin lähettää. Uudelleen yrittäminen on turvallista.`;
    const message = `S-ostoslistaan ei saatu lähetettyä kaikkea. ${progress}`;
    return asJson
      ? problem(502, message)
      : shoppingScreen(stateCtx, member, message, null, 502);
  }

  if (!outcome.synced) {
    console.error(`S-ostoslista sync failed: ${reason(outcome.syncError)}`);
  }

  const notSynced =
    "Puhelimen S-ostoslistan päivitystä ei saatu käynnistettyä. Ainekset ovat listalla ja päivittyvät viimeistään seuraavassa synkronoinnissa.";

  if (asJson) {
    return Response.json({
      sent: outcome.sent,
      total: outcome.total,
      synced: outcome.synced,
      ...(outcome.synced ? {} : { warning: notSynced }),
    });
  }
  return shoppingScreen(
    stateCtx,
    member,
    outcome.synced ? null : notSynced,
    `${outcome.sent} ainesta lähetettiin S-ostoslistaan.`,
    200,
  );
}

/**
 * `GET /ostoslista/haku?haku=…` — the same catalogue search the product screen
 * runs as JSON, so the typed shopping client can search in its fixed sheet and
 * warm the next row's search before anybody asks for it.
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
    // The package size is read from the name here, once, and travels with the
    // result: the browser must not be the thing that decides what `400 g`
    // means, and the save re-reads it server-side anyway.
    const results = (await client.search(query)).map((product) => {
      const size = packageSizeFromName(product.name);
      return {
        ...product,
        packageQuantity: size?.quantity ?? null,
        packageUnit: size?.unit ?? null,
      };
    });
    return Response.json({ query, results });
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
 *
 * What comes back is only what is still to be bought (#248). The panel's job is
 * to say what is left, and a list that also repeats last week's ticked-off
 * shopping is long enough to stop answering that question. The filter is the
 * service's own `collected` flag and it is applied here rather than in the
 * browser, so nothing on the screen is left guessing from a name which rows
 * were already picked up.
 */
export async function currentListJson(
  ctx: RouteContext,
  member: Member,
): Promise<Response> {
  const client = externalClient(ctx.env, member);
  if (client === null) return new Response("Not found", { status: 404 });

  try {
    const items = (await client.list()).filter((item) => !item.collected);
    return Response.json({ items });
  } catch (error) {
    console.error(`S-ostoslista list read failed: ${reason(error)}`);
    return problem(502, "S-ostoslistan sisältöä ei saatu luettua.");
  }
}

/**
 * `POST /ostoslista/s-lista/poista` — take one row off the S-ostoslista.
 *
 * The panel this serves is drawn by the typed shopping client and exists only
 * where there is a browser to fill it, so there is no screen to re-render on a refusal: the
 * answer is JSON on both paths.
 *
 * The row is named by its own key — the EAN for a product, the text itself for
 * a free-text row — because that is what the service deletes by
 * (`DELETE /items?ean=` / `?note=`); the id it hands out in a listing is not a
 * key it accepts. That also means removing a product removes every copy of it
 * on the list, which is the wanted answer for a panel whose whole point is
 * "this is no longer something we are buying".
 *
 * A row that is not there any more is the wanted state and not a failure, for
 * the same reason it is in the send reconciler: the household may have cleared
 * it on the phone since the panel was drawn, and the member asked for it to be
 * gone.
 */
export async function removeCurrentItemForm(
  ctx: RouteContext,
  member: Member,
): Promise<Response> {
  const client = externalClient(ctx.env, member);
  if (client === null) return new Response("Not found", { status: 404 });

  const form = await ctx.request.formData();
  const ean = String(form.get("ean") ?? "").trim();
  const note = String(form.get("teksti") ?? "").trim();
  if ((ean === "") === (note === "")) {
    return problem(400, "Poistettavaa riviä ei tunnistettu.");
  }
  const key: SOstoslistaKey = ean === "" ? { note } : { ean };

  let deleted: string[] = [];
  try {
    deleted = await client.remove(key);
  } catch (error) {
    if (!(error instanceof SOstoslistaError && error.status === 404)) {
      console.error(`S-ostoslista removal failed: ${reason(error)}`);
      return problem(502, "Rivin poisto S-ostoslistalta ei onnistunut. Yritä uudelleen.");
    }
  }

  /**
   * The phone is pushed for the reason a finished send pushes it, and at the
   * same price: the removal is already made on the service's own copy, so a
   * push that fails means a phone that catches up at the next sweep, not a
   * delete that did not happen. Refusing here would put the panel back in a
   * state the service has already left.
   */
  try {
    await client.sync();
  } catch (error) {
    console.error(`S-ostoslista sync after removal failed: ${reason(error)}`);
  }

  return Response.json({ deleted });
}

/** The typed shopping client asks for JSON, so one route serves both callers. */
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
  const item = selectedBuyItem(state.buy, ctx.url.searchParams.get("rivi"));
  if (item === null) return new Response("Not found", { status: 404 });

  const mode = chosenMode(ctx.url.searchParams.get("tapa"));
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
  return productPage(
    member,
    item,
    state.selectedIds,
    mode,
    query,
    products,
    refused,
    status,
  );
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
  const item = selectedBuyItem(state.buy, form.get("rivi"));
  if (item === null) return new Response("Not found", { status: 404 });

  const mode = chosenMode(form.get("tapa"));
  const query = String(form.get("haku") ?? "").trim();
  const ean = String(form.get("ean") ?? "").trim();
  const scope = chosenScope(item, form.get("laajuus"));

  /**
   * The typed shopping client shows the choice before this answer arrives, so a
 * refusal has to
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
      : productPage(
          member,
          item,
          state.selectedIds,
          mode,
          query,
          products,
          message,
          status,
        );

  if (scope === null) {
    return refuse("Valinnan laajuutta ei tunnistettu. Mitään ei tallennettu.", 400, []);
  }

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

  const size = statedSize(form, selected.ean) ?? packageSizeFromName(selected.name);
  const toSave = {
    ean: selected.ean,
    name: selected.name,
    imageUrl: selected.imageUrl,
    packageQuantity: size?.quantity ?? null,
    packageUnit: size?.unit ?? null,
  };

  if (scope === "ingredient") {
    await saveIngredientProduct(ctx.env.DB, item.ingredientId, toSave, mode);
  } else {
    await saveRecipeProduct(
      ctx.env.DB,
      member.householdId,
      scope.recipeId,
      item.ingredientId,
      toSave,
    );
  }

  // The confirmed product, not the one the browser drew: a re-search may have
  // found a newer name, and the row should end up saying what was stored.
  if (asJson) {
    return Response.json({
      product: {
        ean: toSave.ean,
        name: toSave.name,
        imageUrl: toSave.imageUrl,
        packageQuantity: toSave.packageQuantity,
        packageUnit: toSave.packageUnit,
      },
      // An added size or a recipe's own product changes what the *other* rows
      // add up to, so the browser reloads rather than drawing it itself.
      reload: mode === "add" || scope !== "ingredient",
    });
  }

  return new Response(null, {
    status: 303,
    headers: { Location: listLocation(state.selectedIds, item.ingredientId) },
  });
}

/**
 * `POST /ostoslista/tuote/poista` — drop one package size, or one recipe's own
 * product.
 *
 * Without this, a mistyped package size or a product chosen on the wrong row
 * would be permanent, and #161's whole point is that the household keeps
 * teaching this over time.
 */
export async function removeProductForm(
  ctx: RouteContext,
  member: Member,
): Promise<Response> {
  if (externalClient(ctx.env, member) === null) {
    return new Response("Not found", { status: 404 });
  }

  const form = await ctx.request.formData();
  const stateCtx = { ...ctx, url: selectionUrl(form, ctx.url) };
  const state = await shoppingState(stateCtx, member);
  const item = selectedBuyItem(state.buy, form.get("rivi"));
  if (item === null) return new Response("Not found", { status: 404 });

  const ean = String(form.get("ean") ?? "").trim();
  if (!item.products.some((product) => product.ean === ean)) {
    return new Response("Not found", { status: 404 });
  }

  if (item.recipeId === null) {
    await removeIngredientProduct(ctx.env.DB, item.ingredientId, ean);
  } else {
    await removeRecipeProduct(
      ctx.env.DB,
      member.householdId,
      item.recipeId,
      item.ingredientId,
    );
  }

  return new Response(null, {
    status: 303,
    headers: { Location: listLocation(state.selectedIds, item.ingredientId) },
  });
}

/** Replace what this ingredient is, or add another packet of the same thing. */
function chosenMode(value: FormDataEntryValue | string | null): "replace" | "add" {
  return String(value ?? "") === "lisaa" ? "add" : "replace";
}

/**
 * How far the choice reaches: every use of this ingredient, or one dish's.
 *
 * The recipe has to be one the row actually came from. A member choosing a
 * scope from a screen they can see cannot thereby pin an ingredient inside
 * somebody else's week.
 */
function chosenScope(
  item: ShoppingItem,
  value: FormDataEntryValue | string | null,
): "ingredient" | { recipeId: number } | null {
  const raw = String(value ?? "").trim();
  if (raw === "" || raw === "aines") return "ingredient";
  const recipeId = Number(raw);
  if (!Number.isSafeInteger(recipeId)) return null;
  return item.recipes.some((one) => one.id === recipeId) ? { recipeId } : null;
}

/**
 * A package size the member typed, for a product whose name does not say one.
 *
 * The fields are named per EAN because the whole results list is one form —
 * one scope choice above many products — so `pakkaus` alone would hand the
 * chosen product whichever size was typed highest up the page.
 *
 * Both halves or neither: a number without a unit would be a size that compares
 * grams against millilitres, and `baseAmount` refusing an unknown unit is what
 * keeps a typo out of the optimisation rather than into it.
 */
function statedSize(
  form: FormData,
  ean: string,
): { quantity: number; unit: string } | null {
  const quantity = Number(
    String(form.get(`pakkaus_${ean}`) ?? "").trim().replace(",", "."),
  );
  const unit = String(form.get(`pakkausyksikko_${ean}`) ?? "").trim();
  if (!Number.isFinite(quantity) || quantity <= 0 || unit === "") return null;
  if (baseAmount(quantity, unit) === null) return null;
  return { quantity, unit };
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
    headers: { Location: `/ostoslista?${selectionQuery(form)}${pantryAnchor(ingredientId)}` },
  });
}

/** The row the cupboard button was pressed on, so the redirect lands on it. */
function pantryAnchor(ingredientId: number): string {
  return Number.isSafeInteger(ingredientId) ? `#${anchorName(ingredientId)}` : "";
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
  const row = String(form.get("rivi") ?? "").trim();
  if (row !== "") url.searchParams.set("rivi", row);
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
const rawDisabled = raw("disabled");

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
  // The anchor names are handed out once across both lists, so a row that moves
  // between them keeps the same `#aines-…` and every redirect below still lands
  // on it (#200).
  const anchored = new Set<number>();

  // With nothing in the cupboard there is only one list, and a lone
  // "Ostettavat" heading under a heading that already says Ostoslista is a
  // word for its own sake.
  if (atHome.length === 0) {
    return itemList(buy, selectedIds, false, external, anchored);
  }

  return html`<h2 class="shopping-section">Ostettavat</h2>
    ${buy.length === 0
      ? html`<p class="empty">Kaikki tarvittava löytyy jo kaapista.</p>`
      : itemList(buy, selectedIds, false, external, anchored)}
    <h2 class="shopping-section">Löytyy</h2>
    <p class="empty">
      Näitä valitut ateriat tarvitsevat, mutta ne ovat jo
      <a href="/kaappi">kaapissa</a>.
    </p>
    ${itemList(atHome, selectedIds, true, external, anchored)}`;
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
  anchored: Set<number>,
): Raw {
  if (items.length === 0) {
    return html`<p class="empty">Valituissa aterioissa ei ole aineksia.</p>`;
  }

  return html`<ul class="shopping-list">
    ${items.map(
      (item) => html`<li ${rowAnchor(item, anchored)}>
        <details
          class="shopping-item"
          data-aines="${item.ingredientId}"
          data-rivi="${item.key}"
          data-haku="${item.name}"
        >
          <summary>
            <span class="shopping-thumb">${thumbnail(item)}</span>
            <span class="shopping-line">
              <span class="shopping-name">${item.name}</span>
              <span class="${item.total === AMOUNT_IN_RECIPE
                ? "shopping-total is-unstated"
                : "shopping-total"}"
                >${item.total}</span
              >
            </span>
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
 * Where a form that has to leave the page sends the member back to (#200).
 *
 * Every server round-trip on this screen — the cupboard buttons, dropping a
 * package size, and the whole no-JavaScript product flow — used to redirect to
 * `/ostoslista` with nothing but the meal selection, which drops somebody who
 * was twenty rows down back at the top of a list they then have to find their
 * place in again. An id per ingredient is enough to land them back on the row
 * they acted on.
 *
 * It is the *ingredient* rather than the row key because those two round-trips
 * are exactly the ones that can change a row's key: a product pinned to one
 * dish splits `12` into `12` and `12:r7`, and moving a row to the cupboard
 * moves it to the other list entirely. The ingredient survives both. Where an
 * ingredient does have two rows the first one gets the name, because a
 * duplicate id is not an anchor at all.
 */
function rowAnchor(item: ShoppingItem, anchored: Set<number>): Raw {
  if (anchored.has(item.ingredientId)) return html``;
  anchored.add(item.ingredientId);
  return raw(`id="${anchorName(item.ingredientId)}"`);
}

function anchorName(ingredientId: number): string {
  return `aines-${ingredientId}`;
}

/**
 * The list URL a form redirects to: the selection it was carrying, and the row
 * it was about.
 */
function listLocation(
  selectedIds: Set<number>,
  ingredientId: number | null,
): string {
  const anchor =
    ingredientId === null || !Number.isSafeInteger(ingredientId)
      ? ""
      : `#${anchorName(ingredientId)}`;
  return `/ostoslista?${selectionQueryFromIds(selectedIds)}${anchor}`;
}

/**
 * Every slot a product picture is drawn in, with the width the CDN should
 * render it at. Three of them, and the widths are roughly three times the slot
 * — enough for a phone's own pixel density and no more (#204). Left to itself
 * the CDN sends one 256 px picture for all three, which on a portrait carton is
 * 44 kB apiece: nearly a megabyte to fill twenty 26 px squares.
 *
 * The CSS crops each of these to its box rather than fitting the whole picture
 * inside it, which is the other half of the same complaint. A product photo is
 * shot however the package stands, so a milk carton arrives at 256 × 705; fitted
 * into a square it drew as a 9 px sliver of white, and the picture that was
 * supposed to say which product this row is said nothing.
 *
 * These numbers pair with the sizes in `html.ts` and are handed to the typed
 * shopping client below, so a slot's size lives in one place.
 */
const PRODUCT_PICTURE = {
  row: { size: 26, width: 96 },
  summary: { size: 40, width: 128 },
  result: { size: 80, width: 192 },
} as const;

type PictureSlot = (typeof PRODUCT_PICTURE)[keyof typeof PRODUCT_PICTURE];

function productPicture(url: string, slot: PictureSlot): Raw {
  return html`<img
    src="${sProductImageAtWidth(url, slot.width)}"
    alt=""
    width="${String(slot.size)}"
    height="${String(slot.size)}"
    loading="lazy"
    onerror="this.hidden=true"
  />`;
}

/**
 * The chosen product's picture on the row itself (#159), small enough that the
 * row it sits in is the height it always was. Without a picture the slot stays
 * empty and collapses, so an unmapped ingredient — or one whose CDN image is
 * missing — reads exactly as it did before rather than as a broken box.
 */
function thumbnail(item: ShoppingItem): Raw {
  const image = item.chosen[0]?.product.imageUrl ?? null;
  if (image === null) return html``;
  return productPicture(image, PRODUCT_PICTURE.row);
}

function externalSendPanel(
  buy: ShoppingItem[],
  selectedIds: Set<number>,
  external: boolean,
): Raw {
  if (!external) return html``;
  const mapped = buy.filter((item) => item.chosen.length > 0).length;
  const notes = buy.length - mapped;
  return html`<section class="s-shopping-send" aria-labelledby="s-shopping-title" data-product-picture="${JSON.stringify(PRODUCT_PICTURE)}">
    <h2 id="s-shopping-title">S-ostoslista</h2>
    ${buy.length === 0
      ? ""
      : html`<p class="s-send-counts" data-tuotteet="${mapped}" data-muistutukset="${notes}">
            ${mapped} ${mapped === 1 ? "tuote" : "tuotetta"}${notes === 0
              ? ""
              : ` · ${notes} ${notes === 1 ? "teksti" : "tekstiä"}`}
          </p>
          <form method="post" action="/ostoslista/laheta" class="s-send-form">
            ${selectionFields(selectedIds)}
            <button type="submit" class="primary">Lähetä S-ostoslistaan</button>
          </form>`}
  </section>`;
}

/**
 * What the S-ostoslista already holds, filled in by the typed shopping client.
 *
 * It ships hidden and empty on purpose. The contents are an external read, and
 * #159 asks for them without letting them delay — or break — the household's
 * own list, so they arrive after the screen does. A browser that runs nothing
 * simply never sees this block, which is the same bargain every other
 * enhancement on this screen makes.
 *
 * This change moves it *below* the list rather than inside the send panel above
 * it (#200). Its contents are an unknown number of lines that arrive after the
 * screen is already on the phone, and every one of them used to push the whole
 * shopping list further down while somebody was reading it. Below the list it
 * grows into empty space and moves nothing.
 */
function currentListPanel(): Raw {
  return html`<div class="s-current" hidden>
    <h3>S-ostoslistalla nyt</h3>
    <p class="s-current-state"></p>
    <ul class="s-current-items"></ul>
  </div>`;
}

/**
 * What this row is buying, and the two buttons that change it.
 *
 * The intelligence stays behind the row (#161): a member reads the product,
 * how many of it, and — where a recipe has its own — which dish this row
 * belongs to. There is no rule editor and no settings page; the two things
 * anybody needs to say are said by opening the product panel from here, either
 * to change the product or to teach the ingredient another package size.
 */
function externalProductBlock(
  item: ShoppingItem,
  selectedIds: Set<number>,
  inPantry: boolean,
  external: boolean,
): Raw {
  if (!external) return html``;

  const mapped = item.chosen.length > 0;
  if (inPantry) return mapped ? productSummary(item) : html``;

  return html`<div class="s-shopping-product ${mapped ? "is-mapped" : "is-note"}">
    <div class="s-shopping-product-body">
      ${mapped
        ? productSummary(item)
        : html`<div class="s-shopping-product-copy">
            <strong>Teksti</strong>
            <span class="meta">Lähetetään tekstinä: ${item.name} — ${item.total}</span>
          </div>`}
    </div>
    ${openForm(item, selectedIds, "korvaa", mapped ? "Vaihda tuote" : "Valitse tuote")}
    <p class="s-status" role="status" aria-live="polite"></p>
    ${item.recipeId === null
      ? openForm(item, selectedIds, "lisaa", "Lisää toinen pakkauskoko", !mapped)
      : ""}
    ${knownProducts(item, selectedIds)}
    ${scopeSource(item)}
  </div>`;
}

/**
 * The scope choice, drawn by the server and hidden, for the typed shopping
 * client to lift into its panel.
 *
 * It sits outside every form on the row on purpose — a hidden `<select>` inside
 * the cupboard or open-panel form would be posted along with them — and it is
 * rendered here rather than built in JavaScript so a dish's title is escaped by
 * the same `html` tag as everything else.
 */
function scopeSource(item: ShoppingItem): Raw {
  if (item.recipeId !== null || item.recipes.length === 0) return html``;
  return html`<div class="s-scope-source" hidden>${scopeChoice(item, "replace")}</div>`;
}

/**
 * One button that opens the product panel — in the browser, or as a plain
 * navigation to `/ostoslista/tuote` where it cannot.
 *
 * `tapa` is the difference between the two: `korvaa` means this ingredient is
 * something else than we thought, `lisaa` means it is the same thing in a
 * second packet. Both end up in the same panel; only what the save does with
 * the answer differs.
 *
 * There is nothing to add a second size *to* until something is chosen, so on an
 * unmapped row that button is **disabled rather than hidden** (#200). Hidden, it
 * appeared the instant a product was drawn — and a whole tap target arriving
 * mid-row shoved every row under it down the screen at exactly the moment the
 * member had just tapped something. Disabled it holds its own space, says
 * plainly that there is nothing to add a size to yet, and the typed shopping
 * client only has to enable it.
 */
function openForm(
  item: ShoppingItem,
  selectedIds: Set<number>,
  mode: "korvaa" | "lisaa",
  label: string,
  disabled = false,
): Raw {
  return html`<form
    method="get"
    action="/ostoslista/tuote"
    class="inline s-product-open"
    data-tapa="${mode}"
  >
    <input type="hidden" name="rivi" value="${item.key}" />
    <input type="hidden" name="tapa" value="${mode}" />
    <input type="hidden" name="haku" value="${item.name}" />
    ${selectionFields(selectedIds)}
    <button type="submit" ${disabled ? rawDisabled : ""}>${label}</button>
  </form>`;
}

/**
 * The package sizes this row knows beyond the one it is buying, each with the
 * one thing that can go wrong made fixable: a size nobody could read, and a
 * choice somebody made by mistake.
 *
 * It is only drawn when there is more than one product or a recipe's own — the
 * ordinary row, one ingredient with one packet, shows nothing extra at all.
 */
function knownProducts(item: ShoppingItem, selectedIds: Set<number>): Raw {
  const pinned = item.recipeId !== null;
  if (!pinned && item.products.length < 2) return html``;

  return html`<ul class="s-product-sizes">
    ${item.products.map(
      (product) => html`<li>
        <span class="s-product-size-name">${product.name}</span>
        <span class="meta"
          >${product.packageQuantity === null || product.packageUnit === null
            ? "pakkauskoko tuntematon"
            : `${formatDecimal(product.packageQuantity)} ${product.packageUnit}`}</span
        >
        <form method="post" action="/ostoslista/tuote/poista" class="inline">
          <input type="hidden" name="rivi" value="${item.key}" />
          <input type="hidden" name="ean" value="${product.ean}" />
          ${selectionFields(selectedIds)}
          <button type="submit">${pinned ? "Poista poikkeus" : "Poista"}</button>
        </form>
      </li>`,
    )}
  </ul>`;
}

/**
 * The row's answer to "what do I put in the trolley": every chosen packet, and
 * how many of it. A single packet reads exactly as it did before #161 — the
 * count only appears where there is one to say.
 *
 * #200 shrinks it. It used to be a card with a 64 px picture, and swapping the
 * two-line "Teksti" placeholder for it changed the row's height at the exact
 * moment somebody had just tapped something — so the rest of the list moved
 * under their thumb. At 40 px with the name and EAN each held to one line, the
 * mapped and unmapped states are the same two lines tall and the swap moves
 * nothing.
 */
function productSummary(item: ShoppingItem): Raw {
  return html`<div class="s-shopping-product-summary">
    ${item.recipeTitle === null
      ? ""
      : html`<span class="s-product-scope meta"
          >Vain reseptissä ${item.recipeTitle}</span
        >`}
    ${item.chosen.map(
      ({ product, count }) => html`<span class="s-shopping-product-one">
        ${product.imageUrl === null
          ? ""
          : productPicture(product.imageUrl, PRODUCT_PICTURE.summary)}
        <span class="s-shopping-product-copy">
          <strong
            >${count > 1 ? `${count} × ` : ""}${product.name}</strong
          >
          <span class="meta">EAN ${product.ean}</span>
        </span>
      </span>`,
    )}
    ${item.packageTotal === null
      ? ""
      : html`<span class="s-package-total meta"
          >Pakkauksissa yhteensä ${item.packageTotal}</span
        >`}
  </div>`;
}

function productPage(
  member: Member,
  item: ShoppingItem,
  selectedIds: Set<number>,
  mode: "replace" | "add",
  query: string,
  products: SOstoslistaProduct[],
  refused: string | null,
  status: number,
): Response {
  const back = listLocation(selectedIds, item.ingredientId);
  const heading =
    mode === "add"
      ? `Lisää pakkauskoko: ${item.name}`
      : `Valitse tuote: ${item.name}`;
  return page(
    heading,
    html`<p><a href="${back}">← Takaisin ostoslistaan</a></p>
      <h1>${heading}</h1>
      ${refused === null ? "" : html`<p class="refused">${refused}</p>`}
      <form method="get" action="/ostoslista/tuote" class="stacked product-search-form">
        <input type="hidden" name="rivi" value="${item.key}" />
        <input type="hidden" name="tapa" value="${mode === "add" ? "lisaa" : "korvaa"}" />
        ${selectionFields(selectedIds)}
        <label>
          Haku
          <input type="search" name="haku" value="${query}" required />
        </label>
        <button type="submit" class="primary">Hae tuotteita</button>
      </form>
      ${products.length === 0 && refused === null
        ? html`<p class="empty">Haulla ei löytynyt tuotteita.</p>`
        : productResults(item, selectedIds, mode, query, products)}`,
    "shopping",
    member,
    status,
  );
}

/**
 * How wide a choice reaches, asked in one line above the results.
 *
 * A dropdown rather than a pair of buttons on every result: the answer is
 * almost always the default, the results are already busy, and a row that draws
 * two batches' worth of dishes needs to be able to say *which* dish anyway.
 * Adding a second package size is not a scope question at all — it is by
 * definition about the ingredient — so the choice is not offered there.
 */
function scopeChoice(item: ShoppingItem, mode: "replace" | "add"): Raw {
  if (mode === "add" || item.recipeId !== null || item.recipes.length === 0) {
    return html``;
  }

  return html`<label class="s-product-scope-choice">
    Valinnan laajuus
    <select name="laajuus">
      <option value="aines">Käytä aina tälle ainekselle</option>
      ${item.recipes.map(
        (recipe) => html`<option value="${recipe.id}">
          Käytä tässä reseptissä: ${recipe.title}
        </option>`,
      )}
    </select>
  </label>`;
}

function productResults(
  item: ShoppingItem,
  selectedIds: Set<number>,
  mode: "replace" | "add",
  query: string,
  products: SOstoslistaProduct[],
): Raw {
  return html`<form method="post" action="/ostoslista/tuote" class="s-product-choice">
    <input type="hidden" name="rivi" value="${item.key}" />
    <input type="hidden" name="haku" value="${query}" />
    <input type="hidden" name="tapa" value="${mode === "add" ? "lisaa" : "korvaa"}" />
    ${selectionFields(selectedIds)}
    ${scopeChoice(item, mode)}
    <ul class="s-product-results">
      ${products.map((product) => productResult(product))}
    </ul>
  </form>`;
}

function productResult(product: SOstoslistaProduct): Raw {
  const size = packageSizeFromName(product.name);
  return html`<li>
    ${productPicture(product.imageUrl, PRODUCT_PICTURE.result)}
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
      ${size === null ? "" : html`<span class="meta s-product-size">Pakkaus ${formatDecimal(size.quantity)} ${size.unit}</span>`}
    </div>
    ${size === null ? packageSizeFields(product) : ""}
    <button
      type="submit"
      class="primary"
      name="ean"
      value="${product.ean}"
    >
      Valitse
    </button>
  </li>`;
}

/**
 * The one field this screen ever asks for, and only where the shop's own name
 * does not answer it: `Kanan rintafilee marinoitu` says nothing about grams.
 *
 * Left empty, the product is still perfectly choosable — it just never gets a
 * package count, which is the safe half of #161's bargain. Filled in, it is
 * stored once as data like every other size.
 */
function packageSizeFields(product: SOstoslistaProduct): Raw {
  return html`<span class="s-product-size-entry">
    <label
      >Pakkauskoko
      <input
        type="text"
        inputmode="decimal"
        name="pakkaus_${product.ean}"
        size="5"
        data-ean="${product.ean}"
      />
    </label>
    <label
      >Yksikkö
      <select name="pakkausyksikko_${product.ean}" data-ean="${product.ean}">
        <option value="">–</option>
        ${["g", "kg", "ml", "dl", "l", "kpl"].map(
          (unit) => html`<option value="${unit}">${unit}</option>`,
        )}
      </select>
    </label>
  </span>`;
}

function selectedBuyItem(
  buy: ShoppingItem[],
  rawKey: FormDataEntryValue | string | null,
): ShoppingItem | null {
  const key = String(rawKey ?? "").trim();
  if (key === "") return null;
  return buy.find((item) => item.key === key) ?? null;
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
