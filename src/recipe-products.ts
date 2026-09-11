import { html, page, type Raw } from "./html.ts";
import {
  overrideKey,
  overridesForRecipes,
  productsForIngredients,
  type ProductChoice,
} from "./ingredient-products.ts";
import type { Member } from "./members.ts";
import {
  chosenMode,
  externalClient,
  productSearchBody,
  productSearchHeading,
  reason,
  refusedProductJson,
  saveChosenProduct,
  savedProductJson,
  type PickerRoutes,
  type ProductSubject,
} from "./product-picker.ts";
import { findReadableRecipe, type Recipe, type RecipeLine } from "./recipe-read.ts";
import type { RouteContext } from "./router.ts";
import { formatMeasurement } from "./quantities.ts";
import {
  DEFAULT_MULTIPLIER,
  parseMultiplier,
  scaleMeasurement,
} from "./scaling.ts";
import type { SOstoslistaProduct } from "./s-ostoslista.ts";

/**
 * Choosing which shop product an ingredient is, from the recipe rather than
 * from the shopping list (#302).
 *
 * Why this needs routes of its own at all, when the component is shared: the
 * shopping list names a row by what the week adds up to, and resolves it by
 * recomputing that week. A recipe's ingredient is not in anybody's week — it is
 * a line of a dish somebody happens to be reading — so the row it hands the
 * picker is named by the dish and the ingredient instead. Everything the member
 * then sees and everything that is written down is `product-picker.ts`, exactly
 * as on the shopping list, including the re-search that keeps a browser from
 * inventing a product.
 *
 * The two scopes are the ones #161 defined, and they mean the same here:
 * `Käytä aina tälle ainekselle` writes the global `ingredient_product` row, and
 * `Käytä tässä reseptissä` writes this household's `recipe_ingredient_product`
 * override. The recipe offered is the *dish*, never a part, because that is
 * what an override is keyed by and what `recipe-read.ts` reads back.
 *
 * Every route here answers a bare 404 unless `externalClient` says this member's
 * household has the integration. That is the same gate the shopping list uses
 * and the only one either screen has.
 */

/**
 * A dish's own id, even when the line belongs to one of its parts.
 *
 * `recipe-read.ts::loadRecipe` resolves a line's product against
 * `parent_id ?? id`, so a part's ingredient has to be pinned to the dish or the
 * choice would be written somewhere the recipe screen never looks.
 */
function dishId(recipe: Recipe): number {
  return recipe.parentId ?? recipe.id;
}

/**
 * And the dish's own name, for the same reason.
 *
 * The recipe screen always hands the picker the dish, so this only matters for
 * a hand-typed `/recipes/<partId>/tuote` — but there the scope choice would
 * otherwise offer "Käytä tässä reseptissä: Jauhelihakastike" while pinning the
 * product to Lasagne, which is a sentence that is not true.
 */
function dishTitle(recipe: Recipe): string {
  return recipe.parentTitle ?? recipe.title;
}

/** Every line of a dish and of its parts, which is what a reader sees. */
function allLines(recipe: Recipe): RecipeLine[] {
  const lines = [...recipe.lines];
  for (const part of recipe.parts) lines.push(...part.lines);
  return lines;
}

/**
 * The picker's row for one ingredient of one recipe.
 *
 * `recipeId` stays null and `recipes` holds the one dish: that is how the
 * shared component words "this row is not pinned yet, and here is the dish it
 * could be pinned to", which is exactly the choice a recipe screen offers.
 * `recipeTitle` is set only where the dish already has its own product, so the
 * summary says `Vain reseptissä …` for the same reason it does on the list.
 */
export function recipeProductSubject(
  recipe: Recipe,
  ingredientId: number,
  multiplier: number,
  products: ProductChoice[],
  override: ProductChoice | null,
): ProductSubject | null {
  const line = allLines(recipe).find((one) => one.ingredientId === ingredientId);
  if (line === undefined) return null;

  const chosen = override ?? products[0] ?? null;
  const amount = formatMeasurement(scaleMeasurement(line, multiplier));

  return {
    key: String(ingredientId),
    ingredientId,
    recipeId: null,
    recipeTitle: override === null ? null : dishTitle(recipe),
    name: line.ingredient,
    total: amount === "" ? "määrä reseptin mukaan" : amount,
    products: override === null ? products : [override],
    chosen: chosen === null ? [] : [{ product: chosen, count: 1 }],
    packageTotal: null,
    recipes: [{ id: dishId(recipe), title: dishTitle(recipe) }],
  };
}

/** What one recipe screen needs to draw its rows, read once for the screen. */
export interface RecipeProductState {
  products: Map<number, ProductChoice[]>;
  overrides: Map<string, ProductChoice>;
  dishId: number;
}

export async function recipeProductState(
  db: D1Database,
  householdId: number,
  recipe: Recipe,
): Promise<RecipeProductState> {
  const ingredientIds = [
    ...new Set(allLines(recipe).map((line) => line.ingredientId)),
  ];
  const dish = dishId(recipe);
  const [products, overrides] = await Promise.all([
    productsForIngredients(db, ingredientIds),
    overridesForRecipes(db, householdId, [dish]),
  ]);
  return { products, overrides, dishId: dish };
}

/** The row for one ingredient, from a state already read for the screen. */
export function subjectFromState(
  recipe: Recipe,
  state: RecipeProductState,
  ingredientId: number,
  multiplier: number,
): ProductSubject | null {
  return recipeProductSubject(
    recipe,
    ingredientId,
    multiplier,
    state.products.get(ingredientId) ?? [],
    state.overrides.get(overrideKey(state.dishId, ingredientId)) ?? null,
  );
}

/**
 * Where a recipe row's picker forms go.
 *
 * There is no `remove`: dropping a package size or an override is the shopping
 * list's own screen, where the package arithmetic those affect is visible.
 * A recipe row chooses and changes, which is what the card asks for.
 */
export function recipeRoutes(recipe: Recipe, multiplier: number): PickerRoutes {
  return {
    open: `/recipes/${recipe.id}/tuote`,
    save: `/recipes/${recipe.id}/tuote`,
    remove: null,
    back: recipeLocation(recipe.id, multiplier, null),
    fields: multiplierField(multiplier),
  };
}

function multiplierField(multiplier: number): Raw {
  return html`<input type="hidden" name="multiplier" value="${String(multiplier)}" />`;
}

/** Back to the recipe, at the same scaling and on the row that was pressed. */
function recipeLocation(
  recipeId: number,
  multiplier: number,
  ingredientId: number | null,
): string {
  const anchor = ingredientId === null ? "" : `#aines-${ingredientId}`;
  return `/recipes/${recipeId}?multiplier=${encodeURIComponent(String(multiplier))}${anchor}`;
}

/**
 * `GET /recipes/:id/tuote` — search and choose a product for one ingredient of
 * one recipe, without JavaScript.
 *
 * It is the same page the shopping list serves at `/ostoslista/tuote`, drawn by
 * the same function; only the row and the way back differ.
 */
export async function recipeProductScreen(
  ctx: RouteContext,
  member: Member,
): Promise<Response> {
  const found = await requestedSubject(ctx, member);
  if (found === null) return new Response("Not found", { status: 404 });
  const { client, recipe, subject, multiplier } = found;

  const mode = chosenMode(ctx.url.searchParams.get("tapa"));
  const query = (ctx.url.searchParams.get("haku") ?? subject.name).trim();
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

  return page(
    productSearchHeading(subject, mode),
    productSearchBody(
      subject,
      recipeRoutes(recipe, multiplier),
      mode,
      query,
      products,
      refused,
      "Takaisin reseptiin",
    ),
    "recipes",
    member,
    status,
  );
}

/**
 * `POST /recipes/:id/tuote` — write the choice down.
 *
 * The same save as the shopping list's, because it is literally the same
 * function: the product is re-searched from the shop before anything is
 * written, so neither screen can be told what a product is by a form.
 */
export async function saveRecipeProductForm(
  ctx: RouteContext,
  member: Member,
): Promise<Response> {
  const form = await ctx.request.formData();
  const found = await requestedSubject(ctx, member, form);
  if (found === null) return new Response("Not found", { status: 404 });
  const { client, recipe, subject, multiplier } = found;

  const asJson = String(form.get("muoto") ?? "") === "json";
  const mode = chosenMode(form.get("tapa"));
  const query = String(form.get("haku") ?? "").trim();

  const outcome = await saveChosenProduct(
    ctx.env.DB,
    member.householdId,
    client,
    subject,
    form,
  );

  if (!outcome.ok) {
    if (asJson) return refusedProductJson(outcome);
    return page(
      productSearchHeading(subject, mode),
      productSearchBody(
        subject,
        recipeRoutes(recipe, multiplier),
        mode,
        query,
        outcome.products,
        outcome.message,
        "Takaisin reseptiin",
      ),
      "recipes",
      member,
      outcome.status,
    );
  }

  // A second package size or a dish's own product changes what the row says
  // beyond its picture — the sizes it knows, and whose product it is — so the
  // browser reloads onto the row rather than drawing that itself.
  if (asJson) {
    return savedProductJson(
      outcome.product,
      mode === "add" || outcome.scope !== "ingredient",
    );
  }

  return new Response(null, {
    status: 303,
    headers: {
      Location: recipeLocation(recipe.id, multiplier, subject.ingredientId),
    },
  });
}

interface RequestedSubject {
  client: NonNullable<ReturnType<typeof externalClient>>;
  recipe: Recipe;
  subject: ProductSubject;
  multiplier: number;
}

/**
 * The recipe, the row and the gate, in the one order that keeps the wall up.
 *
 * The integration first — a household without it never learns whether a recipe
 * exists through these routes — then the recipe through `findReadableRecipe`,
 * so a private dish of another household is a 404 here exactly as it is
 * everywhere else, then the line, so `rivi` cannot name an ingredient this
 * recipe does not use.
 */
async function requestedSubject(
  ctx: RouteContext,
  member: Member,
  form?: FormData,
): Promise<RequestedSubject | null> {
  const client = externalClient(ctx.env, member);
  if (client === null) return null;

  const recipeId = Number(ctx.params["id"]);
  if (!Number.isSafeInteger(recipeId)) return null;
  const recipe = await findReadableRecipe(ctx.env.DB, member.householdId, recipeId);
  if (recipe === null) return null;

  const asked = form?.get("rivi") ?? ctx.url.searchParams.get("rivi");
  const ingredientId = Number(String(asked ?? "").trim());
  if (!Number.isSafeInteger(ingredientId)) return null;

  const multiplier = askedMultiplier(
    form?.get("multiplier") ?? ctx.url.searchParams.get("multiplier"),
  );
  const state = await recipeProductState(ctx.env.DB, member.householdId, recipe);
  const subject = subjectFromState(recipe, state, ingredientId, multiplier);
  if (subject === null) return null;

  return { client, recipe, subject, multiplier };
}

/**
 * The scaling the member was reading at, carried through the round-trip so the
 * amount in the panel's heading is the amount on their screen.
 *
 * A value that is not a usable multiplier falls back to 1 rather than refusing:
 * it decides what a heading says, not what is written down.
 */
function askedMultiplier(value: FormDataEntryValue | string | null): number {
  return parseMultiplier(String(value ?? "")) ?? DEFAULT_MULTIPLIER;
}
