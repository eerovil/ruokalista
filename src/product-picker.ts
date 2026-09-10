import { problem } from "./auth.ts";
import { html, raw, type Raw } from "./html.ts";
import type { Member } from "./members.ts";
import {
  saveIngredientProduct,
  saveRecipeProduct,
  type ProductChoice,
} from "./ingredient-products.ts";
import { baseAmount, packageSizeFromName } from "./packaging.ts";
import { formatDecimal } from "./quantities.ts";
import type { RouteContext } from "./router.ts";
import {
  SOstoslistaClient,
  sProductImageAtWidth,
  type SOstoslistaProduct,
} from "./s-ostoslista.ts";

/**
 * Choosing which shop product an ingredient is — the one component, wherever it
 * is asked for.
 *
 * It started as part of the shopping list (#147, #159, #161, #200, #204) and
 * that is still where most of it is used. #302 asks for the same thing from a
 * recipe's ingredient row, and asks for it to be *the same thing*: one search
 * panel, one result list, one selection rule, one saved mapping. So the markup,
 * the save and the household gate live here, and each screen supplies only what
 * is genuinely its own — which row this is, where its forms post, and where a
 * member lands afterwards.
 *
 * The browser half of the same component is `src/client/product-picker.ts`,
 * embedded by both screens. Everything below draws a shape that client already
 * knows, so a screen that renders `productBlock` gets the fixed sheet, the
 * optimistic selection and the spinner for free — and cannot drift away from
 * how the shopping list behaves, because there is nothing separate to drift.
 */

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
 * picker client below, so a slot's size lives in one place.
 */
export const PRODUCT_PICTURE = {
  row: { size: 26, width: 96 },
  summary: { size: 40, width: 128 },
  result: { size: 80, width: 192 },
} as const;

type PictureSlot = (typeof PRODUCT_PICTURE)[keyof typeof PRODUCT_PICTURE];

export function productPicture(url: string, slot: PictureSlot): Raw {
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
 * The settings the browser half reads before it does anything at all. One
 * hidden element per screen, so a screen that has no picker draws no client
 * state and the client stops at its first query.
 */
export function pickerSettings(): Raw {
  return html`<div
    class="s-picker-settings"
    hidden
    data-product-picture="${JSON.stringify(PRODUCT_PICTURE)}"
  ></div>`;
}

/** One packet of a chosen product, and how many of it this row wants. */
export interface ChosenProduct {
  product: ProductChoice;
  count: number;
}

/**
 * A row the picker can act on, whichever screen drew it.
 *
 * `ShoppingItem` satisfies this structurally, which is deliberate: the shopping
 * list's row *is* the thing this component was written for, and a second screen
 * earns the same component by describing its row in the same words rather than
 * by getting a variant of the component.
 */
export interface ProductSubject {
  /** What a form calls this row. The screen's own routes decide what it means. */
  key: string;
  ingredientId: number;
  /** Set only on a row that already follows one dish's own product. */
  recipeId: number | null;
  recipeTitle: string | null;
  name: string;
  /** `5 dl + 2 rkl` — what this row wants, said the way the screen says it. */
  total: string;
  /** Everything this row could be bought as. */
  products: ProductChoice[];
  /** What to actually buy. Empty when nothing is chosen. */
  chosen: ChosenProduct[];
  /** `800 g` — what the chosen packages hold, where a count was worked out. */
  packageTotal: string | null;
  /** The dishes this row's amount came from, for the "in this recipe" choice. */
  recipes: Array<{ id: number; title: string }>;
}

/**
 * Where one screen's picker forms go, and what they carry.
 *
 * This is the whole of what differs between the shopping list and a recipe.
 * Everything else — the panel, the results, the scope choice, the save's
 * refusals — is the same component in both places.
 */
export interface PickerRoutes {
  /** GET target of the open button and of the no-JavaScript search form. */
  open: string;
  /** POST target of a selection. */
  save: string;
  /** POST target for dropping a package size, where the screen offers one. */
  remove: string | null;
  /** Where "← Takaisin" goes, and where a saved choice lands. */
  back: string;
  /** The hidden fields that name this row on every one of those forms. */
  fields: Raw;
}

/** A compact row shows the chosen product and nothing else around it. */
export interface BlockOptions {
  compact?: boolean;
}

const rawDisabled = raw("disabled");

/**
 * What this row is buying, and the buttons that change it.
 *
 * The intelligence stays behind the row (#161): a member reads the product,
 * how many of it, and — where a recipe has its own — which dish this row
 * belongs to. There is no rule editor and no settings page; the two things
 * anybody needs to say are said by opening the product panel from here, either
 * to change the product or to teach the ingredient another package size.
 *
 * A compact block (#302, the recipe screen) draws the same shape with the
 * package sizes and the second-size button left out. It is the same element
 * tree the browser half writes into, which is the point — a recipe row that
 * drew a shape of its own would be a shape `showProduct` was not sized for,
 * which is exactly the fault #200 spent a pull request removing.
 */
export function productBlock(
  subject: ProductSubject,
  routes: PickerRoutes,
  options: BlockOptions = {},
): Raw {
  const mapped = subject.chosen.length > 0;
  const compact = options.compact === true;
  // A recipe row has to fit an amount, an ingredient and this on one line of a
  // phone, and the sheet's own heading already names the ingredient — so the
  // button says only what it does and the product's name keeps the width.
  const chooseLabel = compact ? "Valitse" : "Valitse tuote";
  const changeLabel = compact ? "Vaihda" : "Vaihda tuote";

  return html`<div
    class="${compact
      ? `s-shopping-product is-compact ${mapped ? "is-mapped" : "is-note"}`
      : `s-shopping-product ${mapped ? "is-mapped" : "is-note"}`}"
  >
    <div class="s-shopping-product-body">
      ${mapped
        ? productSummary(subject)
        : compact
          ? html`<div class="s-shopping-product-copy">
              <span class="meta">Ei tuotetta</span>
            </div>`
          : html`<div class="s-shopping-product-copy">
              <strong>Teksti</strong>
              <span class="meta"
                >Lähetetään tekstinä: ${subject.name} — ${subject.total}</span
              >
            </div>`}
    </div>
    ${openForm(
      subject,
      routes,
      "korvaa",
      mapped ? changeLabel : chooseLabel,
      false,
      changeLabel,
    )}
    <p class="s-status" role="status" aria-live="polite"></p>
    ${compact || subject.recipeId !== null
      ? ""
      : openForm(subject, routes, "lisaa", "Lisää toinen pakkauskoko", !mapped)}
    ${compact ? "" : knownProducts(subject, routes)}
    ${scopeSource(subject)}
  </div>`;
}

/** Only a mapped row has a picture, and only where the screen shows one. */
export function productThumbnail(subject: ProductSubject): Raw {
  const image = subject.chosen[0]?.product.imageUrl ?? null;
  if (image === null) return html``;
  return productPicture(image, PRODUCT_PICTURE.row);
}

/**
 * The scope choice, drawn by the server and hidden, for the typed picker client
 * to lift into its panel.
 *
 * It sits outside every form on the row on purpose — a hidden `<select>` inside
 * another of the row's forms would be posted along with it — and it is rendered
 * here rather than built in JavaScript so a dish's title is escaped by the same
 * `html` tag as everything else.
 */
function scopeSource(subject: ProductSubject): Raw {
  if (subject.recipeId !== null || subject.recipes.length === 0) return html``;
  return html`<div class="s-scope-source" hidden>${scopeChoice(subject, "replace")}</div>`;
}

/**
 * One button that opens the product panel — in the browser, or as a plain
 * navigation to the screen's own product page where it cannot.
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
 * plainly that there is nothing to add a size to yet, and the typed picker
 * client only has to enable it.
 *
 * `data-tallenna` is how the browser half knows where a selection posts, and
 * `data-vaihda` what this screen calls the button once something is chosen.
 * Both are on the form rather than compiled into the client because the client
 * is one component serving two screens, and the row is the thing that knows
 * which one it is.
 */
function openForm(
  subject: ProductSubject,
  routes: PickerRoutes,
  mode: "korvaa" | "lisaa",
  label: string,
  disabled = false,
  changeLabel = "Vaihda tuote",
): Raw {
  return html`<form
    method="get"
    action="${routes.open}"
    class="inline s-product-open"
    data-tapa="${mode}"
    data-tallenna="${routes.save}"
    data-vaihda="${changeLabel}"
  >
    <input type="hidden" name="rivi" value="${subject.key}" />
    <input type="hidden" name="tapa" value="${mode}" />
    <input type="hidden" name="haku" value="${subject.name}" />
    ${routes.fields}
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
function knownProducts(subject: ProductSubject, routes: PickerRoutes): Raw {
  const pinned = subject.recipeId !== null;
  if (routes.remove === null) return html``;
  if (!pinned && subject.products.length < 2) return html``;

  return html`<ul class="s-product-sizes">
    ${subject.products.map(
      (product) => html`<li>
        <span class="s-product-size-name">${product.name}</span>
        <span class="meta"
          >${product.packageQuantity === null || product.packageUnit === null
            ? "pakkauskoko tuntematon"
            : `${formatDecimal(product.packageQuantity)} ${product.packageUnit}`}</span
        >
        <form method="post" action="${routes.remove}" class="inline">
          <input type="hidden" name="rivi" value="${subject.key}" />
          <input type="hidden" name="ean" value="${product.ean}" />
          ${routes.fields}
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
export function productSummary(subject: ProductSubject): Raw {
  return html`<div class="s-shopping-product-summary">
    ${subject.recipeTitle === null
      ? ""
      : html`<span class="s-product-scope meta"
          >Vain reseptissä ${subject.recipeTitle}</span
        >`}
    ${subject.chosen.map(
      ({ product, count }) => html`<span class="s-shopping-product-one">
        ${product.imageUrl === null
          ? ""
          : productPicture(product.imageUrl, PRODUCT_PICTURE.summary)}
        <span class="s-shopping-product-copy">
          <strong>${count > 1 ? `${count} × ` : ""}${product.name}</strong>
          <span class="meta">EAN ${product.ean}</span>
        </span>
      </span>`,
    )}
    ${subject.packageTotal === null
      ? ""
      : html`<span class="s-package-total meta"
          >Pakkauksissa yhteensä ${subject.packageTotal}</span
        >`}
  </div>`;
}

/**
 * The no-JavaScript product screen: search, results, choose. It is the same
 * page on either screen, because the only thing that differs is where the forms
 * post and where "Takaisin" goes — and those are the routes above.
 */
export function productSearchBody(
  subject: ProductSubject,
  routes: PickerRoutes,
  mode: "replace" | "add",
  query: string,
  products: SOstoslistaProduct[],
  refused: string | null,
  backLabel: string,
): Raw {
  const heading = productSearchHeading(subject, mode);
  return html`<p><a href="${routes.back}">← ${backLabel}</a></p>
    <h1>${heading}</h1>
    ${refused === null ? "" : html`<p class="refused">${refused}</p>`}
    <form method="get" action="${routes.open}" class="stacked product-search-form">
      <input type="hidden" name="rivi" value="${subject.key}" />
      <input type="hidden" name="tapa" value="${mode === "add" ? "lisaa" : "korvaa"}" />
      ${routes.fields}
      <label>
        Haku
        <input type="search" name="haku" value="${query}" required />
      </label>
      <button type="submit" class="primary">Hae tuotteita</button>
    </form>
    ${products.length === 0 && refused === null
      ? html`<p class="empty">Haulla ei löytynyt tuotteita.</p>`
      : productResults(subject, routes, mode, query, products)}`;
}

export function productSearchHeading(
  subject: ProductSubject,
  mode: "replace" | "add",
): string {
  return mode === "add"
    ? `Lisää pakkauskoko: ${subject.name}`
    : `Valitse tuote: ${subject.name}`;
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
function scopeChoice(subject: ProductSubject, mode: "replace" | "add"): Raw {
  if (mode === "add" || subject.recipeId !== null || subject.recipes.length === 0) {
    return html``;
  }

  return html`<label class="s-product-scope-choice">
    Valinnan laajuus
    <select name="laajuus">
      <option value="aines">Käytä aina tälle ainekselle</option>
      ${subject.recipes.map(
        (recipe) => html`<option value="${recipe.id}">
          Käytä tässä reseptissä: ${recipe.title}
        </option>`,
      )}
    </select>
  </label>`;
}

function productResults(
  subject: ProductSubject,
  routes: PickerRoutes,
  mode: "replace" | "add",
  query: string,
  products: SOstoslistaProduct[],
): Raw {
  return html`<form method="post" action="${routes.save}" class="s-product-choice">
    <input type="hidden" name="rivi" value="${subject.key}" />
    <input type="hidden" name="haku" value="${query}" />
    <input type="hidden" name="tapa" value="${mode === "add" ? "lisaa" : "korvaa"}" />
    ${routes.fields}
    ${scopeChoice(subject, mode)}
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
      ${size === null
        ? ""
        : html`<span class="meta s-product-size"
            >Pakkaus ${formatDecimal(size.quantity)} ${size.unit}</span
          >`}
    </div>
    ${size === null ? packageSizeFields(product) : ""}
    <button type="submit" class="primary" name="ean" value="${product.ean}">
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

// ---------------------------------------------------------------- the saving

/** Replace what this ingredient is, or add another packet of the same thing. */
export function chosenMode(
  value: FormDataEntryValue | string | null,
): "replace" | "add" {
  return String(value ?? "") === "lisaa" ? "add" : "replace";
}

/**
 * How far the choice reaches: every use of this ingredient, or one dish's.
 *
 * The recipe has to be one the row actually came from. A member choosing a
 * scope from a screen they can see cannot thereby pin an ingredient inside
 * somebody else's week.
 */
export function chosenScope(
  subject: ProductSubject,
  value: FormDataEntryValue | string | null,
): "ingredient" | { recipeId: number } | null {
  const asked = String(value ?? "").trim();
  if (asked === "" || asked === "aines") return "ingredient";
  const recipeId = Number(asked);
  if (!Number.isSafeInteger(recipeId)) return null;
  return subject.recipes.some((one) => one.id === recipeId) ? { recipeId } : null;
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

export interface SavedProduct {
  ean: string;
  name: string;
  imageUrl: string;
  packageQuantity: number | null;
  packageUnit: string | null;
}

export type SaveOutcome =
  | { ok: true; product: SavedProduct; scope: "ingredient" | { recipeId: number } }
  | { ok: false; message: string; status: number; products: SOstoslistaProduct[] };

/**
 * Take one selection and write it down — the whole rule, in one place.
 *
 * The re-search is the boundary #147 drew and #302 does not move: whichever
 * screen a member chose from, the product's name, EAN, picture and package size
 * come back from the shop rather than from the form, so a browser cannot invent
 * a product by posting one. Nothing is written until that check has passed, so
 * every refusal below leaves the mapping exactly as the member found it.
 */
export async function saveChosenProduct(
  db: D1Database,
  householdId: number,
  client: SOstoslistaClient,
  subject: ProductSubject,
  form: FormData,
): Promise<SaveOutcome> {
  const mode = chosenMode(form.get("tapa"));
  const query = String(form.get("haku") ?? "").trim();
  const ean = String(form.get("ean") ?? "").trim();
  const scope = chosenScope(subject, form.get("laajuus"));

  if (scope === null) {
    return {
      ok: false,
      message: "Valinnan laajuutta ei tunnistettu. Mitään ei tallennettu.",
      status: 400,
      products: [],
    };
  }

  let products: SOstoslistaProduct[];
  try {
    products = await client.search(query);
  } catch (error) {
    console.error(`S-ostoslista product selection search failed: ${reason(error)}`);
    return {
      ok: false,
      message: "Tuotetta ei voitu varmistaa S-ostoslistasta. Mitään ei tallennettu.",
      status: 502,
      products: [],
    };
  }

  const selected = products.find((product) => product.ean === ean);
  if (selected === undefined) {
    return {
      ok: false,
      message: "Valittua tuotetta ei löytynyt uudesta hausta. Mitään ei tallennettu.",
      status: 400,
      products,
    };
  }

  const size = statedSize(form, selected.ean) ?? packageSizeFromName(selected.name);
  const toSave: SavedProduct = {
    ean: selected.ean,
    name: selected.name,
    imageUrl: selected.imageUrl,
    packageQuantity: size?.quantity ?? null,
    packageUnit: size?.unit ?? null,
  };

  if (scope === "ingredient") {
    await saveIngredientProduct(db, subject.ingredientId, toSave, mode);
  } else {
    await saveRecipeProduct(
      db,
      householdId,
      scope.recipeId,
      subject.ingredientId,
      toSave,
    );
  }

  return { ok: true, product: toSave, scope };
}

/** The JSON answer both screens give the typed picker client. */
export function savedProductJson(product: SavedProduct, reload: boolean): Response {
  return Response.json({ product, reload });
}

/** The JSON refusal both screens give it. */
export function refusedProductJson(outcome: {
  message: string;
  status: number;
}): Response {
  return problem(outcome.status, outcome.message);
}

// ------------------------------------------------------------------ the gate

/**
 * A URL means "call the service over HTTP", which is how the browser tests
 * reach their fixture. Otherwise the bound Worker is the transport, and the
 * base URL only has to be a valid absolute URL for the client to resolve paths
 * against — the binding decides where the request actually goes, so the
 * hostname below is never resolved.
 */
const BOUND_SERVICE_BASE = "https://s-ostoslista-worker.invalid/";

/**
 * The one gate, and the only thing that decides whether any of this exists for
 * a member.
 *
 * It is deliberately a single function rather than a flag threaded around: the
 * integration belongs to one configured household (#147), and #302 adds a
 * second screen that must answer exactly the same way. Every route that touches
 * the picker calls this first and answers a bare 404 when it is null — not a
 * 403, because whether another household has an S-ostoslista is not their
 * business, and not a hidden button, because a hidden button is not a gate.
 */
export function externalClient(
  env: RouteContext["env"],
  member: Member,
): SOstoslistaClient | null {
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
export function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
