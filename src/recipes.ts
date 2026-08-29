import { problem } from "./auth.ts";
import { castSender } from "./cast.ts";
import {
  ALTERNATIVE_WORD,
  alternativeGroup,
  alternativeSets,
  sharedSource,
  type AlternativeGroup,
} from "./alternatives.ts";
import {
  CATEGORY_STYLE,
  SELECTION_COUNT_ISLAND,
  categoriesForRecipe,
  categoriesForRecipes,
  categoryBulkControls,
  categoryFilter,
  categoryTags,
  loadVocabulary,
  type Vocabulary,
} from "./categories.ts";
import { html, multiplierField, page, raw, type Raw, saveBar } from "./html.ts";
import {
  parseStepRefs,
  resolveMentions,
  type StepIngredientRef,
} from "./ingredient-refs.ts";
import {
  overrideKey,
  overridesForRecipes,
  productsForIngredients,
} from "./ingredient-products.ts";
import { keepAwake } from "./keep-awake.ts";
import type { Member } from "./members.ts";
import { formatMeasurement, type Measurement } from "./quantities.ts";
import { normaliseRecipeUrl } from "./recipe-fetch.ts";
import type { RecipePhase } from "./recipe-phase.ts";
import {
  readableRecipeCondition,
  recipeSharingState,
  type RecipeSharingState,
  type SharingDraft,
} from "./recipe-publish.ts";
import { preferredMultiplierFor } from "./recipe-preference.ts";
import {
  DEFAULT_MULTIPLIER,
  formatMultiplier,
  parseMultiplier,
  scaleMeasurement,
  sourceWorthShowing,
} from "./scaling.ts";
import type { RouteContext } from "./router.ts";

/**
 * Reading the recipe store: the list and one recipe. Both the screens and the
 * JSON come from the same queries, and every one of them is scoped by
 * household_id — a recipe belonging to another household is a 404, not a 403,
 * because whether it exists is not this household's business.
 *
 * Publication (#143) is the one named exception to that, and it is deliberately
 * narrow. A published recipe can be *read* and *planned* by any household; it
 * can still only be edited, deleted or unpublished by the one that owns it, and
 * an unpublished recipe of another household is exactly as absent as it always
 * was. Two scopes express the whole of it, and every write stays on the first:
 *
 * - `own` — `recipe.household_id = ?`, the rule the rest of the app is built on.
 * - `readable` — that, or any recipe carrying a `published_at`.
 *
 * A part carries no `published_at` of its own: publishing a dish is publishing
 * one dish, and its parts come with it through the parent's screen rather than
 * as records another household can address. So `readable` refuses a part of
 * somebody else's published dish, and the dish's own load reaches its parts
 * through the owner's household instead.
 */

export interface RecipeSummary {
  id: number;
  title: string;
  createdAt: string;
  createdBy: string;
  /** What the source page said the recipe makes, if it said. Metadata only. */
  yieldPortions: number | null;
  /** The R2 object holding this recipe's picture, or null if it has none. */
  imageKey: string | null;
  /** Who owns it — the household that may edit, unpublish and delete it. */
  householdId: number;
  /** That household's name, so a public list can say whose recipe this is. */
  householdName: string;
  /** When it was published, or null while it is the household's own business. */
  publishedAt: string | null;
  /** Selected households that may read it while it is not public. */
  shareCount: number;
  /**
   * What kind of food this is (#196), as slugs from `src/categories.ts`, in
   * vocabulary order. Empty is the ordinary state, not missing data — it is
   * what every recipe stored before #196 carries.
   */
  categories: string[];
}

export interface RecipeLine extends Measurement {
  position: number;
  /** The `ingredient` row, so a step's mention of it can find its amount. */
  ingredientId: number;
  ingredient: string;
  /** The linked shop product's picture, when this ingredient has one. */
  productImageUrl: string | null;
  sourceLine: string;
  phase: RecipePhase;
  /**
   * Which alternative group this line is an option in, or null when it stands
   * alone. Lines of this recipe row sharing a number are read as `tai` (#183).
   */
  alternativeGroup: AlternativeGroup;
}

export interface RecipeStep {
  text: string;
  phase: RecipePhase;
  /** Ingredients this step names in its own wording. See `ingredient-refs.ts`. */
  refs: StepIngredientRef[];
}

export interface Recipe extends RecipeSummary {
  sourceText: string;
  sourceRoute: "pasted" | "photographed" | "linked";
  /** The web address this was read from, for a linked import (#192). */
  sourceUrl: string | null;
  /** Optimistic edit version. Incremented whenever this recipe is changed. */
  revision: number;
  steps: RecipeStep[];
  lines: RecipeLine[];
  /** The dish this is a part of, or null when it is a dish in its own right. */
  parentId: number | null;
  /** The dish's named parts, each a recipe of its own. Empty for a plain one. */
  parts: Recipe[];
}

// ---------------------------------------------------------------- queries

interface SummaryRow {
  id: number;
  title: string;
  created_at: string;
  created_by: string;
  yield_portions: number | null;
  image_key: string | null;
  household_id: number;
  household_name: string;
  published_at: string | null;
  share_count: number;
}

const SUMMARY_SELECT = `SELECT recipe.id,
              recipe.title,
              recipe.created_at,
              recipe.yield_portions,
              recipe.image_key,
              recipe.household_id,
              recipe.published_at,
              (SELECT count(*) FROM recipe_share
                WHERE recipe_share.recipe_id = recipe.id) AS share_count,
              household.name AS household_name,
              member.display_name AS created_by
         FROM recipe
         JOIN member ON member.id = recipe.created_by
         JOIN household ON household.id = recipe.household_id`;

/** This household's own dishes, published or not. */
export async function recipeSummaries(
  db: D1Database,
  householdId: number,
  query: string,
): Promise<RecipeSummary[]> {
  const { results } = await db
    .prepare(
      `${SUMMARY_SELECT}
        WHERE recipe.household_id = ?
          AND recipe.parent_id IS NULL
        ORDER BY recipe.created_at DESC, recipe.id DESC`,
    )
    .bind(householdId)
    .all<SummaryRow>();

  return withCategories(db, filterByTitle(results.map(toSummary), query));
}

/**
 * Dishes other households have made readable to this household.
 *
 * Deliberately not "every published dish": this household's own recipes are its
 * own list, and repeating them here would make the public section read as a
 * second copy of the store rather than as what other people are sharing.
 *
 * `parent_id IS NULL` is doing real work, not being defensive — a part never
 * carries a `published_at`, so it could not appear here anyway, and the clause
 * says out loud that this list is dishes.
 */
export async function publicRecipeSummaries(
  db: D1Database,
  householdId: number,
  query: string,
): Promise<RecipeSummary[]> {
  const { results } = await db
    .prepare(
      `${SUMMARY_SELECT}
        WHERE recipe.household_id <> ?
          AND (recipe.published_at IS NOT NULL
               OR EXISTS (
                    SELECT 1 FROM recipe_share
                     WHERE recipe_share.recipe_id = recipe.id
                       AND recipe_share.household_id = ?
                  ))
          AND recipe.parent_id IS NULL
        ORDER BY recipe.published_at DESC, recipe.id DESC`,
    )
    .bind(householdId, householdId)
    .all<SummaryRow>();

  return withCategories(db, filterByTitle(results.map(toSummary), query));
}

/**
 * Fill in each summary's categories (#196).
 *
 * One query for the whole list rather than a join on `SUMMARY_SELECT`: a
 * recipe has several categories, so joining would multiply the rows and every
 * caller would have to fold them back up. Asked after the title filter, so a
 * search pays only for what it is going to show.
 */
async function withCategories(
  db: D1Database,
  summaries: RecipeSummary[],
): Promise<RecipeSummary[]> {
  const byRecipe = await categoriesForRecipes(
    db,
    summaries.map((summary) => summary.id),
  );
  return summaries.map((summary) => ({
    ...summary,
    categories: byRecipe.get(summary.id) ?? [],
  }));
}

/**
 * The category a list was asked to show, or null for all of them.
 *
 * An unknown slug is read as no filter rather than as an empty list: a stale
 * bookmark should show the recipes, not an empty screen with no way back.
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

/**
 * Everything this household may put on its week: its own dishes first, then the
 * public ones. Own first because a household plans its own cooking far more
 * often than somebody else's, and a picker that buries it is a worse picker.
 */
export async function plannableRecipeSummaries(
  db: D1Database,
  householdId: number,
  query: string,
): Promise<RecipeSummary[]> {
  const [own, shared] = await Promise.all([
    recipeSummaries(db, householdId, query),
    publicRecipeSummaries(db, householdId, query),
  ]);
  return [...own, ...shared];
}

function toSummary(row: SummaryRow): RecipeSummary {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    createdBy: row.created_by,
    yieldPortions: row.yield_portions,
    imageKey: row.image_key,
    householdId: row.household_id,
    householdName: row.household_name,
    publishedAt: row.published_at,
    shareCount: row.share_count,
    // Filled in by `withCategories`, which asks for a whole list at once.
    categories: [],
  };
}

/**
 * Matched here rather than with SQL LIKE: SQLite's case-insensitivity is
 * ASCII-only, so "Ö" would not find "ö". A household's whole list is a few
 * hundred titles, which is nothing to filter in memory.
 */
function filterByTitle(
  summaries: RecipeSummary[],
  query: string,
): RecipeSummary[] {
  const needle = query.trim().toLocaleLowerCase("fi");
  if (needle === "") return summaries;

  return summaries.filter((recipe) =>
    recipe.title.toLocaleLowerCase("fi").includes(needle),
  );
}

interface RecipeRow extends SummaryRow {
  parent_id: number | null;
  source_text: string;
  source_route: "pasted" | "photographed" | "linked";
  source_url: string | null;
  revision: number;
}

interface StepRow {
  text: string;
  phase: RecipePhase;
  ingredient_refs: string | null;
}

interface LineRow {
  position: number;
  ingredient_id: number;
  quantity: number | null;
  quantity_max: number | null;
  unit: string | null;
  alt_quantity: number | null;
  alt_unit: string | null;
  ingredient: string;
  source_line: string;
  phase: RecipePhase;
  alternative_group: number | null;
}

/**
 * One recipe this household owns. Every write path uses this and nothing else,
 * so publication cannot widen an edit, a delete or an image upload by accident.
 */
export function findRecipe(
  db: D1Database,
  householdId: number,
  id: number,
  withParts = true,
): Promise<Recipe | null> {
  return loadRecipe(db, householdId, id, withParts, "own");
}

/**
 * One recipe this household may *read*: its own, public, or shared to it.
 *
 * The caller still has to ask whose it is before offering an edit — the recipe
 * carries `householdId` for exactly that.
 */
export function findReadableRecipe(
  db: D1Database,
  householdId: number,
  id: number,
  withParts = true,
): Promise<Recipe | null> {
  return loadRecipe(db, householdId, id, withParts, "readable");
}

async function loadRecipe(
  db: D1Database,
  householdId: number,
  id: number,
  withParts: boolean,
  scope: "own" | "readable",
  productHouseholdId = householdId,
): Promise<Recipe | null> {
  const ownership = scope === "own"
    ? "recipe.household_id = ?"
    : readableRecipeCondition();

  const row = await db
    .prepare(
      `SELECT recipe.id,
              recipe.title,
              recipe.yield_portions,
              recipe.source_text,
              recipe.source_route,
              recipe.source_url,
              recipe.revision,
              recipe.image_key,
              recipe.created_at,
              recipe.household_id,
              recipe.published_at,
              (SELECT count(*) FROM recipe_share
                WHERE recipe_share.recipe_id = recipe.id) AS share_count,
              recipe.parent_id,
              household.name AS household_name,
              member.display_name AS created_by
         FROM recipe
         JOIN member ON member.id = recipe.created_by
         JOIN household ON household.id = recipe.household_id
        WHERE recipe.id = ? AND ${ownership}`,
    )
    .bind(...(
      scope === "own"
        ? [id, householdId]
        : [id, householdId, householdId]
    ))
    .first<RecipeRow>();

  if (row === null) return null;

  // Filtered by recipe_id alone: which recipe rows this household may see was
  // decided by the query above, and asking again here would have to ask it in
  // the *owner's* terms rather than the reader's.
  const batch = await db.batch<never>([
    db
      .prepare(
        `SELECT recipe_step.text,
                recipe_step.phase,
                recipe_step.ingredient_refs
           FROM recipe_step
          WHERE recipe_step.recipe_id = ?
          ORDER BY recipe_step.position`,
      )
      .bind(id),
    db
      .prepare(
        `SELECT ingredient_line.position,
                ingredient_line.ingredient_id,
                ingredient_line.quantity,
                ingredient_line.quantity_max,
                ingredient_line.unit,
                ingredient_line.alt_quantity,
                ingredient_line.alt_unit,
                ingredient_line.source_line,
                ingredient_line.phase,
                ingredient_line.alternative_group,
                ingredient.name AS ingredient
           FROM ingredient_line
           JOIN ingredient ON ingredient.id = ingredient_line.ingredient_id
          WHERE ingredient_line.recipe_id = ?
          ORDER BY ingredient_line.position`,
      )
      .bind(id),
  ]);

  const steps = (batch[0]?.results ?? []) as StepRow[];
  const lines = (batch[1]?.results ?? []) as LineRow[];
  const ingredientIds = [...new Set(lines.map((line) => line.ingredient_id))];
  // Product overrides belong to the planned dish. A part is loaded as its own
  // recipe row, but the shopping list stores its choice against the parent.
  const productRecipeId = row.parent_id ?? row.id;
  const [products, overrides, categories] = await Promise.all([
    productsForIngredients(db, ingredientIds),
    overridesForRecipes(db, productHouseholdId, [productRecipeId]),
    // Only a dish is categorised (#196). A part is a recipe row (ADR-0002) but
    // it is not a thing anybody browses for, so asking would be a query per
    // part for an answer that is always empty.
    row.parent_id === null
      ? categoriesForRecipe(db, row.id)
      : Promise.resolve<string[]>([]),
  ]);

  // One level only: a part cannot itself have parts, so this never recurses
  // more than once. See docs/adr/0002-a-part-is-a-recipe.md.
  //
  // Loaded through the *owner's* household: a published dish read by somebody
  // else still has to bring its own parts, and they are the owner's rows.
  const parts = withParts
    ? await partsOf(db, row.household_id, productHouseholdId, id)
    : [];

  return {
    id: row.id,
    title: row.title,
    yieldPortions: row.yield_portions,
    sourceText: row.source_text,
    sourceRoute: row.source_route,
    sourceUrl: row.source_url,
    revision: row.revision,
    imageKey: row.image_key,
    createdAt: row.created_at,
    createdBy: row.created_by,
    householdId: row.household_id,
    householdName: row.household_name,
    publishedAt: row.published_at,
    shareCount: row.share_count,
    categories,
    parentId: row.parent_id,
    parts,
    steps: steps.map((step) => ({
      text: step.text,
      phase: step.phase,
      refs: parseStepRefs(step.ingredient_refs),
    })),
    lines: lines.map((line) => ({
      position: line.position,
      ingredientId: line.ingredient_id,
      quantity: line.quantity,
      quantityMax: line.quantity_max,
      unit: line.unit,
      altQuantity: line.alt_quantity,
      altUnit: line.alt_unit,
      ingredient: line.ingredient,
      productImageUrl:
        (
          overrides.get(overrideKey(productRecipeId, line.ingredient_id)) ??
          products.get(line.ingredient_id)?.[0]
        )?.imageUrl?.trim() || null,
      sourceLine: line.source_line,
      phase: line.phase,
      alternativeGroup: alternativeGroup(line.alternative_group),
    })),
  };
}

// ----------------------------------------------------------------- routes

async function partsOf(
  db: D1Database,
  ownerHouseholdId: number,
  productHouseholdId: number,
  parentId: number,
): Promise<Recipe[]> {
  const { results } = await db
    .prepare(
      `SELECT id FROM recipe
        WHERE household_id = ? AND parent_id = ?
        ORDER BY part_position, id`,
    )
    .bind(ownerHouseholdId, parentId)
    .all<{ id: number }>();

  const parts: Recipe[] = [];
  for (const row of results) {
    const part = await loadRecipe(
      db,
      ownerHouseholdId,
      row.id,
      false,
      "own",
      productHouseholdId,
    );
    if (part !== null) parts.push(part);
  }

  return parts;
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
 * Keep the existing JSON shape; phases and ingredient mentions are both
 * internal cooking-view concerns, and neither has ever been on the wire.
 * Ownership, publication and linked product pictures are new for the same
 * reason: the screens need them, the API's callers did not ask for them.
 *
 * `alternativeGroup` is the one field added on purpose (#183), and it is not
 * the same kind of thing as the ones above. A phase decides where a line is
 * drawn; a group decides what the list of lines *means*. Without it the JSON
 * says a recipe needs kermaa **and** kookosmaitoa, when it needs one of them —
 * so any caller adding these lines up would be reading a wrong recipe, not a
 * plainer one. Lines sharing a number, within one recipe object, are options
 * for each other and the first is the default.
 *
 * `categories` (#196) is stripped for the first reason rather than the second.
 * It says what kind of food a dish is, which is how somebody *finds* a recipe
 * on the list screen; it changes nothing about what the recipe is or how it is
 * cooked, so a caller adding these lines up reads exactly the same dish with or
 * without it.
 *
 * `tests/alternatives.spec.ts` pins the exact key set of both objects against
 * the live route, so nothing joins or leaves this shape by accident again.
 */
function recipeForApi(recipe: Recipe, viewerHouseholdId: number): object {
  const {
    householdId: _householdId,
    householdName: _householdName,
    publishedAt: _publishedAt,
    shareCount: _shareCount,
    categories: _categories,
    parentId: _parentId,
    ...wire
  } = recipe;

  return {
    ...wire,
    // Household names are discoverable for sharing; individual member names
    // are not. Preserve the string-shaped field for existing API callers while
    // saying only which household authored a recipe read across the boundary.
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
  // The bulk category control's own state (#199), which is not the filter: one
  // is what the list is showing, the other is what the buttons would change.
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
      <!-- The chosen category is a place, so a name search made while standing
           in one stays in it rather than silently widening the list. -->
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
      ? // An empty state that only states the emptiness leaves the reader to
        // work out what to do about it. Both of these say the next move.
        html`<div class="nothing">
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
      : // The whole list is one form, because publishing several recipes at once
        // is the action this screen is for — a household shares a batch of
        // recipes in one sitting, not one at a time. The checkbox sits outside
        // the link so that tapping a row still opens the recipe.
        // `stacked` because the shell's default form is a row, and this one is
        // a whole list with its actions underneath.
        html`<form method="post" action="/recipes/julkaisu" class="stacked">
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
                    <span class="meta"
                      >${metaLine(vocabulary, recipe)}</span
                    >
                  </span>
                  ${sharingBadge(recipe)}
                </a>
              </li>`,
            )}
          </ul>
          <!-- Said before the buttons rather than after them, so how many
               recipes are about to move is on the screen while the reader is
               still deciding. Without JavaScript it stays this sentence, which
               is true; the island below counts. -->
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
          <script>
            ${raw(SELECTION_COUNT_ISLAND)}
          </script>
        </form>`}
    ${PUBLISH_STYLE}
    ${CATEGORY_STYLE}`;
}

/**
 * `GET /recipes/julkiset` — what other households are sharing with this one.
 *
 * A section of its own rather than a mixed list, because "ours" and "someone
 * else's" are different things to a cook: one can be corrected when it turns
 * out the oven temperature was wrong, and the other cannot.
 */
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

/**
 * Which categories are worth offering as chips: the ones something in this
 * list actually has. A chip that leads to an empty screen is a chip that made
 * the reader do the work of finding out it was empty.
 */
function availableCategories(recipes: readonly RecipeSummary[]): string[] {
  return [...new Set(recipes.flatMap((recipe) => recipe.categories))];
}

/**
 * A row's second line. The categories ride on the line that is already there
 * rather than on chips of their own, because a list of a few hundred recipes
 * with a chip row inside every row is a list nobody can scan.
 */
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
  { env, params, url }: RouteContext,
  member: Member,
): Promise<Response> {
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

  // Arriving from a planned batch carries that cooking's multiplier. Anything
  // else — a bookmark, a typo, nothing at all — is the recipe as written.
  const asked = parseMultiplier(url.searchParams.get("multiplier") ?? "");

  return renderRecipe(
    env.DB,
    member,
    recipe,
    asked ?? DEFAULT_MULTIPLIER,
    null,
    env.CAST_APP_ID,
  );
}

/**
 * The recipe screen, from wherever it is being rendered.
 *
 * A refusal re-renders this rather than redirecting, which is the standing rule
 * on every screen in this app: the reason and what was typed both stay in front
 * of the person who typed it.
 */
export async function renderRecipe(
  db: D1Database,
  member: Member,
  recipe: Recipe,
  multiplier: number,
  refusal: string | null,
  castApplicationId?: string,
  sharingDraft?: SharingDraft,
): Promise<Response> {
  const owned = recipe.householdId === member.householdId;
  const [preference, sharing, vocabulary] = await Promise.all([
    preferredMultiplierFor(db, member.householdId, recipe.id),
    owned && recipe.parentId === null
      ? recipeSharingState(db, member.householdId, recipe.id, sharingDraft)
      : Promise.resolve(null),
    loadVocabulary(db),
  ]);

  return page(
    recipe.title,
    recipeBody(recipe, multiplier, {
      owned,
      preference,
      refusal,
      sharing,
      vocabulary,
    }, castApplicationId),
    "recipes",
    member,
    refusal === null ? 200 : 400,
  );
}

/**
 * A step, with the ingredients it names made tappable (issue #120).
 *
 * The reveal is a checkbox and its label, not a script. Every mention toggles
 * on its own, it survives a page the browser restored from its back-forward
 * cache, and it works on a browser that runs no JavaScript at all — which is
 * the standing rule for anything on the reading path. The amount sits in the
 * markup already scaled, so what appears is this meal's figure and not the
 * page's, and nothing has to be kept in step with a later edit: the next render
 * reads the ingredient line again.
 *
 * A mention whose ingredient states no amount ("hieman sitruunaruohoa") is left
 * as plain text. There is nothing to reveal, and a control that does nothing is
 * worse than no control.
 */
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

/**
 * Every amount this recipe's own lines can offer a mention, already scaled and
 * keyed by ingredient. A duplicated ingredient shows every distinct stated
 * amount in recipe order: seeing both is safer than trusting an unverified
 * model choice about which line a word meant. Blank amounts are omitted and
 * repeats collapse.
 */
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

/** The ingredients and method of one recipe — a dish, or one of its parts. */
function body(
  recipe: Recipe,
  multiplier: number,
  phases?: RecipePhase[],
  bucket = "a",
): Raw {
  const lines = phases === undefined
    ? recipe.lines
    : recipe.lines.filter((line) => phases.includes(line.phase));
  const steps = phases === undefined
    ? recipe.steps
    : recipe.steps.filter((step) => phases.includes(step.phase));

  // Every line of this recipe, not only the ones this phase renders: a step
  // done after the parts still mentions an ingredient listed before them.
  const amounts = amountsByIngredient(recipe.lines, multiplier);

  return html`<section class="recipe-section">
    ${lines.length === 0
      ? ""
      : html`<h3 class="ingredients-heading">Ainekset</h3>
          <ul class="lines recipe-ingredients">
            ${alternativeSets(lines).map((set) => {
              // The thumbnail follows the default option, because that is the
              // one the shopping list buys. Two pictures on one row would say
              // "buy both", which is exactly what a `tai` line does not mean.
              const shown = set.options[0]!;
              // Import gives every option of a group the same source sentence,
              // and a scaled cooking makes each of them worth showing — so the
              // set states it once at the end rather than repeating the whole
              // choice under every option (#183).
              const shared = sharedSource(set.options, (line) =>
                sourceWorthShowing(line, multiplier),
              );
              return html`<li
                class="${set.group === null
                  ? "recipe-ingredient"
                  : "recipe-ingredient is-alternative"}"
              >
                <span class="recipe-product-slot" aria-hidden="true">
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

/**
 * A recipe's picture, or the same shape of space saying it has none.
 *
 * Always one or the other, never nothing: a row that changes height depending
 * on whether somebody got round to adding a photograph is a list that jumps
 * about while you scroll it. The picture is decorative — the title is always
 * right beside it — so it carries no alt text for a screen reader to read
 * twice, and the empty one is hidden from a screen reader entirely.
 *
 * Two sizes, because a list row and a recipe screen want very different
 * pictures out of the same object: `hero` is the band above a title, `thumb`
 * is the square that sits at the start of a row. They differ in what they do
 * with a picture that is not the band's shape. A `thumb` crops to fill its
 * square — a row of them has to line up, and a squashed dish is worse than a
 * cropped one. A `hero` is shown whole inside its band, because the screen is
 * about that one dish and the generator already framed it (issue #116); the
 * two carry different classes so a change to one cannot reach the other.
 *
 * Read-only on purpose. Uploading happens in the editor and nowhere else, so
 * no screen that calls this offers a control.
 */
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
  /** Whether this household owns the recipe, and so may change it. */
  owned: boolean;
  /** This household's saved default multiplier for it, if it has one. */
  preference: number | null;
  refusal: string | null;
  sharing: RecipeSharingState | null;
  /** The vocabulary the tags under the title are labelled from (#199). */
  vocabulary: Vocabulary;
}

function recipeBody(
  recipe: Recipe,
  multiplier: number,
  view: RecipeView,
  castApplicationId?: string,
): Raw {
  const canRevealAmounts = hasRevealableMention(recipe, multiplier);

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
          : // Said before the ingredients rather than beside the missing edit link
            // at the bottom: whose recipe this is changes how it should be read,
            // and the reader deserves that before they start cooking from it.
            html`<p class="meta shared-from">
              ${recipe.householdName} on jakanut tämän reseptin. Voit käyttää
              sitä, mutta vain sen oma talous voi muokata sitä.
            </p>`}
        <!-- Whether the amounts below are the page's or this cooking's is the
             first thing a cook needs to know, so it sits under the title and
             says which. Since #165 it always can: the recipe as written is 1x,
             so a dish whose source never stated a yield scales like any other. -->
        <p class="${multiplier === DEFAULT_MULTIPLIER ? "yield" : "yield is-scaled"}">
          ${multiplier === DEFAULT_MULTIPLIER
            ? `${formatMultiplier(multiplier)} · resepti sellaisenaan`
            : formatMultiplier(multiplier)}
        </p>
        <!-- What the source page claimed it makes. Kept because it is worth
             knowing and printed as metadata, never as a control: it is not what
             scaling starts from any more. -->
        ${recipe.yieldPortions === null
          ? ""
          : html`<p class="meta source-yield">
              Lähteessä ${recipe.yieldPortions} annosta
            </p>`}
        <!-- What kind of food this is (#196). Under the title with the rest of
             the recipe's own facts, not beside the edit link: it is part of
             reading the recipe, not part of changing it. -->
        ${categoryTags(view.vocabulary, recipe.categories)}
        <!-- Who can see this, said under the title and one tap from where it is
             changed (#217). Somebody who came to change the visibility of one
             dish used to open the editor for it — where there is no such
             control — and then scroll the whole thing looking. -->
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
        ? body(recipe, multiplier)
        : body(recipe, multiplier, [null, "before_parts"])}
      ${recipe.parts.map(
        (part) => html`<section class="part">
          <h2>${part.title}</h2>
          <!-- A part is a piece of the dish, so it takes the dish's multiplier. -->
          ${body(part, multiplier)}
        </section>`,
      )}
      <!-- A different bucket letter, because this is the same recipe rendered a
           second time and two mentions may not share a checkbox id. -->
      ${recipe.parts.length === 0
        ? ""
        : body(recipe, multiplier, ["after_parts"], "b")}

      ${canRevealAmounts
        ? html`<label for="reveal-all-amounts" class="reveal-all-label"
            ><span class="reveal-all-show">Näytä kaikki määrät</span
            ><span class="reveal-all-hide">Piilota määrät</span></label
          >`
        : ""}
    </div>

    <!-- Still stored, still one tap away, but not competing with the cooking. -->
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
    ${canRevealAmounts ? html`<script>${raw(REVEAL_ALL_ISLAND)}</script>` : ""}

    ${sharingSection(recipe, view)}

    ${view.owned
      ? html`<p class="recipe-edit">
          <a href="/recipes/${recipe.id}/edit">Muokkaa reseptiä</a>
          <a href="/intake?recipe=${recipe.id}">Täydennä AI:lla</a>
        </p>`
      : ""}
  </div>`;
}

/**
 * Publishing, and this household's own default for the recipe.
 *
 * Both live in one block at the foot of the screen because both are about
 * *this household's relationship to the recipe* rather than about the cooking,
 * and the cooking is what the rest of the page is for. They appear for
 * different people: publishing only for the household that owns the recipe,
 * the default multiplier for anybody who can open it — a household that always
 * cooks somebody else's lasagne at one and a half has exactly the same need as
 * the household that wrote it.
 */
function sharingSection(recipe: Recipe, view: RecipeView): Raw {
  // A part has neither of these. It is not published on its own (ADR-0002: it
  // is a piece of the dish), and it is never planned, so there is no multiplier
  // to have a habit about. Offering either control here would only be a button
  // that refuses.
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
            <!-- The same bar as the editor and the import review (issue #217).
                 The recipient list has no length limit, so on a phone the save
                 could sit well below the household somebody had just ticked. -->
            ${saveBar({ submit: "Tallenna jako", name: "action", value: "save" })}
          </form>
          <script>${raw(RECIPIENT_SEARCH_ISLAND)}</script>`
      : ""}
  </section>`;
}

/**
 * Who can see this dish, under the title, with the way to change it (#217).
 *
 * Only for the household that owns the recipe, because only it can change the
 * answer — for anybody else the `shared-from` line above already says whose
 * recipe this is. A part gets none: `sharingSection` refuses to draw for one,
 * so the link would lead to a section that is not on the page.
 */
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

/** Whether this dish or any of its parts has an amount the toggle can reveal. */
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

/**
 * A mention should read as the sentence it is part of, not as a button — the
 * instruction is the thing being read, and a row of chips through the middle of
 * it is harder to follow than the plain text was. So: the same font, the same
 * colour, and a faint dotted underline as the only hint that it does anything.
 *
 * Kept here rather than in the shell's stylesheet because it is one screen's
 * concern, and `src/html.ts` is the file every screen shares.
 */
/**
 * Publishing's own few rules, kept beside the screens that use them rather than
 * in the shell's stylesheet — `src/html.ts` is the file every screen shares.
 *
 * The selection checkbox is a real, visible control here, unlike the mention
 * toggles above: a bulk action nobody can see the state of is a bulk action
 * somebody runs on the wrong recipes.
 */
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
  /* The save bar sits inside a panel with a surface of its own, so its own
     backdrop has to match that rather than the page's, or the rows it covers
     while it is stuck would show through it. */
  .recipe-sharing .save-bar { background: var(--surface); }
  .sharing-shortcut { margin: .1rem 0 0; }
  .sharing-shortcut a { margin-left: .4rem; color: var(--accent);
    font-weight: 600; }
  .preference-label { margin: 0 0 .4rem; font-weight: 600; }
  .source-yield { margin: .1rem 0 0; }
</style>`;

/* Deliberately ES5: household search is a small enhancement over the full list. */
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

/**
 * The cooking view uses the extra width a tablet offers without changing the
 * phone-first shell. Nothing here fixes a height or hides overflow: a long
 * instruction is allowed to wrap and make the page taller.
 */
/**
 * Where a linked recipe came from (#192).
 *
 * Re-checked rather than trusted: the column is written by intake, but a
 * restored snapshot is data from outside this code path, and an address that
 * will not parse as an ordinary web address is shown as text rather than made
 * clickable. `noreferrer` because leaving for the source page should not tell
 * it which household is cooking.
 */
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

  /* "tai" is the whole of what an alternative line says, so it is the one word
     on the row that is not an ingredient or an amount. Dimmed and spaced rather
     than emphasised: the options are what a cook reads, and the joining word
     only has to stop them running together. */
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
    .recipe-summary {
      margin-bottom: 1rem;
    }
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
    .recipe-section > .ingredients-heading {
      grid-area: ingredients-heading;
    }
    .recipe-section > .recipe-ingredients { grid-area: ingredients; }
    .recipe-section > .method-heading { grid-area: method-heading; }
    .recipe-section > .recipe-method { grid-area: method; }
    .recipe-section > h3 { margin-top: 0; }
    .recipe-section .lines li { padding: .35rem 0; font-size: 1rem; }
    .recipe-section .steps li { padding: .25rem 0; line-height: 1.45; }
    .recipe-cooking > .reveal-all-label { margin-top: .5rem; }
  }
</style>`;

const MENTION_STYLE = html`<style>
  .steps li { padding: .35rem 0; line-height: 1.55; }
  .mention { display: inline; }
  /* Off-screen rather than display:none — a hidden control cannot be focused,
     and this one is how a keyboard reaches the amount. */
  .mention-toggle, .reveal-all {
    position: absolute; width: 1px; height: 1px;
    margin: 0; padding: 0; opacity: 0; pointer-events: none;
  }
  /* The master checkbox has to precede every mention for the no-JS sibling
     selector, while its visible label belongs after the instructions. Keep its
     focus target in the viewport so activating that distant label cannot scroll
     the recipe back to the checkbox's document position. */
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
  /* Plain :focus is deliberate: older Safari predates :focus-visible, and a
     keyboard user still needs to see where this off-screen checkbox is. */
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

/* Deliberately ES5 syntax: this string reaches browsers without transpilation. */
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
