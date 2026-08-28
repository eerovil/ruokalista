import {
  alternativeGroup,
  chosenAlternatives,
  type AlternativeGroup,
} from "./alternatives.ts";
import {
  backfillPackageSizes,
  overrideKey,
  overridesForRecipes,
  productSize,
  productsForIngredients,
  type ProductChoice,
} from "./ingredient-products.ts";
import {
  baseAmount,
  formatBaseAmount,
  planPackages,
  type BaseAmount,
} from "./packaging.ts";
import { formatMeasurement, type Measurement } from "./quantities.ts";
import { phaseBucket, recipePhase, type RecipePhase } from "./recipe-phase.ts";
import { scaleMeasurement, sourceWorthShowing } from "./scaling.ts";

/**
 * The shopping list: what a set of planned cookings needs bought.
 *
 * It is a projection, not a record. Nothing here is stored — the list is
 * recomputed from `planned_batch -> recipe (+ parts) -> ingredient_line ->
 * ingredient` every time somebody opens the screen, the same way a week is a
 * date-range query rather than a menu row (#5).
 *
 * Three rules decide the arithmetic, and all three are deliberately
 * conservative:
 *
 *   - **A batch is one cooking.** However many lunches and dinners it covers,
 *     it is bought for once. The list counts batches, never occurrences.
 *   - **Nothing converts.** 5 dl and 2 rkl of milk are two amounts of milk, and
 *     they read `5 dl + 2 rkl`. Turning spoons into decilitres would mean
 *     guessing at a density this app does not know.
 *   - **Nothing is invented.** A line whose source never stated an amount —
 *     "hieman", "maun mukaan", "paistamiseen" — keeps its place on the list and
 *     says the amount is in the recipe. It does not get a number made up for it.
 */

/** How a line with no stated amount reads where a total would be. */
export const AMOUNT_IN_RECIPE = "määrä reseptin mukaan";

/** One ingredient line of one selected batch, before anything is added up. */
export interface ShoppingLine extends Measurement {
  batchId: number;
  /** The dish that gets cooked — the part's title never replaces it. */
  batchTitle: string;
  /** How much of the dish this cooking makes; 1 is the recipe as written. */
  multiplier: number;
  /** The named part this line sits in, or null when it is the dish's own. */
  partTitle: string | null;
  /** The dish, even for a part's line: an override is set per dish (#161). */
  recipeId: number;
  /**
   * The recipe row this line is actually stored on — the dish, or one of its
   * parts. `recipeId` is the dish for everything, which is right for a product
   * override and wrong for an alternative group: group numbers are scoped to
   * the row, so a dish and its part can both be using group 1.
   */
  sourceRecipeId: number;
  /** The alternative group this line is an option in, or null (#183). */
  alternativeGroup: AlternativeGroup;
  /**
   * The line's cooking-order phase. The list never renders one, and carries it
   * for one reason: a group's boundary is the recipe row *and* the section the
   * cooking view draws it in, so counting a pair the screen showed apart would
   * buy one ingredient too few.
   */
  phase: RecipePhase;
  ingredientId: number;
  ingredientName: string;
  /** What this ingredient can be bought as, in the order they were added. */
  products: ProductChoice[];
  /** The one product this dish insists on for this ingredient, if any. */
  override: ProductChoice | null;
  sourceLine: string;
}

/** Where one slice of an ingredient's total came from. */
export interface ShoppingContribution {
  batchId: number;
  batchTitle: string;
  partTitle: string | null;
  /** The scaled amount as it reads, or "" when the source stated none. */
  amount: string;
  /**
   * The source wording, but only where it says something the amount above it
   * does not — the same rule the recipe screen reads by
   * (`scaling.ts::sourceWorthShowing`). "5 dl maitoa" under "5 dl" is noise;
   * "hieman sitruunaruohoa" under nothing at all is the whole answer.
   */
  sourceLine: string;
}

/** One product to buy, and how many of it. */
export interface ChosenPackage {
  product: ProductChoice;
  count: number;
}

export interface ShoppingItem {
  /**
   * What a form calls this row. Usually the ingredient, but a row pinned to one
   * recipe is its own row and needs its own name — `12` and `12:r7` are two
   * lines on the same list and two different things to buy.
   */
  key: string;
  ingredientId: number;
  /** Set only on a pinned row: the dish whose own product this row follows. */
  recipeId: number | null;
  recipeTitle: string | null;
  name: string;
  /** `5 dl + 2 rkl`, or the recipe-says text when no amount was ever stated. */
  total: string;
  /** True when at least one contribution had no stated amount. */
  hasUnstated: boolean;
  /** Everything this row could be bought as — one product when it is pinned. */
  products: ProductChoice[];
  /**
   * What to actually buy: the packages that cover the total, or the single
   * chosen product with no count when the sizes do not allow working one out.
   * Empty when nothing is mapped and the row goes as a written reminder.
   */
  chosen: ChosenPackage[];
  /** `800 g` — what the chosen packages hold, when a count was worked out. */
  packageTotal: string | null;
  /** The dishes this row's amount came from, for the "in this recipe" choice. */
  recipes: Array<{ id: number; title: string }>;
  contributions: ShoppingContribution[];
}

/**
 * The list itself: every ingredient the given lines call for, once each.
 *
 * Lines arrive per batch, so the same ingredient written twice inside one
 * recipe — and the same ingredient in a dish and in one of its parts — lands in
 * the same total, which is what a person pushing a trolley needs.
 *
 * Each contribution is scaled and rounded first, and the total is the sum of
 * those rounded amounts rather than a rounding of the exact sum. That way the
 * breakdown a member opens actually adds up to the number above it; a total
 * that disagreed with its own explanation would be worse than a slightly
 * generous one, and in a kitchen slightly generous is the safe direction.
 *
 * The one thing that splits a row in two is a recipe's own product (#161). A
 * kanapasta pinned to a marinated fillet and a kanacurry buying whatever is
 * generic are not 750 g of the same thing: adding them up would either buy the
 * curry a marinated fillet or lose the pasta the one it asked for. So a pinned
 * dish gets its own row, with its own total and its own packages, and the
 * generic pile is what is left.
 */
export function shoppingList(lines: ShoppingLine[]): ShoppingItem[] {
  const items = new Map<string, Building>();

  // A "kerma tai kookosmaito" line is one thing to buy, not two, so only the
  // first option of each group reaches the list (#183). Scoped to the cooking,
  // the recipe row it is stored on and the cooking-order section it renders
  // in: the same dish planned twice is two cookings that each need their
  // choice bought, a dish's group 1 has nothing to do with its part's, and two
  // options a cook reads in different sections are two lines rather than a
  // choice. That last one is the same question `recipe-save.ts` refuses to let
  // a group cross, so this can only ever agree with the screen.
  const buying = chosenAlternatives(
    lines,
    (line) =>
      `${line.batchId}:${line.sourceRecipeId}:${phaseBucket(line.phase)}`,
  );

  for (const line of buying) {
    const pinned = line.override !== null;
    const rowKey = pinned
      ? `${line.ingredientId}:r${line.recipeId}`
      : String(line.ingredientId);
    let item = items.get(rowKey);
    if (item === undefined) {
      item = {
        key: rowKey,
        ingredientId: line.ingredientId,
        recipeId: pinned ? line.recipeId : null,
        recipeTitle: pinned ? line.batchTitle : null,
        name: line.ingredientName,
        products: line.override !== null ? [line.override] : line.products,
        recipes: [],
        units: new Map(),
        contributions: [],
      };
      items.set(rowKey, item);
    }
    if (!item.recipes.some((one) => one.id === line.recipeId)) {
      item.recipes.push({ id: line.recipeId, title: line.batchTitle });
    }

    const scaled = scaleMeasurement(line, line.multiplier);
    const worthShowing = sourceWorthShowing(
      { ...line, ingredient: line.ingredientName },
      line.multiplier,
    );

    item.contributions.push({
      batchId: line.batchId,
      batchTitle: line.batchTitle,
      partTitle: line.partTitle,
      amount: formatMeasurement(scaled),
      sourceLine: worthShowing ? line.sourceLine : "",
    });

    if (scaled.quantity === null) continue;

    // Only the primary measurement is added up. A line written "½ kpl (500 g)"
    // states one amount twice (ADR-0001), so counting both would double it —
    // the second one stays visible in the breakdown instead.
    const key = unitKey(scaled.unit);
    const running = item.units.get(key);
    if (running === undefined) {
      item.units.set(key, {
        unit: scaled.unit,
        quantity: scaled.quantity,
        quantityMax: scaled.quantityMax ?? scaled.quantity,
        ranged: scaled.quantityMax !== null,
      });
    } else {
      running.quantity += scaled.quantity;
      running.quantityMax += scaled.quantityMax ?? scaled.quantity;
      running.ranged = running.ranged || scaled.quantityMax !== null;
    }
  }

  return [...items.values()]
    .map((item) => {
      const bought = buy(item);
      return {
        key: item.key,
        ingredientId: item.ingredientId,
        recipeId: item.recipeId,
        recipeTitle: item.recipeTitle,
        name: item.name,
        total: totalText(item),
        hasUnstated: item.contributions.some((one) => one.amount === ""),
        products: item.products,
        chosen: bought.chosen,
        packageTotal: bought.packageTotal,
        recipes: item.recipes,
        contributions: item.contributions,
      };
    })
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, "fi") ||
        (a.recipeTitle ?? "").localeCompare(b.recipeTitle ?? "", "fi"),
    );
}

/**
 * Which packages this row is buying.
 *
 * The optimisation only happens where all three of its conditions hold: the
 * row's total is one amount this app can convert (`5 dl`, `700 g` — not
 * `5 dl + 2 rkl`, and not spoons), and at least one of its products has a
 * package size in that same family. Otherwise the row falls back to what it has
 * always done — the chosen product, once, with no count claimed — because a
 * count worked out from a size nobody knows is worse than none (#161).
 */
function buy(item: Building): { chosen: ChosenPackage[]; packageTotal: string | null } {
  if (item.products.length === 0) return { chosen: [], packageTotal: null };

  const fallback = {
    chosen: [{ product: item.products[0]!, count: 1 }],
    packageTotal: null,
  };

  const need = neededAmount(item);
  if (need === null) return fallback;

  const sized = new Map<string, ProductChoice>();
  const options = [];
  for (const product of item.products) {
    const size = productSize(product);
    if (size === null || sized.has(product.ean)) continue;
    sized.set(product.ean, product);
    options.push({ key: product.ean, size });
  }

  const plan = planPackages(need, options);
  if (plan === null) return fallback;

  return {
    chosen: plan.picks.map((pick) => ({
      product: sized.get(pick.key)!,
      count: pick.count,
    })),
    packageTotal: formatBaseAmount({ family: need.family, amount: plan.total }),
  };
}

/**
 * The row's total as one amount to cover, or null when it is not one amount.
 *
 * A ranged total is covered at its top: `1–1½ l` has to be enough at 1½ l, and
 * buying for the bottom of the range is how somebody ends up short at the hob.
 * A row with an unstated contribution still counts what *is* stated — the row
 * goes on saying `+ määrä reseptin mukaan` beside it, so nothing is hidden.
 */
function neededAmount(item: Building): BaseAmount | null {
  let need: BaseAmount | null = null;

  for (const running of item.units.values()) {
    const base = baseAmount(
      running.ranged ? running.quantityMax : running.quantity,
      running.unit,
    );
    if (base === null) return null;
    if (need === null) {
      need = base;
      continue;
    }
    if (need.family !== base.family) return null;
    need = { family: need.family, amount: need.amount + base.amount };
  }

  return need;
}

interface RunningUnit {
  unit: string | null;
  quantity: number;
  quantityMax: number;
  ranged: boolean;
}

interface Building {
  key: string;
  ingredientId: number;
  recipeId: number | null;
  recipeTitle: string | null;
  name: string;
  products: ProductChoice[];
  recipes: Array<{ id: number; title: string }>;
  units: Map<string, RunningUnit>;
  contributions: ShoppingContribution[];
}

/**
 * `5 dl + 2 rkl` — one term per unit, in the order the units were first met,
 * because that is the order the recipes were selected in.
 */
function totalText(item: Building): string {
  const terms = [...item.units.values()].map((running) =>
    formatMeasurement({
      quantity: running.quantity,
      quantityMax: running.ranged ? running.quantityMax : null,
      unit: running.unit,
      altQuantity: null,
      altUnit: null,
    }),
  );

  if (item.contributions.some((one) => one.amount === "")) {
    terms.push(AMOUNT_IN_RECIPE);
  }

  return terms.join(" + ");
}

/**
 * What counts as the same unit. Case and surrounding space are noise — "DL"
 * and "dl" are one unit — but nothing beyond that is normalised, because
 * deciding that "rkl" and "ruokalusikka" are the same word is the start of the
 * conversion this list deliberately does not do.
 */
function unitKey(unit: string | null): string {
  return (unit ?? "").trim().toLocaleLowerCase("fi");
}

// ---------------------------------------------------------------- the query

interface LineRow {
  batch_id: number;
  batch_title: string;
  multiplier: number;
  part_title: string | null;
  quantity: number | null;
  quantity_max: number | null;
  unit: string | null;
  alt_quantity: number | null;
  alt_unit: string | null;
  recipe_id: number;
  source_recipe_id: number;
  ingredient_id: number;
  ingredient_name: string;
  source_line: string;
  alternative_group: number | null;
  phase: string | null;
}

/**
 * Every ingredient line the given batches call for, dish and named parts alike.
 *
 * The join reaches a part through `parent_id`, so a lasagne brings its
 * jauhelihakastike and its juustokastike with it. A part is a piece of the dish
 * (ADR-0002), so every row carries the batch's multiplier and every one of them
 * scales by it.
 *
 * Scoped by the *batch's* household, and only there. That is the one hop that
 * matters, and since #143 it is the only one that can be asked: a batch may
 * plan a recipe another household published, so requiring the dish to belong to
 * the planning household would silently drop every shared recipe off the list —
 * a shopping list quietly missing a meal's ingredients. The ingredient join
 * carries no household either, because the dictionary is global now.
 *
 * A batch belonging to another household still contributes nothing.
 */
export async function shoppingLinesFor(
  db: D1Database,
  householdId: number,
  batchIds: number[],
): Promise<ShoppingLine[]> {
  if (batchIds.length === 0) return [];

  const placeholders = batchIds.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT planned_batch.id AS batch_id,
              dish.title AS batch_title,
              planned_batch.multiplier,
              CASE WHEN source.id = dish.id THEN NULL ELSE source.title END
                AS part_title,
              ingredient_line.quantity,
              ingredient_line.quantity_max,
              ingredient_line.unit,
              ingredient_line.alt_quantity,
              ingredient_line.alt_unit,
              dish.id AS recipe_id,
              source.id AS source_recipe_id,
              ingredient.id AS ingredient_id,
              ingredient.name AS ingredient_name,
              ingredient_line.source_line,
              ingredient_line.alternative_group,
              ingredient_line.phase
         FROM planned_batch
         JOIN recipe AS dish
           ON dish.id = planned_batch.recipe_id
         JOIN recipe AS source
           ON source.household_id = dish.household_id
          AND (source.id = dish.id OR source.parent_id = dish.id)
         JOIN ingredient_line ON ingredient_line.recipe_id = source.id
         JOIN ingredient
           ON ingredient.id = ingredient_line.ingredient_id
        WHERE planned_batch.household_id = ?
          AND planned_batch.id IN (${placeholders})
        ORDER BY planned_batch.id,
                 source.part_position,
                 source.id,
                 ingredient_line.position`,
    )
    .bind(householdId, ...batchIds)
    .all<LineRow>();

  // The products are a second and a third query rather than two more joins: an
  // ingredient with three package sizes would otherwise multiply every one of
  // its lines by three and the totals would have to be de-duplicated back out.
  const ingredientIds = [...new Set(results.map((row) => row.ingredient_id))];
  const recipeIds = [...new Set(results.map((row) => row.recipe_id))];
  const [products, overrides] = await Promise.all([
    productsForIngredients(db, ingredientIds),
    overridesForRecipes(db, householdId, recipeIds),
  ]);

  // Sizes that #147's mapping never had a column for, read once and written
  // down. After this pass the list is working from stored data again.
  await backfillPackageSizes(db, [
    ...[...products.values()].flat(),
    ...overrides.values(),
  ]);

  return results.map((row) => ({
    batchId: row.batch_id,
    batchTitle: row.batch_title,
    multiplier: row.multiplier,
    partTitle: row.part_title,
    quantity: row.quantity,
    quantityMax: row.quantity_max,
    unit: row.unit,
    altQuantity: row.alt_quantity,
    altUnit: row.alt_unit,
    recipeId: row.recipe_id,
    sourceRecipeId: row.source_recipe_id,
    alternativeGroup: alternativeGroup(row.alternative_group),
    phase: recipePhase(row.phase),
    ingredientId: row.ingredient_id,
    ingredientName: row.ingredient_name,
    products: products.get(row.ingredient_id) ?? [],
    override: overrides.get(overrideKey(row.recipe_id, row.ingredient_id)) ?? null,
    sourceLine: row.source_line,
  }));
}
