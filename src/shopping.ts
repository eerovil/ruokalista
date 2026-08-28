import { formatMeasurement, type Measurement } from "./quantities.ts";
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
  ingredientId: number;
  ingredientName: string;
  ean: string | null;
  externalProductName: string | null;
  externalProductImageUrl: string | null;
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

export interface ShoppingItem {
  ingredientId: number;
  name: string;
  /** `5 dl + 2 rkl`, or the recipe-says text when no amount was ever stated. */
  total: string;
  /** True when at least one contribution had no stated amount. */
  hasUnstated: boolean;
  ean: string | null;
  externalProductName: string | null;
  externalProductImageUrl: string | null;
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
 */
export function shoppingList(lines: ShoppingLine[]): ShoppingItem[] {
  const items = new Map<number, Building>();

  for (const line of lines) {
    let item = items.get(line.ingredientId);
    if (item === undefined) {
      item = {
        name: line.ingredientName,
        ean: line.ean,
        externalProductName: line.externalProductName,
        externalProductImageUrl: line.externalProductImageUrl,
        units: new Map(),
        contributions: [],
      };
      items.set(line.ingredientId, item);
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

  return [...items.entries()]
    .map(([ingredientId, item]) => ({
      ingredientId,
      name: item.name,
      total: totalText(item),
      hasUnstated: item.contributions.some((one) => one.amount === ""),
      ean: item.ean,
      externalProductName: item.externalProductName,
      externalProductImageUrl: item.externalProductImageUrl,
      contributions: item.contributions,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "fi"));
}

interface RunningUnit {
  unit: string | null;
  quantity: number;
  quantityMax: number;
  ranged: boolean;
}

interface Building {
  name: string;
  ean: string | null;
  externalProductName: string | null;
  externalProductImageUrl: string | null;
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
  ingredient_id: number;
  ingredient_name: string;
  ean: string | null;
  external_product_name: string | null;
  external_product_image_url: string | null;
  source_line: string;
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
              ingredient.id AS ingredient_id,
              ingredient.name AS ingredient_name,
              ingredient.ean,
              ingredient.external_product_name,
              ingredient.external_product_image_url,
              ingredient_line.source_line
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
    ingredientId: row.ingredient_id,
    ingredientName: row.ingredient_name,
    ean: row.ean,
    externalProductName: row.external_product_name,
    externalProductImageUrl: row.external_product_image_url,
    sourceLine: row.source_line,
  }));
}

/**
 * Replace one ingredient's preferred S-group product as one all-field write.
 * The caller has already proved the ingredient is on this household's fresh
 * `Ostettavat` projection and that the product came from a fresh search.
 */
export async function saveExternalProduct(
  db: D1Database,
  ingredientId: number,
  product: { ean: string; name: string; imageUrl: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE ingredient
          SET ean = ?,
              external_product_name = ?,
              external_product_image_url = ?
        WHERE id = ?`,
    )
    .bind(product.ean, product.name, product.imageUrl, ingredientId)
    .run();
  return (result.meta.changes ?? 0) === 1;
}
