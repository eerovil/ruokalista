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

/**
 * One line of a dish, and which of its recipe rows it was written on.
 *
 * The owner matters because a dish and one of its parts number their lines
 * from 1 each, so a position alone does not name a line.
 */
export interface DrawnLine {
  ownerId: number;
  line: RecipeLine;
}

/** Every line of a dish and of its parts, which is what a reader sees. */
function linesWithOwner(recipe: Recipe): DrawnLine[] {
  const found: DrawnLine[] = recipe.lines.map((line) => ({
    ownerId: recipe.id,
    line,
  }));
  for (const part of recipe.parts) {
    for (const line of part.lines) found.push({ ownerId: part.id, line });
  }
  return found;
}

function allLines(recipe: Recipe): RecipeLine[] {
  return linesWithOwner(recipe).map((one) => one.line);
}

/**
 * What a recipe row calls itself on its own forms.
 *
 * The ingredient alone is what the *save* needs — the mapping is the
 * ingredient's — but it is not enough to name the row, and a dish may name one
 * ingredient twice with different amounts. Without the rest, a plain
 * no-JavaScript `GET /recipes/:id/tuote?rivi=9` rebuilt whichever of those
 * rows came first, so the member opened one row and the screen answered about
 * another.
 */
function rowKey(ingredientId: number, drawn: DrawnLine | undefined): string {
  return drawn === undefined
    ? String(ingredientId)
    : `${ingredientId}:${drawn.ownerId}:${drawn.line.position}`;
}

interface AskedRow {
  ingredientId: number;
  ownerId: number | null;
  position: number | null;
}

/**
 * Read one back. The bare ingredient is still accepted, because that is what
 * the key is when no particular row drew it and what older links carry.
 */
function parseRowKey(raw: string): AskedRow | null {
  const parts = raw.trim().split(":");
  const ingredientId = Number(parts[0]);
  if (!Number.isSafeInteger(ingredientId)) return null;
  if (parts.length === 1) {
    return { ingredientId, ownerId: null, position: null };
  }
  if (parts.length !== 3) return null;
  const ownerId = Number(parts[1]);
  const position = Number(parts[2]);
  if (!Number.isSafeInteger(ownerId) || !Number.isSafeInteger(position)) {
    return null;
  }
  return { ingredientId, ownerId, position };
}

/**
 * The row a key names, or undefined when it names none.
 *
 * A key that no longer resolves — the recipe was edited since the link was
 * drawn — falls back to "no particular row" rather than refusing. It decides
 * which amount a heading says; the ingredient itself is checked either way, so
 * a key cannot reach a line this recipe does not have.
 */
function drawnRow(recipe: Recipe, asked: AskedRow): DrawnLine | undefined {
  if (asked.ownerId === null || asked.position === null) return undefined;
  return linesWithOwner(recipe).find(
    (one) =>
      one.ownerId === asked.ownerId &&
      one.line.position === asked.position &&
      one.line.ingredientId === asked.ingredientId,
  );
}

/**
 * The picker's row for one ingredient of one recipe.
 *
 * `recipes` always holds the one dish, because that is the only scope a recipe
 * screen can offer beyond the ingredient itself. `recipeId` is what says which
 * of the two this row is already following: null while the row reads the
 * ingredient's product and a scope choice is worth asking, the dish's id once
 * the dish has a product of its own — the same word the shopping list uses for
 * the same row, and what keeps a later change going back to the dish rather
 * than to every household recipe that uses the ingredient.
 */
export function recipeProductSubject(
  recipe: Recipe,
  ingredientId: number,
  multiplier: number,
  products: ProductChoice[],
  override: ProductChoice | null,
  drawn?: DrawnLine,
): ProductSubject | null {
  // The drawn line when a screen has one — a dish may name the same ingredient
  // twice, once itself and once in a part, and each of those rows wants its own
  // amount in the panel's heading rather than the first one's. A route has only
  // the ingredient, and there the amount decides a heading and nothing else.
  const line = drawn?.line ?? allLines(recipe).find(
    (one) => one.ingredientId === ingredientId,
  );
  if (line === undefined) return null;

  const chosen = override ?? products[0] ?? null;
  const amount = formatMeasurement(scaleMeasurement(line, multiplier));

  return {
    key: rowKey(ingredientId, drawn),
    ingredientId,
    // A dish that already insists on its own product is a *pinned* row, said in
    // the same word the shopping list says it in. It is what stops the scope
    // choice defaulting to "always for this ingredient" on a row that is not
    // reading the ingredient's product at all — a save that then wrote the
    // global mapping, left the override winning, and left the row showing a
    // product the screen would not use.
    recipeId: override === null ? null : dishId(recipe),
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
  drawn?: DrawnLine,
): ProductSubject | null {
  return recipeProductSubject(
    recipe,
    ingredientId,
    multiplier,
    state.products.get(ingredientId) ?? [],
    state.overrides.get(overrideKey(state.dishId, ingredientId)) ?? null,
    drawn,
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

  const asked = parseRowKey(
    String(form?.get("rivi") ?? ctx.url.searchParams.get("rivi") ?? ""),
  );
  if (asked === null) return null;

  const multiplier = askedMultiplier(
    form?.get("multiplier") ?? ctx.url.searchParams.get("multiplier"),
  );
  const state = await recipeProductState(ctx.env.DB, member.householdId, recipe);
  const subject = subjectFromState(
    recipe,
    state,
    asked.ingredientId,
    multiplier,
    drawnRow(recipe, asked),
  );
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
