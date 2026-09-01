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
import {
  SOstoslistaClient,
  SOstoslistaError,
  sProductImageAtWidth,
  type SOstoslistaKey,
  type SOstoslistaProduct,
} from "./s-ostoslista.ts";
import {
  forgetSentNote,
  rememberSentNote,
  sentNotes,
} from "./s-ostoslista-notes.ts";
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
              ${sections(buy, atHome, selectedIds, external)}
              ${external ? currentListPanel() : ""}`}
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

  // How many packets of each product the whole trip needs, worked out before
  // anything is sent (#240). The service's add is keyed by EAN, so a product
  // two rows both reach — a dish's pinned row beside the generic pile, or two
  // ingredients that are bought as the same packet — is one row on the phone's
  // list, and sending each row's own count would leave it holding whichever
  // went last instead of the total.
  const packets = packetCounts(buy);
  const done = new Set<string>();

  // What this app's last send left on the list as free text, row by row, in
  // the exact words it used (#244). A note carries its amount, so this is the
  // only way to name the row again once the week's cooking has changed.
  const db = ctx.env.DB;
  const outstanding = await sentNotes(db, member.householdId);

  let sent = 0;
  try {
    for (const item of buy) {
      const previous = outstanding.get(item.key) ?? null;
      if (item.chosen.length === 0) {
        const note = `${item.name} — ${item.total}`;
        await client.add({ note });
        // Resending the same words is the same row keyed again, so there is
        // nothing to replace — and deleting `previous` here would take the row
        // that was just added straight back off the list.
        if (previous !== note) {
          if (previous !== null) await dropNote(client, previous);
          await rememberSentNote(db, member.householdId, item.key, note);
        }
      } else {
        for (const { product } of item.chosen) {
          if (done.has(product.ean)) continue;
          done.add(product.ean);
          // The count goes out as the quantity the service and the S-list both
          // hold on a product row. Until #240 a second packet was a written
          // line beside the product, on #161's reading that the integration
          // carried no quantity at all — it does, and the note lost the
          // mapping the household had chosen.
          await client.add({ ean: product.ean }, packets.get(product.ean) ?? 1);
        }
        // The row this issue is about: it went as text before, and now has a
        // product. Add first, delete second, forget third — a send that dies
        // in the middle leaves the note still recorded, so the retry finishes
        // the job instead of stranding the old text on the list forever.
        if (previous !== null) {
          await dropNote(client, previous);
          await forgetSentNote(db, member.householdId, item.key);
        }
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

  // Once, after the last item, and only after a send that finished: the sync
  // pushes the service's copy to the phone, and there is nothing to push part
  // of. A failure here is not a failed send — the items are on the list, they
  // are just waiting for the service's own next sweep — so it is said beside
  // the success rather than instead of it.
  let synced = true;
  try {
    await client.sync();
  } catch (error) {
    console.error(`S-ostoslista sync failed: ${reason(error)}`);
    synced = false;
  }

  const notSynced =
    "Puhelimen S-ostoslistan päivitystä ei saatu käynnistettyä. Ainekset ovat listalla ja päivittyvät viimeistään seuraavassa synkronoinnissa.";

  if (asJson) {
    return Response.json({
      sent,
      total: buy.length,
      synced,
      ...(synced ? {} : { warning: notSynced }),
    });
  }
  return shoppingScreen(
    stateCtx,
    member,
    synced ? null : notSynced,
    `${sent} ainesta lähetettiin S-ostoslistaan.`,
    200,
  );
}

/**
 * Take one note this app previously sent back off the list.
 *
 * A note that is not there any more is the wanted state, not a failure: the
 * household may well have ticked it off and cleared it on the phone between
 * the two sends. The service says so with a 404, and treating that as an
 * outage would refuse a send that has nothing wrong with it. Anything else is
 * a real problem and is left to the caller, which stops the send and keeps the
 * note on record for the retry.
 */
async function dropNote(client: SOstoslistaClient, note: string): Promise<void> {
  try {
    await client.remove({ note });
  } catch (error) {
    if (error instanceof SOstoslistaError && error.status === 404) return;
    throw error;
  }
}

/**
 * Every product this list is buying and how many packets of it, added up across
 * the whole list rather than per row.
 *
 * The rows themselves are already right: `shopping.ts::shoppingList` puts one
 * ingredient's amounts in one total whatever recipes they came from, and
 * `packaging.ts::planPackages` turns that total into packets. What this covers
 * is the case above a row — the same product reached twice, which the packet
 * planner never sees because it only ever looks at one row's need.
 */
function packetCounts(buy: ShoppingItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of buy) {
    for (const { product, count } of item.chosen) {
      counts.set(product.ean, (counts.get(product.ean) ?? 0) + count);
    }
  }
  return counts;
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
 * The panel this serves is drawn by the island and exists only where there is
 * a browser to fill it, so there is no screen to re-render on a refusal: the
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
 * the same reason it is in `dropNote`: the household may have cleared it on the
 * phone since the panel was drawn, and the member asked for it to be gone.
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
 * These numbers pair with the sizes in `html.ts` and are handed to the island
 * below, so a slot's size lives in one place.
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
  return html`<section class="s-shopping-send" aria-labelledby="s-shopping-title">
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
 * What the S-ostoslista already holds, filled in by the island.
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
 * The scope choice, drawn by the server and hidden, for the island to lift into
 * its panel.
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
 * plainly that there is nothing to add a size to yet, and the island only has to
 * enable it.
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
 * Everything #159 asks the browser to do, in one island.
 *
 * Written in ES5 with no regular expressions, like the other three islands —
 * it is a template literal shipped untranspiled, see
 * `docs/codebase/screens.md`. It builds every node with `createElement` and
 * `createTextNode` rather than by pasting strings together, so a product name
 * from the shop cannot become markup.
 *
 * Six things it is careful about:
 *
 *   - **A search answer is bound to its question.** The cache is keyed by the
 *     search term and the server echoes the term it ran, so a prefetched answer
 *     for the next ingredient can never be drawn into the row a member is
 *     looking at.
 *   - **Nothing it draws is inside the list.** The picker is one fixed sheet
 *     and a refusal is one fixed strip; both sit over the list rather than in
 *     it, so opening, closing, searching, choosing and failing all move the
 *     list by zero pixels (#200). The one thing the island writes into a row is
 *     the chosen product, into slots the server already sized.
 *   - **The sheet says what it is for.** A picker that is no longer inside the
 *     row it belongs to has to name the ingredient and its amount itself.
 *   - **A save is optimistic but never silent.** The row shows the choice and
 *     the sheet closes at once; a spinner in the row's own reserved status line
 *     says the save is still going, and a failure puts the row back the way it
 *     was with the refusal and a retry.
 *   - **A row that is done closes itself.** The open row is the tallest thing
 *     on the screen at exactly the moment there is nothing left to do in it,
 *     and #204 is somebody finishing an ingredient and having to hunt for where
 *     they were. Collapsing on a successful save leaves the chosen product's
 *     picture on the row and the next ingredient on the next line. Only on
 *     success: a refusal's error and retry live inside the row.
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
  var sendAfterSaves = null;

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
    var items = document.querySelectorAll('.shopping-item[data-rivi]');
    for (var index = 0; index < items.length; index += 1) {
      var details = items[index];
      var block = details.querySelector('.s-shopping-product');
      var openers = block ? block.querySelectorAll('form.s-product-open') : [];
      if (!block || openers.length === 0) continue;
      var total = details.querySelector('.shopping-total');
      var row = {
        details: details,
        block: block,
        body: block.querySelector('.s-shopping-product-body'),
        thumb: details.querySelector('.shopping-thumb'),
        openers: openers,
        // The first opener is the one that replaces; its hidden fields carry
        // the row key and the week's selection, which every request needs.
        opener: openers[0],
        scopeSource: block.querySelector('.s-scope-source'),
        scope: null,
        mode: 'korvaa',
        name: details.getAttribute('data-haku') || '',
        aines: details.getAttribute('data-aines') || '',
        total: total ? total.textContent || '' : '',
        query: details.getAttribute('data-haku') || '',
        // The one place a row ever says it is busy, drawn by the server and
        // never added or removed, so a save cannot change the row's height.
        status: block.querySelector('.s-status'),
        saving: false
      };
      if (row.scopeSource) {
        row.scope = row.scopeSource.querySelector('.s-product-scope-choice');
      }
      rows.push(row);
    }
  }

  // The same three slots the server draws, handed over rather than written
  // twice, and the same width swap on the CDN's path — done here with indexOf
  // and slice because a regular expression cannot survive this file (#204).
  var PICTURE = ${JSON.stringify(PRODUCT_PICTURE)};

  function pictureAtWidth(url, width) {
    var base = 'https://cdn.s-cloud.fi/v1/';
    if (url.indexOf(base) !== 0) return url;
    var path = url.slice(base.length);
    var slash = path.indexOf('/');
    if (slash <= 0) return url;
    return base + 'w' + width + '_q75/' + path.slice(slash + 1);
  }

  function productImage(url, slot) {
    var image = document.createElement('img');
    image.setAttribute('alt', '');
    image.setAttribute('width', String(slot.size));
    image.setAttribute('height', String(slot.size));
    image.onerror = function () { this.hidden = true; };
    image.src = pictureAtWidth(url, slot.width);
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

  // ------------------------------------------------------------- the sheet
  //
  // One picker for the whole screen, fixed to the bottom of the viewport rather
  // than grown inside the row (#200). The old panel put a search box and a
  // screenful of 80 px product pictures *into* the list, so opening it pushed
  // every row below it down and closing it snapped them back — which is what
  // made walking a list of twenty ingredients feel like the page was fighting
  // back. A fixed element is outside the list's flow: opening and closing the
  // picker moves the list by nothing at all.
  //
  // It also names the ingredient it is for, which the in-row panel never had to
  // because it was sitting in the row. On a phone that heading is now the only
  // thing saying which of twenty ingredients this search belongs to.

  var sheet = null;
  var openRow = null;

  function buildSheet() {
    var node = el('div', 's-sheet');
    node.hidden = true;

    var backdrop = el('div', 's-sheet-backdrop');
    backdrop.addEventListener('click', closeSheet);
    node.appendChild(backdrop);

    var panel = el('div', 's-sheet-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 's-sheet-title');

    var head = el('div', 's-sheet-head');
    var titles = el('div', 's-sheet-titles');
    var title = el('h2', 's-sheet-name', '');
    title.id = 's-sheet-title';
    titles.appendChild(title);
    var sub = el('p', 's-sheet-sub', '');
    titles.appendChild(sub);
    head.appendChild(titles);
    var close = el('button', 'quiet s-sheet-close', 'Sulje');
    close.type = 'button';
    close.addEventListener('click', closeSheet);
    head.appendChild(close);
    panel.appendChild(head);

    var form = el('form', 's-product-search');
    var label = el('label', '', 'Haku ');
    var input = document.createElement('input');
    input.type = 'search';
    input.name = 'haku';
    label.appendChild(input);
    form.appendChild(label);
    var go = el('button', '', 'Hae');
    go.type = 'submit';
    form.appendChild(go);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (!openRow) return;
      var wanted = input.value.trim ? input.value.trim() : input.value;
      if (wanted === '') return;
      openRow.query = wanted;
      runSearch(openRow);
    });
    panel.appendChild(form);

    var scopeSlot = el('div', 's-sheet-scope');
    panel.appendChild(scopeSlot);
    var state = el('p', 's-product-panel-state', '');
    panel.appendChild(state);
    var results = el('div', 's-product-panel-results');
    panel.appendChild(results);

    node.appendChild(panel);
    document.body.appendChild(node);
    sheet = {
      node: node,
      title: title,
      sub: sub,
      input: input,
      scopeSlot: scopeSlot,
      state: state,
      results: results
    };
    return sheet;
  }

  /* What the sheet is for, in one line: the amount, and what is chosen now. */
  function subtitle(row) {
    if (row.mode === 'lisaa') return row.total + ' · Lisää pakkauskoko';
    var chosen = row.block.querySelector('.s-shopping-product-copy strong');
    var mapped = row.block.className.indexOf('is-mapped') !== -1;
    if (mapped && chosen) return row.total + ' · Nyt: ' + (chosen.textContent || '');
    return row.total + ' · Ei valittua tuotetta';
  }

  /* The scope choice lives in its row and visits the sheet, never the reverse:
     a dish's title is escaped by the server once and never rebuilt here. */
  function returnScope(row) {
    if (row.scope && row.scopeSource && row.scope.parentNode !== row.scopeSource) {
      row.scopeSource.appendChild(row.scope);
    }
  }

  function openSheet(row, mode) {
    var it = sheet || buildSheet();
    if (openRow && openRow !== row) returnScope(openRow);
    openRow = row;
    row.mode = mode;

    clear(it.title);
    it.title.appendChild(document.createTextNode(row.name));
    clear(it.sub);
    it.sub.appendChild(document.createTextNode(subtitle(row)));
    it.input.value = row.query;

    // Adding a second package size is a fact about the ingredient, so there is
    // no scope to choose there; changing the product is where the question is.
    if (row.scope && mode !== 'lisaa') {
      it.scopeSlot.appendChild(row.scope);
      it.scopeSlot.hidden = false;
    } else {
      it.scopeSlot.hidden = true;
    }

    it.node.hidden = false;
    runSearch(row);
    prefetchNext(row);
  }

  function closeSheet() {
    if (!sheet || sheet.node.hidden) return;
    if (openRow) returnScope(openRow);
    sheet.node.hidden = true;
    openRow = null;
  }

  function sheetIsOpenFor(row) {
    return sheet !== null && !sheet.node.hidden && openRow === row;
  }

  function say(row, text, working) {
    if (!sheetIsOpenFor(row)) return;
    if (working) busy(sheet.state, text);
    else {
      clear(sheet.state);
      sheet.state.appendChild(document.createTextNode(text));
    }
    sheet.state.hidden = false;
  }

  function runSearch(row) {
    var query = row.query;
    if (sheetIsOpenFor(row)) clear(sheet.results);
    say(row, 'Haetaan tuotteita…', true);
    search(query, function (ok, payload) {
      // Three guards, and all three matter: the row may have moved on to
      // another term, the sheet may have moved on to another row, and an
      // answer only counts for the term the server says it ran.
      if (row.query !== query) return;
      if (!sheetIsOpenFor(row)) return;
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
      clear(sheet.state);
      sheet.state.hidden = true;
      showResults(row, query, payload.results);
    });
  }

  function showResults(row, query, results) {
    if (!sheetIsOpenFor(row)) return;
    clear(sheet.results);
    var list = el('ul', 's-product-results');
    for (var index = 0; index < results.length; index += 1) {
      list.appendChild(resultRow(row, query, results[index]));
    }
    sheet.results.appendChild(list);
  }

  var SIZE_UNITS = ['g', 'kg', 'ml', 'dl', 'l', 'kpl'];

  /**
   * Where a name says nothing about the packet, ask. Left empty it stays
   * unknown, and an unknown size simply never produces a package count.
   */
  function sizeFields(item) {
    var wrap = el('span', 's-product-size-entry');
    var amountLabel = el('label', '', 'Pakkauskoko ');
    var amount = document.createElement('input');
    amount.type = 'text';
    amount.setAttribute('inputmode', 'decimal');
    amount.size = 5;
    amountLabel.appendChild(amount);
    wrap.appendChild(amountLabel);

    var unitLabel = el('label', '', 'Yksikkö ');
    var unit = document.createElement('select');
    unit.appendChild(new Option('–', ''));
    for (var index = 0; index < SIZE_UNITS.length; index += 1) {
      unit.appendChild(new Option(SIZE_UNITS[index], SIZE_UNITS[index]));
    }
    unitLabel.appendChild(unit);
    wrap.appendChild(unitLabel);

    item.appendChild(wrap);
    return { amount: amount, unit: unit };
  }

  function resultRow(row, query, product) {
    var item = document.createElement('li');
    item.appendChild(productImage(product.imageUrl, PICTURE.result));
    var copy = el('div', 's-product-result-copy');
    copy.appendChild(el('strong', '', product.name));
    copy.appendChild(el('span', 'meta', 'EAN ' + product.ean));
    var priceText = price(product);
    if (priceText) copy.appendChild(el('span', 'meta', priceText));
    if (product.available === false) {
      copy.appendChild(el('span', 'meta', 'Ei saatavilla valitussa kaupassa'));
    }
    var known = typeof product.packageQuantity === 'number' && product.packageUnit;
    if (known) {
      copy.appendChild(
        el(
          'span',
          'meta s-product-size',
          'Pakkaus ' +
            String(product.packageQuantity).split('.').join(',') +
            ' ' +
            product.packageUnit
        )
      );
    }
    item.appendChild(copy);
    var fields = known ? null : sizeFields(item);
    var choose = el('button', 'primary', 'Valitse');
    choose.type = 'button';
    choose.addEventListener('click', function () {
      chooseProduct(row, query, product, fields);
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

  function chooseProduct(row, query, product, fields) {
    if (row.saving) return;
    var extra = {
      tapa: row.mode,
      laajuus: row.scope && row.mode !== 'lisaa' ? scopeValue(row) : 'aines'
    };
    if (fields) {
      var typed = fields.amount.value;
      if (typed && typed.replace(' ', '') !== '' && fields.unit.value) {
        extra['pakkaus_' + product.ean] = typed;
        extra['pakkausyksikko_' + product.ean] = fields.unit.value;
      }
    }
    closeSheet();

    // A second package size, or a product pinned to one recipe, changes what
    // this row and its neighbours add up to — that arithmetic is the server's,
    // so the browser waits for the answer rather than drawing a guess. This is
    // the one path on the screen that still reloads, and it comes back to the
    // ingredient it was about rather than to the top of the list (#200).
    if (extra.tapa === 'lisaa' || extra.laajuus !== 'aines') {
      row.saving = true;
      status(row, 'Tallennetaan…');
      send(row, query, product, extra, function (ok, payload) {
        row.saving = false;
        if (ok) {
          reloadOnto(row);
          return;
        }
        status(row, null);
        showError(
          row,
          (payload && payload.error) || 'Tuotteen tallennus epäonnistui.',
          function () { chooseProduct(row, query, product, fields); }
        );
        saveSettled(false);
      });
      return;
    }

    // Everything the optimistic draw touches, kept so a refusal can put the row
    // back exactly as the server still has it.
    var before = {
      body: row.body.innerHTML,
      thumb: row.thumb ? row.thumb.innerHTML : null,
      blockClass: row.block.className,
      openLabel: openerLabel(row),
      disabledOpeners: openerAvailability(row)
    };
    showProduct(row, product);
    persist(row, query, product, extra, before);
  }

  /* Reload, but land on the row this was about — the server draws every row
     with id="aines-<id>", so naming it is the whole of the restoration. */
  function reloadOnto(row) {
    if (row.aines !== '') {
      window.location.hash = 'aines-' + row.aines;
    }
    window.location.reload();
  }

  function scopeValue(row) {
    var select = row.scope ? row.scope.querySelector('select') : null;
    return select ? select.value : 'aines';
  }

  function send(row, query, product, extra, done) {
    var body = { haku: query, ean: product.ean, muoto: 'json' };
    for (var key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) body[key] = extra[key];
    }
    request(
      'POST',
      '/ostoslista/tuote',
      fieldsOf(row.opener, body, { haku: 1, tapa: 1 }),
      done
    );
  }

  function openerButton(form) {
    return form.querySelector('button');
  }

  function openerAvailability(row) {
    var off = [];
    for (var index = 0; index < row.openers.length; index += 1) {
      var button = openerButton(row.openers[index]);
      off.push(button ? button.disabled : false);
    }
    return off;
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
    for (var index = 0; index < row.openers.length; index += 1) {
      var opener = openerButton(row.openers[index]);
      if (opener) opener.disabled = before.disabledOpeners[index];
    }
    var button = row.opener.querySelector('button');
    if (button && before.openLabel !== null) button.innerHTML = before.openLabel;
  }

  function persist(row, query, product, extra, before) {
    row.saving = true;
    clearError(row);
    status(row, 'Tallennetaan…');
    send(row, query, product, extra, function (ok, payload) {
      row.saving = false;
      status(row, null);
      if (ok && payload && payload.product) {
        showProduct(row, payload.product);
        // An ingredient that was going as a note is going as a product now, and
        // the line above the send button says how many of each there are.
        if (before.blockClass.indexOf('is-note') !== -1) countProduct();
        // This ingredient is done, so it stops taking up half the screen. Only
        // the part below the summary line goes away, so nothing the member is
        // looking at moves — the rest of the list just comes closer (#204).
        row.details.open = false;
        saveSettled(true);
        return;
      }
      restore(row, before);
      showError(
        row,
        (payload && payload.error) || 'Tuotteen tallennus epäonnistui.',
        function () {
          showProduct(row, product);
          persist(row, query, product, extra, before);
        }
      );
      saveSettled(false);
    });
  }

  /* A queued send starts only when every optimistic row agrees with D1. */
  function saveSettled(ok) {
    if (!sendAfterSaves) return;
    if (!ok) sendAfterSaves.failed = true;
    if (savesPending()) return;
    var after = sendAfterSaves;
    sendAfterSaves = null;
    after.done(!after.failed);
  }

  function savesPending() {
    for (var index = 0; index < rows.length; index += 1) {
      if (rows[index].saving) return true;
    }
    return false;
  }

  /**
   * Draw a chosen product into the row, in exactly the shape the server draws
   * in productSummary — same wrapper, same 40 px.
   *
   * "Exactly" is load-bearing rather than tidiness. This runs the instant a
   * member taps Valitse, and a shape of its own is a shape the row's own CSS
   * was not sized for: the 64 px picture this used to build grew the row back
   * to the layout #200 exists to get rid of, at the one moment the member's
   * thumb was on the screen.
   */
  function showProduct(row, product) {
    row.block.className = 's-shopping-product is-mapped';

    // Which dish this row is pinned to is a fact about the row, not about the
    // product, so it survives a change of product — and keeping it is also
    // what keeps a pinned row the height it was.
    var scope = row.body.querySelector('.s-product-scope');

    clear(row.body);
    var summary = el('div', 's-shopping-product-summary');
    if (scope) summary.appendChild(scope);
    var one = el('span', 's-shopping-product-one');
    one.appendChild(productImage(product.imageUrl, PICTURE.summary));
    var copy = el('span', 's-shopping-product-copy');
    copy.appendChild(el('strong', '', product.name));
    copy.appendChild(el('span', 'meta', 'EAN ' + product.ean));
    one.appendChild(copy);
    summary.appendChild(one);
    row.body.appendChild(summary);

    if (row.thumb) {
      clear(row.thumb);
      row.thumb.appendChild(productImage(product.imageUrl, PICTURE.row));
    }

    setOpenerLabel(row, 'Vaihda tuote');
    // The row has something to add a second size to now. Enabling rather than
    // unhiding, so the button was already taking up its own space and the rows
    // below do not move (#200).
    for (var which = 0; which < row.openers.length; which += 1) {
      var opener = openerButton(row.openers[which]);
      if (opener) opener.disabled = false;
    }
  }

  /* The row's busy line, filled and emptied — never added and removed. The
     server ships the element on every row, so it holds its own height whether
     a save is running or not and the list does not move when one starts. */
  function status(row, text) {
    if (!row.status) return;
    if (text === null) {
      clear(row.status);
      return;
    }
    busy(row.status, text);
  }

  // --------------------------------------------------------------- refusals
  //
  // A failed save used to insert a paragraph next to the row, which moved every
  // row under it at the worst possible moment — the member had just been told
  // something went wrong and the thing they were reading slid away (#200). One
  // fixed strip above the tab bar says it instead, and it is over the list
  // rather than in it.

  var toast = null;

  function toastNode() {
    if (toast) return toast;
    toast = el('div', 's-toast');
    toast.setAttribute('role', 'alert');
    toast.hidden = true;
    document.body.appendChild(toast);
    return toast;
  }

  function clearError(row) {
    if (toast) toast.hidden = true;
  }

  function showError(row, message, retry) {
    var node = toastNode();
    clear(node);
    node.appendChild(el('span', 's-toast-text', message));
    var again = el('button', '', 'Yritä uudelleen');
    again.type = 'button';
    again.addEventListener('click', function () {
      node.hidden = true;
      retry();
    });
    node.appendChild(again);
    var away = el('button', 'quiet', 'Sulje');
    away.type = 'button';
    away.addEventListener('click', function () { node.hidden = true; });
    node.appendChild(away);
    node.hidden = false;
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
      text += ' · ' + notes + (notes === 1 ? ' teksti' : ' tekstiä');
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
      note(null, null);

      function releaseSend() {
        sending = false;
        button.disabled = false;
        button.innerHTML = label;
      }

      function sendNow() {
        busy(button, 'Lähetetään…');
        request(
          'POST',
          '/ostoslista/laheta',
          fieldsOf(form, { muoto: 'json' }, null),
          function (ok, payload) {
            releaseSend();
            if (ok && payload && typeof payload.sent === 'number') {
              note(
                'shopping-sent',
                payload.sent + ' ainesta lähetettiin S-ostoslistaan.'
              );
              // The items are on the list either way; this only says whether the
              // phone was told about them now or will be at the next sweep.
              if (payload.synced === false) {
                note(
                  'refused',
                  payload.warning ||
                    'Puhelimen S-ostoslistan päivitystä ei saatu käynnistettyä.'
                );
              }
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
      }

      if (savesPending()) {
        busy(button, 'Tallennetaan valintoja…');
        sendAfterSaves = {
          failed: false,
          done: function (ready) {
            if (ready) {
              sendNow();
              return;
            }
            releaseSend();
            note(
              'refused',
              'Lähetystä ei aloitettu, koska tuotteen tallennus epäonnistui. Korjaa valinta ja yritä uudelleen.'
            );
          }
        };
        return;
      }

      sendNow();
    });
  }

  var sendNotes = [];

  /* note(null, null) clears what the last send said; anything else adds a line. */
  function note(className, text) {
    if (className === null) {
      for (var index = 0; index < sendNotes.length; index += 1) {
        var old = sendNotes[index];
        if (old.parentNode) old.parentNode.removeChild(old);
      }
      sendNotes = [];
      return;
    }
    var panel = document.querySelector('.s-shopping-send');
    if (!panel) return;
    var line = el('p', className, text);
    panel.appendChild(line);
    sendNotes.push(line);
  }

  // --------------------------------------------- what the S list already has

  var NOTHING_LEFT = 'S-ostoslistalla ei ole keräämättömiä rivejä.';
  var removing = false;
  /* Which drawing of the panel a pending delete belongs to. A send refreshes
     the panel from the service, and that answer is newer than anything a
     failed delete could put back. */
  var drawing = 0;

  function loadCurrent() {
    var panel = document.querySelector('.s-current');
    if (!panel) return;
    var state = panel.querySelector('.s-current-state');
    var list = panel.querySelector('.s-current-items');
    panel.hidden = false;
    clear(list);
    state.hidden = false;
    drawing += 1;
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
        state.appendChild(document.createTextNode(NOTHING_LEFT));
        return;
      }
      state.hidden = true;
      for (var index = 0; index < items.length; index += 1) {
        list.appendChild(currentRow(items[index], list, state));
      }
    });
  }

  /* One still-to-buy row, and the button that takes it off the S list. */
  function currentRow(item, list, state) {
    var entry = document.createElement('li');
    entry.className = item.ean ? 's-current-product' : 's-current-note';
    entry.appendChild(el('span', 's-current-name', item.name));
    entry.appendChild(el('span', 'meta', item.ean ? 'Tuote' : 'Teksti'));

    var drop = el('button', 's-current-remove', '✕');
    drop.type = 'button';
    // The mark alone is the whole button, so the name it removes has to be in
    // the label rather than only beside it.
    drop.setAttribute('aria-label', 'Poista S-ostoslistalta: ' + item.name);
    entry.appendChild(drop);
    drop.addEventListener('click', function () {
      removeCurrent(item, entry, list, state);
    });
    return entry;
  }

  /**
   * The row goes at once and comes back if the service refuses it. One at a
   * time, like everything else here: a second delete while one is in flight
   * would be two optimistic removals racing one restore.
   */
  function removeCurrent(item, entry, list, state) {
    if (removing || !entry.parentNode) return;
    removing = true;
    var drawn = drawing;
    var after = entry.nextSibling;
    list.removeChild(entry);
    clear(state);
    state.hidden = list.firstChild !== null;
    if (!state.hidden) state.appendChild(document.createTextNode(NOTHING_LEFT));

    var body = item.ean
      ? 'ean=' + encodeURIComponent(item.ean)
      : 'teksti=' + encodeURIComponent(item.name);
    request('POST', '/ostoslista/s-lista/poista', body, function (ok, payload) {
      removing = false;
      if (ok) return;
      // The panel has been redrawn from the service since; that answer is
      // newer than this row, so it is left alone.
      if (drawn !== drawing) return;
      // Nothing was removed, so the row goes back exactly where it stood.
      list.insertBefore(entry, after && after.parentNode === list ? after : null);
      clear(state);
      state.hidden = false;
      state.appendChild(
        document.createTextNode(
          ((payload && payload.error) ||
            'Rivin poisto S-ostoslistalta ei onnistunut. Yritä uudelleen.') + ' '
        )
      );
      var again = el('button', '', 'Yritä uudelleen');
      again.type = 'button';
      again.addEventListener('click', function () {
        clear(state);
        state.hidden = true;
        removeCurrent(item, entry, list, state);
      });
      state.appendChild(again);
    });
  }

  // ------------------------------------------------------------------ wiring

  collect();
  for (var index = 0; index < rows.length; index += 1) {
    (function (row) {
      for (var which = 0; which < row.openers.length; which += 1) {
        (function (form) {
          form.addEventListener('submit', function (event) {
            event.preventDefault();
            var mode = form.getAttribute('data-tapa') || 'korvaa';
            // The same button again closes the sheet; the other one switches
            // what the open sheet is for rather than opening a second.
            if (sheetIsOpenFor(row) && row.mode === mode) {
              closeSheet();
              return;
            }
            openSheet(row, mode);
          });
        })(row.openers[which]);
      }
    })(rows[index]);
  }
  document.addEventListener('keydown', function (event) {
    var escape = event.key === 'Escape' || event.key === 'Esc' || event.keyCode === 27;
    if (escape) closeSheet();
  });
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
