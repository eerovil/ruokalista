import {
  alternativeGroup,
  type AlternativeGroup,
} from "./alternatives.ts";
import {
  categoriesForRecipe,
  categoriesForRecipes,
} from "./category-data.ts";
import {
  parseStepRefs,
  type StepIngredientRef,
} from "./ingredient-refs.ts";
import {
  overrideKey,
  overridesForRecipes,
  productsForIngredients,
} from "./ingredient-products.ts";
import type { Measurement } from "./quantities.ts";
import type { RecipePhase } from "./recipe-phase.ts";
import { readableRecipeCondition } from "./recipe-publish.ts";

/**
 * Reading the recipe store, without HTTP or rendering dependencies.
 *
 * A recipe belonging to another household is absent unless it has explicitly
 * been made readable through publication or a selected-household share. Writes
 * use `findRecipe`; cross-household reads use `findReadableRecipe`.
 *
 * A part carries no publication state of its own. A readable dish brings its
 * parts with it through the owner's household, while another household cannot
 * address those part rows directly.
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
  /** That household's name, so a shared list can say whose recipe this is. */
  householdName: string;
  /** When it was published, or null while it is not public. */
  publishedAt: string | null;
  /** Selected households that may read it while it is not public. */
  shareCount: number;
  /** Category slugs in vocabulary order. Empty is an ordinary state. */
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
  /** Lines of one recipe row sharing a number are alternatives for each other. */
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
  /** The web address this was read from, for a linked import. */
  sourceUrl: string | null;
  /** Optimistic edit version. Incremented whenever this recipe is changed. */
  revision: number;
  steps: RecipeStep[];
  lines: RecipeLine[];
  /** The dish this is a part of, or null when it is a dish in its own right. */
  parentId: number | null;
  /** That dish's name, so a part's editor can say what it belongs to. */
  parentTitle: string | null;
  /** The dish's named parts, each a recipe of its own. Empty for a plain one. */
  parts: Recipe[];
}

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

/** Dishes other households have made readable to this household. */
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
 * Fill in each summary's categories with one query for the whole filtered list.
 * Joining them into SUMMARY_SELECT would multiply recipe rows.
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

/** Everything this household may put on its week: own dishes first, then shared. */
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
    categories: [],
  };
}

/**
 * Matched here rather than with SQL LIKE: SQLite's case-insensitivity is
 * ASCII-only, so Finnish case folding is done in memory over the small list.
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
  parent_title: string | null;
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
 * One recipe this household owns. Every write path uses this scope so sharing
 * cannot widen an edit, delete or image mutation by accident.
 */
export function findRecipe(
  db: D1Database,
  householdId: number,
  id: number,
  withParts = true,
): Promise<Recipe | null> {
  return loadRecipe(db, householdId, id, withParts, "own");
}

/** One recipe this household may read: its own, public, or selected for it. */
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
              (SELECT parent.title FROM recipe AS parent
                WHERE parent.id = recipe.parent_id) AS parent_title,
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
  const productRecipeId = row.parent_id ?? row.id;
  const [products, overrides, categories] = await Promise.all([
    productsForIngredients(db, ingredientIds),
    overridesForRecipes(db, productHouseholdId, [productRecipeId]),
    row.parent_id === null
      ? categoriesForRecipe(db, row.id)
      : Promise.resolve<string[]>([]),
  ]);

  // A readable dish still loads its parts through the owner's household.
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
    parentTitle: row.parent_title,
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
