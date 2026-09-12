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
  categoryFilter,
  categoryTags,
  loadVocabulary,
  type Vocabulary,
} from "./categories.ts";
import recipeProductsClient from "./generated/recipe-products.ts";
import { html, multiplierField, page, raw, type Raw, saveBar } from "./html.ts";
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

/**
 * The category a list was asked to show, or null for all of them.
 * An unknown slug is read as no filter rather than as an empty list.
 */
export function askedCategory(
  vocabulary: Vocabulary,
  value: string | null,
): string | null {
  return value !== null && vocabulary.has(value) ? value : null;
}

function inCategory(
  summaries: RecipeSummary[],
  category: string | null,
): RecipeSummary[] {
  if (category === null) return summaries;
  return summaries.filter((recipe) => recipe.categories.includes(category));
}

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
  { env, url }: RouteContext,
  member: Member,
): Promise<Response> {
  const query = url.searchParams.get("q") ?? "";
  const vocabulary = await loadVocabulary(env.DB);
  return page(
    "Reseptit",
    await ownRecipeList(
      env.DB,
      vocabulary,
      member,
      query,
      null,
      askedCategory(vocabulary, url.searchParams.get("kategoria")),
    ),
    "recipes",
    member,
  );
}

/** A word said back after a bulk action, or the reason one did not happen. */
export interface ListNotice {
  message: string;
  refused: boolean;
}

export async function ownRecipeList(
  db: D1Database,
  vocabulary: Vocabulary,
  member: Member,
  query: string,
  notice: ListNotice | null,
  category: string | null = null,
  bulkCategory: string | null = null,
): Promise<Raw> {
  const matching = await recipeSummaries(db, member.householdId, query);
  const recipes = inCategory(matching, category);

  return html`<h1>Reseptit</h1>
    <p class="public-link"><a href="/recipes/julkiset">Jaetut reseptit</a></p>
    <form method="get" action="/recipes">
      <input
        type="search"
        name="q"
        value="${query}"
        placeholder="Hae nimellä"
        aria-label="Hae nimellä"
      />
      ${category === null
        ? ""
        : html`<input type="hidden" name="kategoria" value="${category}" />`}
      <button type="submit">Hae</button>
    </form>
    ${categoryFilter(
      vocabulary,
      "/recipes",
      query,
      category,
      availableCategories(matching),
    )}
    ${noticeLine(notice)}
    ${recipes.length === 0
      ? html`<div class="nothing">
          <p class="empty">
            ${category !== null
              ? `Kategoriassa ${vocabulary.label(category)} ei ole yhtään reseptiä.`
              : query.trim() === ""
                ? "Reseptejä ei ole vielä yhtään."
                : `Haku "${query.trim()}" ei löytänyt yhtään reseptiä.`}
          </p>
          ${category === null && query.trim() === ""
            ? html`<p><a class="button" href="/intake">Lisää ensimmäinen</a></p>`
            : html`<p><a href="/recipes">Näytä kaikki reseptit</a></p>`}
        </div>`
      : html`<form method="post" action="/recipes/julkaisu" class="stacked">
          <input type="hidden" name="q" value="${query}" />
          ${category === null
            ? ""
            : html`<input type="hidden" name="kategoria" value="${category}" />`}
          <ul class="recipes is-selectable">
            ${recipes.map(
              (recipe) => html`<li>
                <input
                  type="checkbox"
                  name="recipeId"
                  value="${recipe.id}"
                  class="recipe-pick"
                  aria-label="Valitse ${recipe.title}"
                />
                <a href="/recipes/${recipe.id}">
                  ${recipeImage(recipe, "thumb")}
                  <span class="recipes-text">
                    ${recipe.title}
                    <span class="meta">${metaLine(vocabulary, recipe)}</span>
                  </span>
                  ${sharingBadge(recipe)}
                </a>
              </li>`,
            )}
          </ul>
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
        </form>`}
    ${PUBLISH_STYLE}
    ${CATEGORY_STYLE}`;
}

/** `GET /recipes/julkiset` — what other households are sharing with this one. */
export async function publicRecipeListScreen(
  { env, url }: RouteContext,
  member: Member,
): Promise<Response> {
  const query = url.searchParams.get("q") ?? "";
  const vocabulary = await loadVocabulary(env.DB);
  const category = askedCategory(vocabulary, url.searchParams.get("kategoria"));
  const matching = await publicRecipeSummaries(
    env.DB,
    member.householdId,
    query,
  );
  const recipes = inCategory(matching, category);

  return page(
    "Jaetut reseptit",
    html`<h1>Jaetut reseptit</h1>
      <p class="empty">
        Muiden talouksien jakamat reseptit. Voit ottaa ne ruokalistalle, mutta
        muokata voi vain reseptin oma talous.
      </p>
      <p class="public-link"><a href="/recipes">Omat reseptit</a></p>
      <form method="get" action="/recipes/julkiset">
        <input
          type="search"
          name="q"
          value="${query}"
          placeholder="Hae nimellä"
          aria-label="Hae nimellä"
        />
        ${category === null
          ? ""
          : html`<input type="hidden" name="kategoria" value="${category}" />`}
        <button type="submit">Hae</button>
      </form>
      ${categoryFilter(
        vocabulary,
        "/recipes/julkiset",
        query,
        category,
        availableCategories(matching),
      )}
      ${recipes.length === 0
        ? html`<div class="nothing">
            <p class="empty">
              ${category !== null
                ? `Kategoriassa ${vocabulary.label(category)} ei ole yhtään jaettua reseptiä.`
                : query.trim() === ""
                  ? "Yhtään reseptiä ei ole vielä jaettu tälle taloudelle tai kaikille."
                  : `Haku "${query.trim()}" ei löytänyt yhtään jaettua reseptiä.`}
            </p>
            ${category === null && query.trim() === ""
              ? ""
              : html`<p><a href="/recipes/julkiset">Näytä kaikki jaetut</a></p>`}
          </div>`
        : html`<ul class="recipes">
            ${recipes.map(
              (recipe) => html`<li>
                <a href="/recipes/${recipe.id}">
                  ${recipeImage(recipe, "thumb")}
                  <span class="recipes-text">
                    ${recipe.title}
                    <span class="meta"
                      >${recipe.categories.length === 0
                        ? recipe.householdName
                        : `${recipe.householdName} · ${recipe.categories
                            .map((slug) => vocabulary.label(slug))
                            .join(", ")}`}</span
                    >
                  </span>
                  <span class="badge is-published">
                    ${recipe.publishedAt === null ? "Jaettu sinulle" : "Julkinen"}
                  </span>
                </a>
              </li>`,
            )}
          </ul>`}
      ${PUBLISH_STYLE}
    ${CATEGORY_STYLE}`,
    "recipes",
    member,
  );
}

function availableCategories(recipes: readonly RecipeSummary[]): string[] {
  return [...new Set(recipes.flatMap((recipe) => recipe.categories))];
}

function metaLine(vocabulary: Vocabulary, recipe: RecipeSummary): string {
  const parts = [finnishDate(recipe.createdAt), recipe.createdBy];
  if (recipe.categories.length > 0) {
    parts.push(recipe.categories.map((slug) => vocabulary.label(slug)).join(", "));
  }
  return parts.join(" · ");
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

  return renderRecipe(
    env.DB,
    member,
    recipe,
    asked ?? DEFAULT_MULTIPLIER,
    null,
    env.CAST_APP_ID,
    undefined,
    externalClient(env, member) !== null,
  );
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
  multiplier: number,
  refusal: string | null,
  castApplicationId?: string,
  sharingDraft?: SharingDraft,
  external = false,
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

  return page(
    recipe.title,
    recipeBody(recipe, multiplier, {
      owned,
      preference,
      refusal,
      sharing,
      vocabulary,
      products,
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

function body(
  recipe: Recipe,
  multiplier: number,
  picker: RecipePicker | null,
  phases?: RecipePhase[],
  bucket = "a",
): Raw {
  const lines = phases === undefined
    ? recipe.lines
    : recipe.lines.filter((line) => phases.includes(line.phase));
  const steps = phases === undefined
    ? recipe.steps
    : recipe.steps.filter((step) => phases.includes(step.phase));
  const amounts = amountsByIngredient(recipe.lines, multiplier);

  return html`<section class="recipe-section">
    ${lines.length === 0
      ? ""
      : html`<h3 class="ingredients-heading">Ainekset</h3>
          <ul class="lines recipe-ingredients">
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
                    shown,
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
          </ul>`}
    ${steps.length === 0
      ? ""
      : html`<h3 class="method-heading">Valmistus</h3>
          <ol class="steps recipe-method">
            ${steps.map(
              (step, index) => html`<li>
                ${stepText(step, amounts, `m${recipe.id}${bucket}${index}`)}
              </li>`,
            )}
          </ol>`}
  </section>`;
}

/** Everything rendering a picture needs to know. A `Recipe` is one of these. */
export interface Pictured {
  id: number;
  imageKey: string | null;
}

/** A recipe picture, or a same-size empty placeholder. */
export function recipeImage(
  recipe: Pictured,
  size: "hero" | "thumb" = "hero",
): Raw {
  const shape =
    size === "thumb" ? "recipe-image is-thumb" : "recipe-image is-hero";
  return recipe.imageKey === null
    ? html`<div class="${shape} is-empty" aria-hidden="true"></div>`
    : html`<div class="${shape}">
        <img src="/api/recipes/${recipe.id}/image" alt="" loading="lazy" />
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
}

function recipeBody(
  recipe: Recipe,
  multiplier: number,
  view: RecipeView,
  castApplicationId?: string,
): Raw {
  const canRevealAmounts = hasRevealableMention(recipe, multiplier);
  const picker: RecipePicker | null =
    view.products === null
      ? null
      : { dish: recipe, state: view.products, anchored: new Set<number>() };

  return html`<div class="recipe-view">
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
        <p class="${multiplier === DEFAULT_MULTIPLIER ? "yield" : "yield is-scaled"}">
          ${multiplier === DEFAULT_MULTIPLIER
            ? `${formatMultiplier(multiplier)} · resepti sellaisenaan`
            : formatMultiplier(multiplier)}
        </p>
        ${recipe.yieldPortions === null
          ? ""
          : html`<p class="meta source-yield">
              Lähteessä ${recipe.yieldPortions} annosta
            </p>`}
        ${categoryTags(view.vocabulary, recipe.categories)}
        ${sharingShortcut(recipe, view)}
        ${castSender(recipe, multiplier, castApplicationId)}
      </div>
    </div>

    <div class="recipe-cooking">
      ${canRevealAmounts
        ? html`<input
              type="checkbox"
              id="reveal-all-amounts"
              class="reveal-all"
            />`
        : ""}

      ${recipe.parts.length === 0
        ? body(recipe, multiplier, picker)
        : body(recipe, multiplier, picker, [null, "before_parts"])}
      ${recipe.parts.map(
        (part) => html`<section class="part">
          <h2>${part.title}</h2>
          ${body(part, multiplier, picker)}
        </section>`,
      )}
      ${recipe.parts.length === 0
        ? ""
        : body(recipe, multiplier, picker, ["after_parts"], "b")}

      ${canRevealAmounts
        ? html`<label for="reveal-all-amounts" class="reveal-all-label"
            ><span class="reveal-all-show">Näytä kaikki määrät</span
            ><span class="reveal-all-hide">Piilota määrät</span></label
          >`
        : ""}
    </div>

    <details class="source-original">
      <summary>Näytä alkuperäinen</summary>
      ${sourceLink(recipe)}
      <p class="source-text">${recipe.sourceText}</p>
    </details>

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

    ${sharingSection(recipe, view)}

    ${view.owned
      ? html`<p class="recipe-edit">
          <a href="/recipes/${recipe.id}/edit">Muokkaa reseptiä</a>
          <a href="/intake?recipe=${recipe.id}">Täydennä AI:lla</a>
        </p>`
      : ""}
  </div>`;
}

function sharingSection(recipe: Recipe, view: RecipeView): Raw {
  if (recipe.parentId !== null) return raw("");

  const preference = view.preference;

  return html`<section class="recipe-sharing" id="jakaminen">
    <h2>Tämä resepti taloudessamme</h2>

    <form method="post" action="/recipes/${recipe.id}/kerroin" class="stacked">
      <p class="preference-label" id="preferredMultiplierLabel">Oletuskerroin</p>
      ${multiplierField({
        current: preference,
        typed: preference === null ? "" : formatMultiplier(preference).slice(0, -1),
        label: "Oletuskerroin",
        describedBy: "preferredMultiplierHelp",
        submit: "Tallenna",
      })}
      <p class="empty" id="preferredMultiplierHelp">
        Millä kertoimella ruokalista aloittaa, kun tämä resepti lisätään
        viikolle. Tyhjä ja Tallenna poistaa oletuksen, jolloin aloitetaan
        reseptistä sellaisenaan. Tämä on vain meidän talouden asetus.
      </p>
    </form>

    ${view.owned && view.sharing !== null
      ? html`<h2>Jakaminen</h2>
          <p class="empty">${sharingSummary(view.sharing)}</p>
          <form method="post" action="/recipes/julkaisu" class="stacked sharing-form">
            <input type="hidden" name="recipeId" value="${recipe.id}" />
            <input type="hidden" name="palaa" value="/recipes/${recipe.id}" />
            <fieldset class="visibility-choices">
              <legend>Näkyvyys</legend>
              ${visibilityChoice("private", "Oma", view.sharing.visibility)}
              ${visibilityChoice("selected", "Valituille", view.sharing.visibility)}
              ${visibilityChoice("public", "Julkinen", view.sharing.visibility)}
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
                ${view.sharing.recipients.map(
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
          <script>${raw(RECIPIENT_SEARCH_ISLAND)}</script>`
      : ""}
  </section>`;
}

function sharingShortcut(recipe: Recipe, view: RecipeView): Raw {
  if (!view.owned || view.sharing === null || recipe.parentId !== null) {
    return raw("");
  }

  const saved = view.sharing.savedVisibility;
  const said =
    saved === "public"
      ? "Näkyvyys: kaikki taloudet"
      : saved === "selected"
        ? "Näkyvyys: valitut taloudet"
        : "Näkyvyys: vain oma talous";

  return html`<p class="meta sharing-shortcut">
    ${said}<a href="#jakaminen">Muuta</a>
  </p>`;
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
  .public-link { margin: 0 0 1rem; font-size: .9rem; }
  .recipes.is-selectable li { display: flex; align-items: center; gap: .6rem; }
  .recipes.is-selectable li > a { flex: 1; min-width: 0; }
  .recipe-pick { width: auto; min-height: 0; flex: 0 0 auto; }
  .badge.is-published { margin: 0 0 0 auto; align-self: center;
    color: var(--accent); border-color: var(--accent); white-space: nowrap; }
  .bulk-actions { display: flex; flex-wrap: wrap; gap: .5rem; margin: 1rem 0; }
  .bulk-actions button { flex: 1 1 10rem; }
  .done {
    padding: .7rem .8rem; margin: 0 0 1rem;
    color: var(--accent); font-size: .9rem;
    background: var(--surface); border: 1px solid var(--accent);
    border-radius: var(--radius);
  }
  .recipe-sharing { margin: 2rem 0 1rem; padding: .8rem;
    background: var(--surface); border: 1px solid var(--edge);
    border-radius: var(--radius); }
  .recipe-sharing h2 { margin: 0 0 .4rem; font-size: 1rem; }
  .recipe-sharing p { margin: 0 0 .6rem; }
  .recipe-sharing form { margin: 0; }
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
  .sharing-shortcut { margin: .1rem 0 0; }
  .sharing-shortcut a { margin-left: .4rem; color: var(--accent);
    font-weight: 600; }
  .preference-label { margin: 0 0 .4rem; font-weight: 600; }
  .source-yield { margin: .1rem 0 0; }
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
    .recipe-section {
      display: grid;
      grid-template-columns: minmax(14rem, .8fr) minmax(0, 1.2fr);
      grid-template-areas:
        "ingredients-heading method-heading"
        "ingredients method";
      column-gap: 2rem;
      align-items: start;
    }
    .recipe-section > .ingredients-heading { grid-area: ingredients-heading; }
    .recipe-section > .recipe-ingredients { grid-area: ingredients; }
    .recipe-section > .method-heading { grid-area: method-heading; }
    .recipe-section > .recipe-method { grid-area: method; }
    .recipe-section > h3 { margin-top: 0; }
    .recipe-section .lines li { padding: .35rem 0; font-size: 1rem; }
    .recipe-section .steps li { padding: .25rem 0; line-height: 1.45; }
    .recipe-cooking > .reveal-all-label { margin-top: .5rem; }
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
</style>`;

const MENTION_STYLE = html`<style>
  .steps li { padding: .35rem 0; line-height: 1.55; }
  .mention { display: inline; }
  .mention-toggle, .reveal-all {
    position: absolute; width: 1px; height: 1px;
    margin: 0; padding: 0; opacity: 0; pointer-events: none;
  }
  .reveal-all { position: fixed; left: 0; bottom: 0; }
  .reveal-all-label {
    display: inline-flex; align-items: center; min-height: var(--tap-compact);
    padding: 0 .75rem; margin: 0 0 .65rem; cursor: pointer;
    scroll-margin-bottom: calc(var(--tabs-height) + env(safe-area-inset-bottom) + 1rem);
    border: 1px solid var(--edge); border-radius: var(--radius);
    background: var(--surface); font-weight: 600;
  }
  .reveal-all-hide { display: none; }
  .reveal-all:checked ~ .reveal-all-label .reveal-all-show { display: none; }
  .reveal-all:checked ~ .reveal-all-label .reveal-all-hide { display: inline; }
  .reveal-all:focus ~ .reveal-all-label {
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

/** `2026-08-25 06:12:00` as `25.8.2026`. */
function finnishDate(timestamp: string): string {
  const [date] = timestamp.split(" ");
  const parts = (date ?? "").split("-");
  if (parts.length !== 3) return timestamp;

  const [year, month, day] = parts as [string, string, string];
  return `${Number(day)}.${Number(month)}.${year}`;
}
