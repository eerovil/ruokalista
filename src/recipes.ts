import { problem } from "./auth.ts";
import { castSender } from "./cast.ts";
import {
  ALTERNATIVE_WORD,
  alternativeSets,
  sharedSource,
} from "./alternatives.ts";
import {
  CATEGORY_STYLE,
  SELECTION_COUNT_ISLAND,
  categoryBulkControls,
  loadVocabulary,
  type Vocabulary,
} from "./categories.ts";
import { cookHistory } from "./cook-history.ts";
import {
  browseFields,
  browseHref,
  browseStateFrom,
  HIDE_SHARED,
  recipeBrowser,
  SHOW_SHARED,
  type BrowseState,
} from "./recipe-browser.ts";
import { recipeImage, type Pictured } from "./recipe-picture.ts";
import recipeProductsClient from "./generated/recipe-products.ts";
import {
  editBlockOpenHref,
  html,
  multiplierField,
  page,
  raw,
  type Raw,
  saveBar,
} from "./html.ts";
import { resolveMentions } from "./ingredient-refs.ts";
import { keepAwake } from "./keep-awake.ts";
import type { Member } from "./members.ts";
import {
  externalClient,
  pickerSettings,
  productBlock,
  type ProductSubject,
} from "./product-picker.ts";
import {
  recipeProductState,
  recipeRoutes,
  subjectFromState,
  type RecipeProductState,
} from "./recipe-products.ts";
import { formatMeasurement } from "./quantities.ts";
import { normaliseRecipeUrl } from "./recipe-fetch.ts";
import type { RecipePhase } from "./recipe-phase.ts";
import {
  recipeSharingState,
  type RecipeSharingState,
  type SharingDraft,
} from "./recipe-publish.ts";
import { preferredMultiplierFor } from "./recipe-preference.ts";
import {
  findReadableRecipe,
  publicRecipeSummaries,
  recipeSummaries,
  type Recipe,
  type RecipeLine,
  type RecipeStep,
  type RecipeSummary,
} from "./recipe-read.ts";
import {
  DEFAULT_MULTIPLIER,
  formatMultiplier,
  parseMultiplier,
  scaleMeasurement,
  sourceWorthShowing,
} from "./scaling.ts";
import type { RouteContext } from "./router.ts";
import { cookieValue } from "./signing.ts";

/**
 * Recipe HTTP/API and rendering adapters.
 *
 * The authoritative recipe read model and D1 folding live in `recipe-read.ts`.
 * This module owns the wire adapters and the server-rendered list/detail views.
 */
export {
  findReadableRecipe,
  findRecipe,
  plannableRecipeSummaries,
  publicRecipeSummaries,
  recipeSummaries,
} from "./recipe-read.ts";
export type {
  Recipe,
  RecipeLine,
  RecipeStep,
  RecipeSummary,
} from "./recipe-read.ts";
// Where a picture and the browse state are drawn moved out of this module; the
// names stay importable from here, which is where every screen already looks.
export { recipeImage, type Pictured } from "./recipe-picture.ts";
export {
  askedCategory,
  browseStateFrom,
  type BrowseState,
} from "./recipe-browser.ts";

/** `GET /api/recipes?q=` */
export async function apiListRecipes(
  { env, url }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipes = await recipeSummaries(
    env.DB,
    member.householdId,
    url.searchParams.get("q") ?? "",
  );

  return Response.json({ recipes: recipes.map(summaryForApi) });
}

/** The wire shape this list has always had. See `recipeForApi`. */
function summaryForApi(summary: RecipeSummary): object {
  const {
    householdId: _householdId,
    householdName: _householdName,
    publishedAt: _publishedAt,
    shareCount: _shareCount,
    categories: _categories,
    empty: _empty,
    ...wire
  } = summary;
  return wire;
}

/** `GET /api/recipes/:id` */
export async function apiShowRecipe(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipe = await loadRequested(env.DB, member, params["id"]);
  if (recipe === null) return problem(404, "No such recipe.");
  return Response.json({ recipe: recipeForApi(recipe, member.householdId) });
}

/**
 * Keep the existing JSON shape; phases and ingredient mentions are internal
 * cooking-view concerns. Ownership, publication, categories and linked product
 * pictures likewise stay out of the historical API shape.
 */
function recipeForApi(recipe: Recipe, viewerHouseholdId: number): object {
  const {
    householdId: _householdId,
    householdName: _householdName,
    publishedAt: _publishedAt,
    shareCount: _shareCount,
    categories: _categories,
    empty: _empty,
    parentId: _parentId,
    parentTitle: _parentTitle,
    ...wire
  } = recipe;

  return {
    ...wire,
    createdBy: recipe.householdId === viewerHouseholdId
      ? recipe.createdBy
      : recipe.householdName,
    steps: recipe.steps.map((step) => step.text),
    lines: recipe.lines.map(
      ({
        phase: _phase,
        ingredientId: _ingredientId,
        productImageUrl: _productImageUrl,
        ...line
      }) => line,
    ),
    parts: recipe.parts.map((part) => recipeForApi(part, viewerHouseholdId)),
  };
}

/** `GET /recipes` — the recipe list screen. */
export async function recipeListScreen(
  { env, request, url }: RouteContext,
  member: Member,
): Promise<Response> {
  const vocabulary = await loadVocabulary(env.DB);
  const asked = url.searchParams.get("jaetut");
  const state = {
    ...browseStateFrom(vocabulary, url.searchParams),
    hideShared: asked === null
      ? sharedHiddenByDefault(request)
      : asked === HIDE_SHARED,
  };
  const response = page(
    "Reseptit",
    await recipeList(env.DB, vocabulary, member, state, null),
    "recipes",
    member,
  );
  if (asked === HIDE_SHARED || asked === SHOW_SHARED) {
    response.headers.append("Set-Cookie", sharedCookie(state.hideShared));
  }
  return response;
}

/**
 * Whether shared recipes are hidden is remembered per browser (#335): a member
 * who only ever wants their own list should not have to ask for it on every
 * visit. A cookie rather than a member setting, because it is a view of a list
 * on one device, and the URL's `jaetut` always wins over it.
 */
const SHARED_COOKIE = "ruokalista_jaetut";
const SHARED_COOKIE_SECONDS = 365 * 24 * 60 * 60;

function sharedHiddenByDefault(request: Request): boolean {
  return cookieValue(request.headers.get("Cookie"), SHARED_COOKIE) === HIDE_SHARED;
}

function sharedCookie(hidden: boolean): string {
  return [
    `${SHARED_COOKIE}=${hidden ? HIDE_SHARED : ""}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${hidden ? SHARED_COOKIE_SECONDS : 0}`,
  ].join("; ");
}

/** A word said back after a bulk action, or the reason one did not happen. */
export interface ListNotice {
  message: string;
  refused: boolean;
}

/**
 * The household's recipes, with what other households share mixed in (#335).
 *
 * One list rather than a separate "Jaetut reseptit" section: a member looking
 * for something to cook does not first decide whose kitchen it comes from. A
 * shared dish says whose it is and has no tick, because the bulk actions —
 * publishing, categories — only ever act on this household's own recipes.
 */
export async function recipeList(
  db: D1Database,
  vocabulary: Vocabulary,
  member: Member,
  state: BrowseState,
  notice: ListNotice | null,
  bulkCategory: string | null = null,
): Promise<Raw> {
  const [own, shared, history] = await Promise.all([
    recipeSummaries(db, member.householdId, state.query),
    publicRecipeSummaries(db, member.householdId, state.query),
    cookHistory(db, member.householdId),
  ]);
  const everything = state.hideShared ? own : newestFirst([...own, ...shared]);
  // Another household's empty dish never reaches this list (the readable
  // scope drops it), so "only empty" is only ever this household's own.
  const matching = state.onlyEmpty
    ? everything.filter((recipe) => recipe.empty)
    : everything;
  const anyEmpty = own.some((recipe) => recipe.empty);

  return html`<h1>Reseptit</h1>
    ${recipeBrowser(
      { path: "/recipes" },
      {
        state,
        vocabulary,
        matching,
        history,
        viewerHouseholdId: member.householdId,
        filters: html`${shared.length > 0 || state.hideShared
          ? sharedToggle(state)
          : ""}${anyEmpty || state.onlyEmpty ? emptyToggle(state) : ""}`,
        notice: noticeLine(notice),
        emptyAll: state.onlyEmpty
          ? "Tyhjiä reseptejä ei ole."
          : "Reseptejä ei ole vielä yhtään.",
        emptyAction: html`<p>
          <a class="button" href="/intake">Lisää ensimmäinen</a>
        </p>`,
        listClass: "recipes is-selectable",
        row: (recipe, card) =>
          recipe.householdId === member.householdId
            ? html`<input
                  type="checkbox"
                  name="recipeId"
                  value="${recipe.id}"
                  class="recipe-pick"
                  aria-label="Valitse ${recipe.title}"
                />
                <a href="/recipes/${recipe.id}"
                  >${card}${emptyBadge(recipe)}${sharingBadge(recipe)}</a
                >`
            : // An unticked, invisible box keeps the row lined up with the
              // ones that can be ticked. It has no name, so it posts nothing.
              html`<input
                  type="checkbox"
                  class="recipe-pick-gap"
                  disabled
                  tabindex="-1"
                  aria-hidden="true"
                />
                <a href="/recipes/${recipe.id}"
                  >${card}<span class="badge is-shared"
                    >${recipe.publishedAt === null ? "Jaettu sinulle" : "Julkinen"}</span
                  ></a
                >`,
        // The list rides inside the form the bulk actions post, so ticking a
        // row means one thing on this screen rather than two.
        wrap: (list) => html`<form
          method="post"
          action="/recipes/julkaisu"
          class="stacked"
        >
          ${browseFields(state)} ${list}
          <p class="selection-count">
            Toiminto kohdistuu valitsemiisi resepteihin.
          </p>
          ${categoryBulkControls(vocabulary, bulkCategory)}
          <p class="bulk-actions">
            <button type="submit" name="action" value="publish">
              Julkaise valitut
            </button>
            <button type="submit" name="action" value="unpublish">
              Poista julkaisu valituista
            </button>
          </p>
          <script>${raw(SELECTION_COUNT_ISLAND)}</script>
        </form>`,
      },
    )}
    ${PUBLISH_STYLE}
    ${CATEGORY_STYLE}`;
}

/**
 * Newest first across both kitchens, by when each recipe was added. Both lists
 * arrive sorted already; this only interleaves them.
 */
function newestFirst(recipes: RecipeSummary[]): RecipeSummary[] {
  return recipes.sort((a, b) =>
    a.createdAt === b.createdAt
      ? b.id - a.id
      : b.createdAt.localeCompare(a.createdAt),
  );
}

/**
 * "Piilota jaetut reseptit", drawn as a checkbox but made of a link, like the
 * chips beside it: the choice is a place in the URL, so it needs no script and
 * survives the back button. Turning it off has to say so out loud
 * (`jaetut=nayta`), or the remembered cookie would hide them again.
 */
function sharedToggle(state: BrowseState): Raw {
  const screen = { path: "/recipes" };
  const href = state.hideShared
    ? browseHref(
      { ...screen, carried: { jaetut: SHOW_SHARED } },
      { ...state, hideShared: false },
    )
    : browseHref(screen, { ...state, hideShared: true });
  return html`<p class="browse-shared">
    <a
      class="browse-toggle"
      href="${href}"
      role="checkbox"
      aria-checked="${state.hideShared ? "true" : "false"}"
      ><span class="browse-toggle-box" aria-hidden="true"
        >${state.hideShared ? "✓" : ""}</span
      >
      Piilota jaetut reseptit</a
    >
  </p>`;
}

/**
 * "Näytä vain tyhjät" (#340): the name-only saves still waiting to be written
 * down, found in one tap. The same link-drawn-as-a-checkbox as the shared one,
 * and for the same reasons; unlike that one it is not remembered, because it
 * is an errand rather than a way of looking at the list.
 */
function emptyToggle(state: BrowseState): Raw {
  const href = browseHref(
    { path: "/recipes" },
    { ...state, onlyEmpty: !state.onlyEmpty },
  );
  return html`<p class="browse-shared">
    <a
      class="browse-toggle"
      href="${href}"
      role="checkbox"
      aria-checked="${state.onlyEmpty ? "true" : "false"}"
      ><span class="browse-toggle-box" aria-hidden="true"
        >${state.onlyEmpty ? "✓" : ""}</span
      >
      Näytä vain tyhjät</a
    >
  </p>`;
}

/** An empty dish says so on its row (#340), so it is not mistaken for a meal. */
function emptyBadge(recipe: RecipeSummary): Raw {
  if (!recipe.empty) return raw("");
  return html`<span class="badge is-empty" title="Ei aineksia tai valmistusvaiheita"
    ><span aria-hidden="true">✎</span> Tyhjä</span
  >`;
}

/** `GET /recipes/julkiset` — the old shared section, now part of the list. */
export function publicRecipeListScreen(): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: `/recipes?jaetut=${SHOW_SHARED}` },
  });
}

function sharingBadge(recipe: RecipeSummary): Raw {
  if (recipe.publishedAt !== null) {
    return html`<span class="badge is-published">Julkinen</span>`;
  }
  if (recipe.shareCount > 0) {
    return html`<span class="badge is-published"
      >Jaettu ${recipe.shareCount === 1 ? "1 taloudelle" : `${recipe.shareCount} taloudelle`}</span
    >`;
  }
  return raw("");
}

function noticeLine(notice: ListNotice | null): Raw {
  if (notice === null) return raw("");
  return notice.refused
    ? html`<p class="refused">${notice.message}</p>`
    : html`<p class="done">${notice.message}</p>`;
}

/** `GET /recipes/:id` — one recipe, as it gets read at the hob. */
export async function recipeScreen(
  ctx: RouteContext,
  member: Member,
): Promise<Response> {
  const { env, params, url } = ctx;
  const recipe = await loadRequested(env.DB, member, params["id"]);

  if (recipe === null) {
    return page(
      "Ei löytynyt",
      html`<h1>Ei löytynyt</h1>
        <p class="empty">Tätä reseptiä ei ole.</p>`,
      "recipes",
      member,
      404,
    );
  }

  const asked = parseMultiplier(url.searchParams.get("multiplier") ?? "");
  // PROTOTYPE (#364): which placement of the size control to draw.
  const named = url.searchParams.get("proto");
  const variant = sizeVariant(
    named ?? cookieValue(ctx.request.headers.get("Cookie"), "koko-proto"),
  );

  const response = await renderRecipe(
    env.DB,
    member,
    recipe,
    asked,
    null,
    env.CAST_APP_ID,
    undefined,
    externalClient(env, member) !== null,
    variant,
  );
  if (named !== null) {
    response.headers.append(
      "Set-Cookie",
      `koko-proto=${variant}; Path=/; Max-Age=2592000; SameSite=Lax`,
    );
  }
  return response;
}

type SizeVariant = "a" | "b" | "c";

function sizeVariant(value: string | null): SizeVariant {
  return value === "b" || value === "c" ? value : "a";
}

/**
 * Re-render the recipe screen from a route that needs to show a refusal.
 *
 * `external` says whether this household has the S-ostoslista integration
 * (#302). It defaults to false rather than being read here, because these
 * callers hold a `D1Database` and not an `Env` — and a screen that cannot
 * answer the question must draw none of it rather than guess.
 *
 * What it gates is the picker: the block, the buttons, the row's data
 * attributes, its stylesheet and its script. It deliberately does **not** gate
 * the chosen product's *picture*, which predates this and which
 * `tests/public-recipes.spec.ts` pins on purpose — a household reading a shared
 * dish sees its own mapping's picture. #302 asked whether that should be shut
 * too, since the ingredient dictionary is global; the household that owns the
 * integration said a product picture is fine to be public. Nothing here is
 * waiting on that answer any more.
 */
export async function renderRecipe(
  db: D1Database,
  member: Member,
  recipe: Recipe,
  /** Null is "as this household usually cooks it" (#364). */
  multiplier: number | null,
  refusal: string | null,
  castApplicationId?: string,
  sharingDraft?: SharingDraft,
  external = false,
  variant: SizeVariant = "a",
): Promise<Response> {
  const owned = recipe.householdId === member.householdId;
  const [preference, sharing, vocabulary, products] = await Promise.all([
    preferredMultiplierFor(db, member.householdId, recipe.id),
    owned && recipe.parentId === null
      ? recipeSharingState(db, member.householdId, recipe.id, sharingDraft)
      : Promise.resolve(null),
    loadVocabulary(db),
    external
      ? recipeProductState(db, member.householdId, recipe)
      : Promise.resolve(null),
  ]);

  // The page opens at the household's own size for the dish (#364), so what
  // it shows is what Lisää kokattaviin adds.
  const shown = multiplier ?? preference ?? DEFAULT_MULTIPLIER;

  return page(
    recipe.title,
    recipeBody(recipe, shown, {
      owned,
      preference,
      refusal,
      sharing,
      vocabulary,
      products,
      variant,
    }, castApplicationId),
    "recipes",
    member,
    refusal === null ? 200 : 400,
  );
}

function stepText(
  step: RecipeStep,
  amounts: Map<number, string>,
  idPrefix: string,
): Raw {
  const segments = resolveMentions(step.text, step.refs);
  if (segments.every((segment) => segment.kind === "text")) {
    return html`${step.text}`;
  }

  return html`${segments.map((segment, index) => {
    if (segment.kind === "text") return html`${segment.text}`;

    const amount = amounts.get(segment.ingredientId) ?? "";
    if (amount === "") return html`${segment.text}`;

    const id = `${idPrefix}-${index}`;
    return html`<span class="mention"
      ><input type="checkbox" id="${id}" class="mention-toggle" /><label
        for="${id}"
        ><span class="mention-amount">${amount}</span
        ><span class="mention-word">${segment.text}</span></label
      ></span
    >`;
  })}`;
}

/** Every distinct stated amount this recipe can reveal, keyed by ingredient. */
export function amountsByIngredient(
  lines: readonly RecipeLine[],
  multiplier: number,
): Map<number, string> {
  const collected = new Map<number, Set<string>>();

  for (const line of lines) {
    const amount = formatMeasurement(scaleMeasurement(line, multiplier));
    if (amount === "") continue;
    const values = collected.get(line.ingredientId) ?? new Set<string>();
    values.add(amount);
    collected.set(line.ingredientId, values);
  }

  return new Map(
    [...collected].map(([ingredientId, values]) => [
      ingredientId,
      [...values].join(" / "),
    ]),
  );
}

/**
 * What a recipe screen needs to offer product choice on its ingredient rows.
 *
 * `dish` is the recipe the screen is *about* — never one of its parts — because
 * that is what a product override is keyed by (#161) and what the reader looks
 * it up under. `anchored` hands out `#aines-…` once per ingredient across the
 * whole screen, so a dish and one of its parts naming the same ingredient still
 * leave the round-trip somewhere to land.
 */
interface RecipePicker {
  dish: Recipe;
  state: RecipeProductState;
  anchored: Set<number>;
}

const rawPickerRow = raw("data-product-row");

/**
 * What the shared picker client reads off a row: that it is one, which
 * ingredient it is about, what to search for, and how much of it this recipe
 * wants. The amount is an attribute rather than an element because the row has
 * no room to print it twice — the panel's heading is where it is read.
 */
function pickerRowAttributes(picker: RecipePicker, subject: ProductSubject): Raw {
  const first = !picker.anchored.has(subject.ingredientId);
  picker.anchored.add(subject.ingredientId);
  return html`${rawPickerRow}
    ${first ? raw(`id="aines-${subject.ingredientId}"`) : ""}
    data-aines="${String(subject.ingredientId)}"
    data-haku="${subject.name}"
    data-maara="${subject.total}"`;
}

/**
 * The tick that brings the rows' product buttons back (#305).
 *
 * Reading a recipe is what this screen is for and choosing a shop product is
 * the rare errand, so #302's buttons are hidden until somebody says they are
 * doing a round of product mapping. Off, a mapped row still shows which product
 * it is — the name and the picture stay; only the way to change it goes.
 *
 * It is a real checkbox drawn as a switch in a row of the ⋯ modal (#354), so
 * it takes focus and answers Space like any checkbox. What hides the buttons
 * is CSS reading `:checked` on it — `.recipe-view:has(.product-picks:checked)`,
 * since the modal is not a sibling of the ingredient lists — so the tick works
 * on a browser with no JavaScript too. A browser without `:has` drops those
 * rules and simply always shows the buttons, which fails quietly. The typed
 * recipe-products client adds only the remembering, in `localStorage`, which
 * is why the checkbox has an id. That also keeps it per browser rather than
 * per household, which is what the card asks for: one person mapping products
 * does not change what everybody else's recipe screen looks like.
 */
function productPicksRow(): Raw {
  return html`<label class="tail-row picks-row"
    ><span class="tail-row-text"
      ><span class="tail-row-title">Näytä tuotevalinnat</span
      ><span class="tail-row-note">S-ostoslistan tuotteet ainesten kohdalla</span></span
    ><span class="picks-control"
      ><input type="checkbox" id="show-product-picks" class="product-picks"
      /><span class="picks-switch" aria-hidden="true"></span></span
  ></label>`;
}

function phaseFilter<T extends { phase: RecipePhase }>(
  rows: readonly T[],
  phases?: RecipePhase[],
): T[] {
  return phases === undefined ? [...rows] : rows.filter((row) => phases.includes(row.phase));
}

/**
 * One recipe's ingredient lines — the dish's own or one part's — as a list.
 * `recipe` is the row's own recipe row, which is half of what names a line
 * for the product picker.
 */
function ingredientList(
  recipe: Recipe,
  lines: Recipe["lines"],
  multiplier: number,
  picker: RecipePicker | null,
): Raw {
  if (lines.length === 0) return raw("");
  return html`<ul class="lines recipe-ingredients">
            ${alternativeSets(lines).map((set) => {
              const shown = set.options[0]!;
              const shared = sharedSource(set.options, (line) =>
                sourceWorthShowing(line, multiplier),
              );
              const subject = picker === null
                ? null
                : subjectFromState(
                    picker.dish,
                    picker.state,
                    shown.ingredientId,
                    multiplier,
                    // `recipe` is the row's own recipe row — the dish, or the
                    // part being drawn — which is half of what names the line.
                    { ownerId: recipe.id, line: shown },
                  );
              return html`<li
                class="${set.group === null
                  ? "recipe-ingredient"
                  : "recipe-ingredient is-alternative"}"
                ${subject === null ? "" : pickerRowAttributes(picker!, subject)}
              >
                <span class="recipe-product-slot shopping-thumb" aria-hidden="true">
                  ${shown.productImageUrl === null
                    ? ""
                    : html`<img
                        class="recipe-product-thumb"
                        src="${shown.productImageUrl}"
                        alt=""
                        width="26"
                        height="26"
                        loading="lazy"
                        onerror="this.hidden=true"
                      />`}
                </span>
                <span class="recipe-ingredient-copy">
                  ${set.options.map((line, index) => {
                    const amount = formatMeasurement(
                      scaleMeasurement(line, multiplier),
                    );
                    return html`${index === 0
                      ? ""
                      : html` <span class="alt-or">${ALTERNATIVE_WORD}</span> `}
                    ${amount === ""
                      ? ""
                      : html`<span class="amount">${amount}</span> `}
                    ${line.ingredient}
                    ${shared === "" && sourceWorthShowing(line, multiplier)
                      ? html`<span class="source">${line.sourceLine}</span>`
                      : ""}`;
                  })}
                  ${shared === ""
                    ? ""
                    : html`<span class="source">${shared}</span>`}
                </span>
                ${subject === null
                  ? ""
                  : productBlock(subject, recipeRoutes(picker!.dish, multiplier), {
                      compact: true,
                    })}
              </li>`;
            })}
          </ul>`;
}

/** One recipe's steps — the dish's own or one part's — as a numbered list. */
function stepList(
  recipe: Recipe,
  steps: Recipe["steps"],
  multiplier: number,
  bucket: string,
): Raw {
  if (steps.length === 0) return raw("");
  const amounts = amountsByIngredient(recipe.lines, multiplier);
  return html`<ol class="steps recipe-method">
            ${steps.map(
              (step, index) => html`<li>
                ${stepText(step, amounts, `m${recipe.id}${bucket}${index}`)}
              </li>`,
            )}
          </ol>`;
}

/**
 * The ingredients and the method (#354): every ingredient first, then the
 * whole method, both in cooking order — the dish's own first, each part under
 * its name, and what the dish adds after its parts under Lopuksi, or it would
 * read as the last part's. A cook reads the shopping half and the cooking half
 * of a dish in parts each in one go. A part's ingredients are
 * its `.part`, and its steps its `.part-method`.
 */
function cooking(
  recipe: Recipe,
  multiplier: number,
  picker: RecipePicker | null,
  reveal: RevealSlot | null,
): Raw {
  const parted = recipe.parts.length > 0;
  const before = parted ? phaseFilter(recipe.steps, [null, "before_parts"]) : recipe.steps;
  const after = parted ? phaseFilter(recipe.steps, ["after_parts"]) : [];
  const linesBefore = parted
    ? phaseFilter(recipe.lines, [null, "before_parts"])
    : recipe.lines;
  const linesAfter = parted ? phaseFilter(recipe.lines, ["after_parts"]) : [];
  const hasLines = recipe.lines.length > 0 ||
    recipe.parts.some((part) => part.lines.length > 0);
  const hasSteps = recipe.steps.length > 0 ||
    recipe.parts.some((part) => part.steps.length > 0);

  return html`<section class="recipe-section">
    ${hasLines
      ? html`<div class="recipe-ingredients-column">
          <h3 class="ingredients-heading">Ainekset</h3>
          ${ingredientList(recipe, linesBefore, multiplier, picker)}
          ${recipe.parts.map((part) => part.lines.length === 0
            ? ""
            : html`<section class="part">
                <h2>${part.title}</h2>
                ${ingredientList(part, part.lines, multiplier, picker)}
              </section>`)}
          ${linesAfter.length === 0
            ? ""
            : html`<section class="part-finish-lines">
                <h2>Lopuksi</h2>
                ${ingredientList(recipe, linesAfter, multiplier, picker)}
              </section>`}
        </div>`
      : ""}
    ${hasSteps
      ? html`<div class="recipe-method-column">
          ${methodHeading(reveal)}
          ${stepList(recipe, before, multiplier, "a")}
          ${recipe.parts.map((part) => part.steps.length === 0
            ? ""
            : html`<section class="part-method">
                <h2>${part.title}</h2>
                ${stepList(part, part.steps, multiplier, "a")}
              </section>`)}
          ${after.length === 0
            ? ""
            : html`<section class="part-method part-finish">
                <h2>Lopuksi</h2>
                ${stepList(recipe, after, multiplier, "b")}
              </section>`}
        </div>`
      : ""}
  </section>`;
}

/**
 * Where the recipe-wide amounts toggle goes: beside the first "Valmistus" the
 * page draws (#351), whichever body that turns out to be — a dish in parts may
 * have no steps of its own before its first part. One toggle per page, so the
 * first body with steps takes it and marks the slot used.
 */
interface RevealSlot {
  placed: boolean;
}

function methodHeading(reveal: RevealSlot | null): Raw {
  if (reveal === null || reveal.placed) {
    return html`<h3 class="method-heading">Valmistus</h3>`;
  }
  reveal.placed = true;
  return html`<div class="method-heading method-heading-row">
    <h3>Valmistus</h3>
    <label for="reveal-all-amounts" class="reveal-all-label"
      ><span class="reveal-all-show">Näytä määrät</span
      ><span class="reveal-all-hide">Piilota määrät</span></label
    >
  </div>`;
}

interface RecipeView {
  owned: boolean;
  preference: number | null;
  refusal: string | null;
  sharing: RecipeSharingState | null;
  vocabulary: Vocabulary;
  /** Null for every household without the S-ostoslista integration (#302). */
  products: RecipeProductState | null;
  /** PROTOTYPE (#364): where the size control sits. */
  variant: SizeVariant;
}

function recipeBody(
  recipe: Recipe,
  multiplier: number,
  view: RecipeView,
  castApplicationId?: string,
): Raw {
  const canRevealAmounts = hasRevealableMention(recipe, multiplier);
  const reveal: RevealSlot | null = canRevealAmounts ? { placed: false } : null;
  const picker: RecipePicker | null =
    view.products === null
      ? null
      : { dish: recipe, state: view.products, anchored: new Set<number>() };

  return html`<div class="recipe-view">
    ${prototypeSwitch(recipe, multiplier, view.variant)}
    <div class="recipe-summary">
      ${recipeImage(recipe)}
      <div class="recipe-intro">
        <h1>${recipe.title}</h1>
        ${view.refusal === null
          ? ""
          : html`<p class="refused">${view.refusal}</p>`}
        ${view.owned
          ? ""
          : html`<p class="meta shared-from">
              ${recipe.householdName} on jakanut tämän reseptin. Voit käyttää
              sitä, mutta vain sen oma talous voi muokata sitä.
            </p>`}
        ${recipeMeta(recipe, multiplier, view)}
        ${recipeTopActions(recipe, multiplier, view, picker !== null, castApplicationId)}
      </div>
    </div>

    <div class="recipe-cooking">
      ${view.variant === "c" ? sizeStepper(recipe, multiplier) : ""}
      ${canRevealAmounts
        ? html`<input
              type="checkbox"
              id="reveal-all-amounts"
              class="reveal-all"
            />`
        : ""}

      ${cooking(recipe, multiplier, picker, reveal)}
    </div>

    ${keepAwake()}
    ${RECIPE_VIEW_STYLE}
    ${MENTION_STYLE}
    ${PUBLISH_STYLE}
    ${CATEGORY_STYLE}
    ${picker === null ? "" : RECIPE_PRODUCT_STYLE}
    ${canRevealAmounts ? html`<script>${raw(REVEAL_ALL_ISLAND)}</script>` : ""}
    ${picker === null
      ? ""
      : html`${pickerSettings()}
          <script>${raw(recipeProductsClient)}</script>`}

    ${settingsModals(recipe, view)}
  </div>`;
}

/**
 * The grey line under the title (#354): the size, if the page is scaled, where
 * the source put its portions, the categories, and for the owner who can see
 * the dish. One line rather than a stack of them, so the ingredients start
 * under the buttons rather than a screen further down.
 */
function recipeMeta(recipe: Recipe, multiplier: number, view: RecipeView): Raw {
  const parts: Raw[] = [];
  if (view.variant === "b") {
    parts.push(sizeOpener(multiplier, "size-pill"));
  }
  if (recipe.yieldPortions !== null) {
    parts.push(html`<span class="source-yield">Lähteessä ${recipe.yieldPortions} annosta</span>`);
  }
  if (recipe.categories.length > 0) {
    parts.push(html`<span class="category-tags">${recipe.categories
      .map((slug) => view.vocabulary.label(slug))
      .join(" · ")}</span>`);
  }
  const visibility = visibilityWord(recipe, view);
  if (visibility !== null) {
    parts.push(html`<span class="visibility-word">${visibility}</span>`);
  }
  if (parts.length === 0) return raw("");
  return html`<p class="meta recipe-meta">${parts.map((part, index) =>
    index === 0 ? part : html`<span aria-hidden="true"> · </span>${part}`)}</p>`;
}

function visibilityWord(recipe: Recipe, view: RecipeView): string | null {
  if (!view.owned || view.sharing === null || recipe.parentId !== null) return null;
  const saved = view.sharing.savedVisibility;
  return saved === "public"
    ? "🌍 Julkinen"
    : saved === "selected"
      ? "👥 Valituille"
      : "🔒 Oma";
}

/**
 * The two buttons under the title (#354): Lisää kokattaviin, which opens the
 * sizes, and ⋯, which opens everything else the page offers — what used to be
 * the lists of rows under the method (#351) as well as the view switches. The
 * modals open on a fragment rather than a checkbox, because a row in the ⋯
 * modal hands over to another modal, and moving the address bar's fragment is
 * what closes one as the other opens.
 */
function recipeTopActions(
  recipe: Recipe,
  multiplier: number,
  view: RecipeView,
  picks: boolean,
  castApplicationId: string | undefined,
): Raw {
  const adding = recipe.parentId === null;
  const household = recipe.parentId === null;
  const sharing = view.owned && view.sharing !== null && recipe.parentId === null;
  const preference = view.preference;
  const host = sourceHost(recipe);
  const viewRows = picks || (castApplicationId?.trim() ?? "") !== "";

  return html`<div class="recipe-top" id="toiminnot">
    ${view.variant === "a" ? sizeOpener(multiplier, "recipe-top-size") : ""}
    ${adding ? quickAdd(recipe, multiplier) : ""}
    <a class="recipe-top-more" href="#${MORE_ID}" aria-label="Lisää valintoja"
      ><span aria-hidden="true">⋯</span></a
    >
  </div>
  ${topModal(SIZE_ID, "Koko", sizeChooser(recipe, multiplier, view.preference), "toiminnot", "Sulje")}
  ${topModal(
    MORE_ID,
    "Lisää valintoja",
    html`${viewRows
      ? html`<div class="tail-list">
          ${picks
            ? productPicksRow()
            : ""}
          ${castSender(recipe, multiplier, castApplicationId)}
        </div>`
      : ""}
    ${household
      ? html`<h2 class="tail-heading">Meidän taloudessa</h2>
          <div class="tail-list household-settings">
            ${settingsRow(
              PREFERENCE_ID,
              "Oletuskerroin",
              preference === null ? "Resepti sellaisenaan" : formatMultiplier(preference),
              "preference-value",
            )}
            ${sharing ? settingsRow(SHARING_ID, "Jakaminen", sharingSummary(view.sharing!)) : ""}
          </div>`
      : ""}
    <h2 class="tail-heading">Resepti</h2>
    <div class="tail-list recipe-actions">
      ${view.owned
        ? html`<a class="tail-row is-action" href="/recipes/${recipe.id}/edit"
              ><span class="tail-row-text"
                ><span class="tail-row-title">Muokkaa reseptiä</span></span
              ><span class="tail-chevron" aria-hidden="true">›</span></a
            >
            <a class="tail-row is-action" href="/intake?recipe=${recipe.id}"
              ><span class="tail-row-text"
                ><span class="tail-row-title">Täydennä AI:lla</span
                ><span class="tail-row-note">Lisää puuttuvat tiedot lähteestä</span></span
              ><span class="tail-chevron" aria-hidden="true">›</span></a
            >`
        : ""}
      <details class="source-original">
        <summary class="tail-row"
          ><span class="tail-row-text"
            ><span class="tail-row-title">Alkuperäinen resepti</span
            >${host === null
              ? ""
              : html`<span class="tail-row-note">${host}</span>`}</span
          ><span class="tail-chevron" aria-hidden="true">›</span></summary
        >
        <div class="source-original-body">
          ${sourceLink(recipe)}
          <p class="source-text">${recipe.sourceText}</p>
        </div>
      </details>
    </div>`,
  )}`;
}

/** A row of the ⋯ modal that opens one of the settings modals. */
function settingsRow(id: string, title: string, value: string, valueClass = ""): Raw {
  return html`<a class="tail-row" href="#${id}"
    ><span class="tail-row-text"
      ><span class="tail-row-title">${title}</span
      ><span class="tail-row-note ${valueClass}">${value}</span></span
    ><span class="tail-chevron" aria-hidden="true">›</span></a
  >`;
}

const SIZE_ID = "koko";
const MORE_ID = "lisavalinnat";
// Named as #317's blocks named them, so a bookmark or a test that opened the
// sharing modal still does.
const PREFERENCE_ID = editBlockOpenHref("preference-open").slice(1);
const SHARING_ID = editBlockOpenHref("sharing-open").slice(1);

/**
 * A modal opened by its fragment, with the same declarations every other
 * modal on the page uses (`.edit-modal:target`). Closing goes back to the
 * buttons it was opened from, so the page does not jump.
 */
function topModal(
  id: string,
  title: string,
  body: Raw,
  closeTo = "toiminnot",
  close = "Valmis",
): Raw {
  return html`<div class="edit-modal top-modal" id="${id}">
    <a class="edit-modal-back" href="#${closeTo}" tabindex="-1" aria-hidden="true"></a>
    <div class="edit-modal-card" role="group" aria-label="${title}">
      <p class="edit-modal-title">${title}</p>
      ${body}
      <div class="edit-modal-actions">
        <a class="edit-done" href="#${closeTo}">${close}</a>
      </div>
    </div>
  </div>`;
}

/**
 * The page's main button (#354): one tap puts the dish on the list at the
 * size the page shows (#364), which opens at the household's own size.
 */
function quickAdd(recipe: Recipe, multiplier: number): Raw {
  return html`<form
    method="post"
    action="/recipes/${recipe.id}/kokattaviin"
    class="recipe-top-add-form"
  >
    <button type="submit" name="preset" value="${String(multiplier)}" class="recipe-top-add"
      ><span aria-hidden="true">＋</span> Lisää kokattaviin${multiplier === DEFAULT_MULTIPLIER
        ? ""
        : ` · ${formatMultiplier(multiplier)}`}</button
    >
  </form>`;
}

/** What opens the size modal, wherever the variant puts it. */
function sizeOpener(multiplier: number, className: string): Raw {
  return html`<a class="${className}" href="#${SIZE_ID}" aria-label="Koko: ${formatMultiplier(multiplier)}, muuta"
    >${formatMultiplier(multiplier)} <span aria-hidden="true">▾</span></a
  >`;
}

const SIZE_STEPS = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6];

/**
 * The size modal (#364): each size is a link to this page at that size, so the
 * amounts change the moment one is tapped, with no script. A size of one's own
 * goes through a plain GET form to the same page.
 */
function sizeChooser(recipe: Recipe, multiplier: number, preference: number | null): Raw {
  return html`<div class="size-choices">
      ${[0.5, 1, 1.5, 2, 3].map((choice) => html`<a
        class="size-choice ${choice === multiplier ? "is-current" : ""}"
        href="/recipes/${recipe.id}?multiplier=${String(choice)}"
        >${formatMultiplier(choice)}</a
      >`)}
    </div>
    <form method="get" action="/recipes/${recipe.id}" class="size-typed">
      <input
        name="multiplier"
        inputmode="decimal"
        placeholder="Muu kerroin"
        aria-label="Muu kerroin"
        value="${[0.5, 1, 1.5, 2, 3].includes(multiplier) ? "" : formatMultiplier(multiplier).slice(0, -1)}"
      />
      <button type="submit">Näytä</button>
    </form>`;
}

/** PROTOTYPE (#364), variant C: a stepper above the ingredients. */
function sizeStepper(recipe: Recipe, multiplier: number): Raw {
  const smaller = [...SIZE_STEPS].reverse().find((step) => step < multiplier);
  const larger = SIZE_STEPS.find((step) => step > multiplier);
  const step = (to: number | undefined, sign: string, label: string) =>
    to === undefined
      ? html`<span class="size-step is-off" aria-hidden="true">${sign}</span>`
      : html`<a class="size-step" href="/recipes/${recipe.id}?multiplier=${String(to)}" aria-label="${label}">${sign}</a>`;
  return html`<div class="size-stepper">
    <span class="size-stepper-label">Koko</span>
    ${step(smaller, "−", "Pienempi")}
    ${sizeOpener(multiplier, "size-stepper-value")}
    ${step(larger, "+", "Suurempi")}
  </div>`;
}

/** PROTOTYPE (#364): the switcher between the three placements. */
function prototypeSwitch(recipe: Recipe, multiplier: number, variant: SizeVariant): Raw {
  const names: Array<[SizeVariant, string]> = [["a", "A · napin vieressä"], ["b", "B · harmaalla rivillä"], ["c", "C · ainesten yllä"]];
  return html`<nav class="proto-switch" aria-label="Prototyyppi">
    <span>Prototyyppi:</span>
    ${names.map(([key, name]) => html`<a
      class="${key === variant ? "is-on" : ""}"
      href="/recipes/${recipe.id}?proto=${key}&multiplier=${String(multiplier)}"
      >${name}</a
    >`)}
  </nav>`;
}

/**
 * The two household settings behind the ⋯ modal's rows (#317, #354): the
 * default size and who the dish is shared with. Each is its own modal, and
 * Valmis goes back to the ⋯ modal it was opened from.
 */
function settingsModals(recipe: Recipe, view: RecipeView): Raw {
  if (recipe.parentId !== null) return raw("");

  const preference = view.preference;

  return html`<div class="recipe-sharing" id="jakaminen">
    ${topModal(
      PREFERENCE_ID,
      "Oletuskerroin",
      html`<form method="post" action="/recipes/${recipe.id}/kerroin" class="stacked">
        ${multiplierField({
          current: preference,
          typed: preference === null ? "" : formatMultiplier(preference).slice(0, -1),
          label: "Oletuskerroin",
          placeholder: "Muu kerroin",
          describedBy: "preferredMultiplierHelp",
          submit: "Tallenna",
        })}
        <p class="empty" id="preferredMultiplierHelp">
          Mikä kerroin on valmiiksi valittuna, kun tämä resepti lisätään
          kokattaviin. Tyhjä ja Tallenna poistaa oletuksen, jolloin aloitetaan
          reseptistä sellaisenaan. Tämä on vain meidän talouden asetus.
        </p>
      </form>`,
      MORE_ID,
    )}
    ${view.owned && view.sharing !== null
      ? topModal(
          SHARING_ID,
          "Jakaminen",
          html`<form method="post" action="/recipes/julkaisu" class="stacked sharing-form">
              <input type="hidden" name="recipeId" value="${recipe.id}" />
              <input type="hidden" name="palaa" value="/recipes/${recipe.id}" />
              ${recipe.empty
                ? html`<p class="empty">
                    Resepti on tyhjä: sitä ei voi julkaista eikä jakaa, ennen
                    kuin siinä on ainekset ja valmistusvaiheet.
                  </p>`
                : ""}
              <fieldset class="visibility-choices">
                <legend>Näkyvyys</legend>
                ${visibilityChoice("private", "Oma", view.sharing!.visibility)}
                ${visibilityChoice("selected", "Valituille", view.sharing!.visibility)}
                ${visibilityChoice("public", "Julkinen", view.sharing!.visibility)}
              </fieldset>
              <div class="recipient-picker">
                <label for="recipient-search">Hae vastaanottavaa taloutta</label>
                <input
                  type="search"
                  id="recipient-search"
                  placeholder="Talouden nimi"
                  autocomplete="off"
                />
                <p class="empty">
                  Valitse vähintään yksi talous, kun näkyvyys on Valituille.
                  Jäsenien nimiä tai sähköposteja ei näytetä.
                </p>
                <ul class="recipient-list" id="recipient-list">
                  ${view.sharing!.recipients.map(
                    (recipient) => html`<li data-household-name="${recipient.name}">
                      <label>
                        <input
                          type="checkbox"
                          name="recipientId"
                          value="${recipient.id}"
                          ${recipient.selected ? raw("checked") : ""}
                        />
                        ${recipient.name}
                      </label>
                    </li>`,
                  )}
                </ul>
              </div>
              ${saveBar({ submit: "Tallenna jako", name: "action", value: "save" })}
            </form>
            <script>${raw(RECIPIENT_SEARCH_ISLAND)}</script>`,
          MORE_ID,
        )
      : ""}
  </div>`;
}

function sourceHost(recipe: Recipe): string | null {
  const address = recipe.sourceUrl;
  if (address === null || address.trim() === "") return null;
  try {
    return normaliseRecipeUrl(address).hostname;
  } catch {
    return null;
  }
}

function sharingSummary(sharing: RecipeSharingState): string {
  if (sharing.savedVisibility === "public") {
    return "Tämä resepti näkyy kaikille kirjautuneille talouksille.";
  }
  if (sharing.savedVisibility === "selected") {
    return `Tämä resepti on jaettu: ${sharing.savedRecipientNames.join(", ")}.`;
  }
  return "Tämä resepti näkyy vain omalle taloudelle.";
}

function visibilityChoice(
  value: "private" | "selected" | "public",
  label: string,
  current: "private" | "selected" | "public",
): Raw {
  return html`<label>
    <input
      type="radio"
      name="visibility"
      value="${value}"
      ${value === current ? raw("checked") : ""}
    />
    ${label}
  </label>`;
}

function hasRevealableMention(recipe: Recipe, multiplier: number): boolean {
  const amounts = amountsByIngredient(recipe.lines, multiplier);
  const thisRecipeHasOne = recipe.steps.some((step) =>
    resolveMentions(step.text, step.refs).some(
      (segment) =>
        segment.kind === "mention" &&
        (amounts.get(segment.ingredientId) ?? "") !== "",
    )
  );

  return thisRecipeHasOne || recipe.parts.some(
    (part) => hasRevealableMention(part, multiplier),
  );
}

const PUBLISH_STYLE = html`<style>
  .recipes.is-selectable li { display: flex; align-items: center; gap: .6rem; }
  .recipes.is-selectable li > a { flex: 1; min-width: 0; }
  .recipe-pick, .recipe-pick-gap { width: auto; min-height: 0; flex: 0 0 auto; }
  .badge.is-published { margin: 0 0 0 auto; align-self: center;
    color: var(--accent); border-color: var(--accent); white-space: nowrap; }
  .badge.is-shared { margin: 0 0 0 auto; align-self: center; white-space: nowrap; }
  .badge.is-empty { margin: 0 0 0 auto; align-self: center; white-space: nowrap;
    color: var(--muted); border-style: dashed; }
  .badge.is-empty + .badge { margin-left: .3rem; }
  .recipe-pick-gap { visibility: hidden; }
  .browse-shared { margin: -.4rem 0 1rem; font-size: .9rem; }
  .browse-toggle { display: inline-flex; align-items: center; gap: .5rem;
    min-height: var(--tap-compact); color: inherit; text-decoration: none; }
  .browse-toggle-box { display: inline-flex; align-items: center;
    justify-content: center; width: 1.1rem; height: 1.1rem;
    border: 1px solid var(--edge); border-radius: 3px; background: var(--surface);
    color: var(--accent); font-size: .85rem; line-height: 1; }
  .bulk-actions { display: flex; flex-wrap: wrap; gap: .5rem; margin: 1rem 0; }
  .bulk-actions button { flex: 1 1 10rem; }
  .done {
    padding: .7rem .8rem; margin: 0 0 1rem;
    color: var(--accent); font-size: .9rem;
    background: var(--surface); border: 1px solid var(--accent);
    border-radius: var(--radius);
  }
  /* The page's tail since #351: grouped lists of rows, each a label, its
     current value or a note, and a chevron, the whole row one tap. */
  .tail-group { margin: 2rem 0 0; }
  .tail-group + .tail-group { margin-top: 1.5rem; }
  .tail-heading {
    margin: 0 0 .4rem .2rem; color: var(--muted);
    font-size: .8rem; font-weight: 600; letter-spacing: .04em;
    text-transform: uppercase;
  }
  .tail-list {
    background: var(--surface); border: 1px solid var(--edge);
    border-radius: .75rem;
  }
  .tail-list > * + * { border-top: 1px solid var(--edge); }
  .tail-list > .edit-block { margin: 0; }
  .tail-list .edit-summary, .tail-row {
    position: relative; display: flex; align-items: center; gap: .75rem;
    flex-wrap: nowrap; min-height: 3.5rem; padding: .6rem 1rem;
  }
  .tail-list .edit-summary { display: grid;
    grid-template-columns: minmax(0, 1fr) auto; gap: .1rem .75rem;
    align-content: center; }
  .tail-list .edit-summary > .block-label {
    grid-column: 1; color: var(--fg); font-size: 1rem; font-weight: 600;
  }
  .tail-list .edit-summary > .block-value {
    grid-column: 1; color: var(--muted); font-size: .9rem; font-weight: 400;
  }
  .tail-list .edit-trigger {
    grid-column: 2; grid-row: 1 / span 2; min-height: 0; padding: 0;
    background: none; border: 0;
  }
  /* The opener stretches over its row, so a tap anywhere on it opens. */
  .tail-list .edit-trigger::after { content: ""; position: absolute; inset: 0; }
  .tail-list .edit-open:focus-visible ~ .edit-summary .edit-trigger,
  .tail-list .edit-trigger:focus-visible { outline: 0; }
  .tail-list .edit-open:focus-visible ~ .edit-summary,
  .tail-list .edit-summary:focus-within, .tail-row:focus-visible {
    outline: 2px solid var(--accent); outline-offset: -2px;
    border-radius: .75rem;
  }
  .tail-row { text-decoration: none; color: var(--fg); cursor: pointer; }
  .tail-row-text { flex: 1 1 auto; min-width: 0; display: flex;
    flex-direction: column; }
  .tail-row-title { font-weight: 600; }
  .tail-row.is-action .tail-row-title { color: var(--accent); }
  .tail-row-note { color: var(--muted); font-size: .9rem;
    overflow-wrap: anywhere; }
  .tail-chevron { flex: 0 0 auto; color: var(--muted); font-size: 1.4rem;
    line-height: 1; }
  .source-original > summary { list-style: none; }
  .source-original > summary::-webkit-details-marker { display: none; }
  .source-original[open] .tail-chevron { transform: rotate(90deg); }
  .source-original-body { padding: 0 1rem .8rem; }
  .source-original-body > :first-child { margin-top: 0; }
  .visually-hidden {
    position: absolute; width: 1px; height: 1px; overflow: hidden;
    clip: rect(0 0 0 0); white-space: nowrap;
  }
  .recipe-sharing p { margin: 0; }
  .recipe-sharing form { margin: 0; }
  .recipe-sharing .edit-modal-card p { margin: 0 0 .6rem; }
  .visibility-choices { display: flex; flex-wrap: wrap; gap: .35rem .8rem;
    padding: 0; margin: .8rem 0; border: 0; }
  .visibility-choices legend { width: 100%; margin-bottom: .25rem;
    font-weight: 600; }
  .visibility-choices label, .recipient-list label {
    display: flex; align-items: center; gap: .4rem; min-height: var(--tap-compact);
  }
  .visibility-choices input, .recipient-list input { width: auto; min-height: 0; }
  .recipient-picker { margin: .4rem 0 .8rem; }
  .recipient-picker > label { display: block; margin-bottom: .25rem;
    font-weight: 600; }
  .recipient-list { padding: .3rem 0; margin: 0; list-style: none; }
  .recipient-list li { border-bottom: 1px solid var(--edge); }
  .recipient-list li:last-child { border-bottom: 0; }
  .recipe-sharing .save-bar { background: var(--surface); }
  /* The top of the page since #354: one grey line, then the two buttons. */
  .recipe-meta { margin: .1rem 0 0; font-size: .9rem; }
  .recipe-meta .yield.is-scaled { padding: .1rem .45rem; }
  .recipe-top { display: flex; gap: .5rem; margin: .8rem 0 0; }
  .recipe-top-add, .recipe-top-more {
    display: inline-flex; align-items: center; justify-content: center; gap: .4rem;
    min-height: var(--tap); border-radius: var(--radius);
    font-weight: 600; text-decoration: none;
  }
  .recipe-top-add-form { flex: 1 1 auto; display: flex; margin: 0; }
  .recipe-top-add { flex: 1 1 auto; width: 100%; padding: 0 1rem; font: inherit;
    font-weight: 600; color: var(--accent-fg); background: var(--accent);
    border: 1px solid var(--accent); cursor: pointer; }
  .recipe-top-more { flex: 0 0 auto; width: var(--tap); color: var(--fg);
    background: var(--surface); border: 1px solid var(--edge); font-size: 1.2rem; }
  .recipe-top-add:focus-visible, .recipe-top-more:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 2px;
  }
  .top-modal .cook-add { margin: 0; }
  /* PROTOTYPE (#364): the size control in its three places, and its modal. */
  .proto-switch { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center;
    margin: 0 0 .75rem; padding: .4rem .6rem; border-radius: var(--radius);
    background: #f5d04a; color: #222; font-size: .8rem; font-weight: 600; }
  .proto-switch a { color: #222; text-decoration: none; padding: .15rem .55rem;
    border: 1px solid #222; border-radius: 999px; }
  .proto-switch a.is-on { background: #222; color: #f5d04a; }
  .recipe-top-size { display: inline-flex; align-items: center; justify-content: center;
    gap: .25rem; min-height: var(--tap); padding: 0 .8rem; border-radius: var(--radius);
    border: 1px solid var(--edge); background: var(--surface); color: var(--fg);
    font-weight: 600; text-decoration: none; }
  .size-pill { display: inline-flex; align-items: center; gap: .2rem;
    min-height: var(--tap-compact); padding: 0 .6rem; border-radius: 999px;
    border: 1px solid var(--accent); color: var(--accent); font-weight: 600;
    text-decoration: none; }
  .size-stepper { display: flex; align-items: center; gap: .5rem; margin: 1rem 0 0; }
  .size-stepper-label { flex: 1 1 auto; color: var(--muted); font-size: .8rem;
    font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
  .size-step, .size-stepper-value { display: inline-flex; align-items: center;
    justify-content: center; min-width: var(--tap); min-height: var(--tap);
    border-radius: var(--radius); border: 1px solid var(--edge);
    background: var(--surface); color: var(--fg); font-size: 1.2rem;
    text-decoration: none; }
  .size-stepper-value { padding: 0 .8rem; font-size: 1rem; font-weight: 600; }
  .size-step.is-off { opacity: .35; }
  .size-choices { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: .5rem; margin: 0; }
  .size-choice { display: flex; align-items: center; justify-content: center;
    min-height: 3.25rem; border-radius: var(--radius); border: 1px solid var(--edge);
    background: var(--surface); color: var(--fg); font-size: 1.05rem;
    font-weight: 600; text-decoration: none; }
  .size-choice.is-current { background: var(--accent); color: var(--accent-fg);
    border-color: var(--accent); }
  .size-typed { display: flex; gap: .5rem; margin: .5rem 0 0; }
  .size-typed input { flex: 1 1 auto; min-width: 0; }
  .size-usual { margin: .75rem 0 0; }
  .top-modal .tail-heading { margin-top: 1.1rem; }
  .top-modal .edit-modal-title + .tail-heading { margin-top: 0; }
  .top-modal .cook-add .empty { margin: 0 0 .75rem; }
  .top-modal .multiplier-choice + .empty { margin-top: .75rem; }
  /* The sizes as four equal buttons, then the typed size on a line of its own
     with its own button, so it does not read as a fifth size (#354). */
  .top-modal .multiplier-choice {
    display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .5rem;
  }
  .top-modal .multiplier-choice button[name="preset"] {
    min-width: 0; min-height: 3.25rem; font-size: 1.1rem; font-weight: 600;
  }
  .top-modal .multiplier-choice input {
    grid-column: 1 / span 3; width: 100%; min-height: var(--tap);
    margin-top: .5rem; text-align: left; padding: 0 .75rem;
  }
  .top-modal .multiplier-choice button:not([name]) {
    grid-column: 4; min-width: 0; margin-top: .5rem;
  }
  .top-modal .tail-list > style, .top-modal .tail-list > script { display: none; }
  /* The Cast launcher's own row, drawn like the rows around it. */
  .top-modal .cast-action { margin: 0; min-height: 3.5rem; padding: .3rem 1rem .3rem .5rem;
    color: var(--fg); font-size: 1rem; font-weight: 600; }
  /* The product-picks checkbox, drawn as a switch: the input sits over the
     drawing, the same size, so a tap or a click on it is a tap on the box and
     the keyboard's focus is shown where the switch is. */
  .picks-control { flex: 0 0 auto; position: relative; width: 2.7rem; height: 1.55rem; }
  .picks-control .product-picks {
    position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%;
    margin: 0; opacity: 0; cursor: pointer;
  }
  .picks-switch { position: absolute; inset: 0;
    border-radius: 999px; background: var(--edge); }
  .picks-switch::after { content: ""; position: absolute; top: .2rem; left: .2rem;
    width: 1.15rem; height: 1.15rem; border-radius: 50%; background: var(--muted); }
  .product-picks:checked + .picks-switch { background: var(--accent); }
  .product-picks:checked + .picks-switch::after {
    left: auto; right: .2rem; background: var(--accent-fg);
  }
  .product-picks:focus-visible + .picks-switch {
    outline: 2px solid var(--accent); outline-offset: 2px;
  }
</style>`;

const RECIPIENT_SEARCH_ISLAND = `
(function () {
  var search = document.getElementById('recipient-search');
  var list = document.getElementById('recipient-list');
  if (!search || !list || typeof search.addEventListener !== 'function') return;

  search.addEventListener('input', function () {
    var needle = search.value.toLowerCase();
    var rows = list.getElementsByTagName('li');
    for (var index = 0; index < rows.length; index += 1) {
      var name = rows[index].getAttribute('data-household-name') || '';
      rows[index].hidden = name.toLowerCase().indexOf(needle) === -1;
    }
  });
}());`;

function sourceLink(recipe: Recipe): Raw {
  const address = recipe.sourceUrl;
  if (address === null || address.trim() === "") return html``;

  let url: URL;
  try {
    url = normaliseRecipeUrl(address);
  } catch {
    return html`<p class="source-link">Lähde: ${address}</p>`;
  }

  return html`<p class="source-link">
    Lähde:
    <a href="${url.toString()}" target="_blank" rel="noopener noreferrer"
      >${url.hostname}</a
    >
  </p>`;
}

const RECIPE_VIEW_STYLE = html`<style>
  /* On a phone, a 2:1 band rather than the shared 4:3 one (#354), cropped to
     fill it, so the buttons and the ingredients start higher. The owner chose
     the crop over #116's whole picture: a generated picture keeps its food in
     the middle, which the crop keeps. Wider screens keep #116's band. */
  @media (max-width: 47.99rem) {
    .recipe-summary .recipe-image.is-hero:not(.is-empty) { height: 50vw; }
    .recipe-summary .recipe-image.is-hero img { object-fit: cover; }
  }
  .recipe-method { min-width: 0; }
  .recipe-method li { overflow-wrap: break-word; }
  .recipe-ingredient {
    display: flex; align-items: center; gap: .5rem;
  }
  .recipe-product-slot { flex: 0 0 1.6rem; width: 1.6rem; }
  .recipe-product-thumb {
    display: block; width: 1.6rem; height: 1.6rem;
    object-fit: contain; background: #fff;
    border: 1px solid var(--edge); border-radius: .25rem;
  }
  .recipe-ingredient-copy { flex: 1; min-width: 0; overflow-wrap: break-word; }
  .recipe-ingredient-copy .amount { white-space: nowrap; }
  .alt-or {
    color: var(--muted);
    font-style: italic;
    padding: 0 .15rem;
  }

  @media (min-width: 48rem) {
    .recipe-view {
      width: calc(100vw - 2rem);
      max-width: 64rem;
      margin-left: 50%;
      transform: translateX(-50%);
    }
    .recipe-summary { margin-bottom: 1rem; }
    .recipe-summary .recipe-image.is-hero {
      height: 12rem;
      margin-bottom: .75rem;
    }
    .recipe-summary .recipe-image.is-hero.is-empty { height: 8rem; }
    .recipe-intro { min-width: 0; }
    .recipe-intro h1 { margin-bottom: .5rem; }
    .recipe-intro .yield { margin-bottom: 0; }
    /* A little wider than the old per-part grid's .8fr: each part's ingredients
       now sit in a bordered section inside this column rather than around it. */
    .recipe-section {
      display: grid;
      grid-template-columns: minmax(15rem, 1fr) minmax(0, 1.2fr);
      column-gap: 2rem;
      align-items: start;
    }
    .recipe-section > div > h3:first-child,
    .recipe-section > div > .method-heading:first-child { margin-top: 0; }
    .recipe-section > h3 { margin-top: 0; }
    .recipe-section .lines li { padding: .35rem 0; font-size: 1rem; }
    .recipe-section .steps li { padding: .25rem 0; line-height: 1.45; }
  }
</style>`;

/**
 * The picker on an ingredient row, kept to the row's own height (#302).
 *
 * The block is the same element tree the shopping list draws, because that is
 * what the shared client writes into — a shape of its own here would be a shape
 * `showProduct` was not sized for, which is the fault #200 spent a pull request
 * removing. What changes is only how much of it a recipe shows: the picture is
 * already on the row's own slot, so the summary's copy of it is not drawn
 * twice, the EAN and the note wording go, and what is left is the product's
 * name beside a small button.
 *
 * **The block's width is fixed, and that is the whole point.** Left to size
 * itself it took as much room as the product's name wanted, so a row with a
 * product had less width for the ingredient than a row without one — and a
 * long ingredient then wrapped onto a second line in one state and not the
 * other. That is a row whose height depends on whether it is mapped, which is
 * exactly what #200 and #204 spent two pull requests removing from the shopping
 * list; `tests/recipes.spec.ts` caught it on a CI runner while this machine's
 * text happened to fit. At a fixed width both states leave the ingredient the
 * same room, the name ellipsises inside it, and nothing moves when a product is
 * chosen.
 */
const RECIPE_PRODUCT_STYLE = html`<style>
  .recipe-ingredient .s-shopping-product {
    display: flex; align-items: center; gap: .35rem;
    flex: 0 0 10rem; width: 10rem; min-width: 0;
    min-height: var(--tap-compact);
    margin: 0; padding: 0; border: 0; background: none;
  }
  .recipe-ingredient .s-shopping-product-body {
    min-width: 0; flex: 1; text-align: right;
  }
  .recipe-ingredient .s-shopping-product-one img,
  .recipe-ingredient .s-shopping-product-copy .meta,
  .recipe-ingredient .s-product-scope,
  .recipe-ingredient .s-package-total { display: none; }
  .recipe-ingredient .s-shopping-product-copy strong,
  .recipe-ingredient .s-shopping-product-copy .meta:only-child {
    display: block; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; font-weight: 500; font-size: .85rem;
    line-height: 1.3; color: var(--muted);
  }
  .recipe-ingredient .s-product-open button {
    min-height: var(--tap-compact); padding: 0 .5rem; font-size: .85rem;
    white-space: nowrap;
  }
  /* The busy line is a reserved slot, never an inserted one (#200): it is
     always there at the same width, and only the spinner inside it is ever
     drawn. Its words stay in the markup for the screen reader the aria-live
     region is for — there is no room on a phone row to print them, and
     printing them wrapped the row onto a second line at exactly the moment
     somebody had tapped something. */
  .recipe-ingredient .s-status {
    flex: 0 0 1.25rem; width: 1.25rem;
    height: 1.5rem; min-height: 0; line-height: 1.5rem;
    margin: 0; font-size: 0; white-space: nowrap; overflow: hidden;
    color: var(--muted);
  }

  /* Off — the ordinary case. The button goes and the busy slot with it, and a
     row with no product goes entirely: an "Ei tuotetta" on every line is the
     same clutter in quieter words. A mapped row keeps its name and its
     picture, so the screen still says what an ingredient is bought as. Nothing
     reserves the picker's fixed column while it is off, which is what gives a
     long ingredient name the width back on a phone. */
  .recipe-view:not(:has(.product-picks:checked)) .recipe-ingredient .s-product-open,
  .recipe-view:not(:has(.product-picks:checked)) .recipe-ingredient .s-status,
  .recipe-view:not(:has(.product-picks:checked)) .recipe-ingredient .s-shopping-product.is-note {
    display: none;
  }
  /* And with no button in it the block is a line of text, so it stops
     reserving a tap target's worth of height: a row showing its product has to
     be the same height as one that has none, or a dish's ingredient list steps
     up and down as it is read. */
  .recipe-view:not(:has(.product-picks:checked)) .recipe-ingredient .s-shopping-product,
  .recipe-view:not(:has(.product-picks:checked)) .recipe-ingredient .s-shopping-product-body {
    min-height: 0;
  }
  .recipe-view:not(:has(.product-picks:checked)) .recipe-ingredient .s-shopping-product {
    flex: 0 1 auto; width: auto; max-width: 10rem; min-width: 0;
  }
</style>`;

const MENTION_STYLE = html`<style>
  .steps li { padding: .35rem 0; line-height: 1.55; }
  .mention { display: inline; }
  .mention-toggle, .reveal-all {
    position: absolute; width: 1px; height: 1px;
    margin: 0; padding: 0; opacity: 0; pointer-events: none;
  }
  .reveal-all { position: fixed; left: 0; bottom: 0; }
  /* Beside the first "Valmistus" since #351, rather than a button of its own
     under the whole method. */
  .method-heading-row {
    display: flex; align-items: center; justify-content: space-between;
    gap: .75rem; margin: 1.25rem 0 .35rem;
  }
  .method-heading-row > h3 { margin: 0; }
  .reveal-all-label {
    display: inline-flex; align-items: center; min-height: var(--tap-compact);
    padding: 0 .75rem; cursor: pointer; font-size: .9rem; white-space: nowrap;
    scroll-margin-bottom: calc(var(--tabs-height) + env(safe-area-inset-bottom) + 1rem);
    border: 1px solid var(--edge); border-radius: var(--radius);
    background: var(--surface); font-weight: 600;
  }
  .reveal-all-hide { display: none; }
  .reveal-all:checked ~ * .reveal-all-label .reveal-all-show { display: none; }
  .reveal-all:checked ~ * .reveal-all-label .reveal-all-hide { display: inline; }
  .reveal-all:focus ~ * .reveal-all-label {
    outline: 2px solid var(--accent); outline-offset: 2px;
  }
  .mention > label {
    display: inline; cursor: pointer;
    text-decoration: underline dotted var(--muted);
    text-underline-offset: .2em;
  }
  .mention-amount {
    font-weight: 600; font-variant-numeric: tabular-nums;
    color: var(--accent); margin-right: .3em;
  }
  .mention-toggle:not(:checked) + label .mention-amount { display: none; }
  .reveal-all:checked ~ * .mention-toggle:not(:checked) + label .mention-amount {
    display: inline;
  }
  .mention-toggle:checked + label { text-decoration: none; }
  .mention-toggle:focus-visible + label {
    outline: 2px solid var(--accent); outline-offset: 2px; border-radius: .2rem;
  }
</style>`;

const REVEAL_ALL_ISLAND = `
(function () {
  var revealAll = document.getElementById('reveal-all-amounts');
  if (
    !revealAll ||
    typeof revealAll.addEventListener !== 'function' ||
    typeof document.querySelectorAll !== 'function'
  ) return;

  var mentions = document.querySelectorAll('.mention-toggle');
  if (
    mentions.length === 0 ||
    typeof mentions[0].addEventListener !== 'function'
  ) return;

  revealAll.addEventListener('change', function () {
    for (var index = 0; index < mentions.length; index += 1) {
      mentions[index].checked = revealAll.checked;
    }
  });

  function mentionChanged() {
    if (revealAll.checked && !this.checked) revealAll.checked = false;
  }

  for (var index = 0; index < mentions.length; index += 1) {
    mentions[index].addEventListener('change', mentionChanged);
  }
}());`;

async function loadRequested(
  db: D1Database,
  member: Member,
  rawId: string | undefined,
): Promise<Recipe | null> {
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return findReadableRecipe(db, member.householdId, id);
}
