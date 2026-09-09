import { boundedInChunks } from "./d1-query.ts";

/**
 * What kind of food a recipe is (issues #196 and #199), without any rendering.
 *
 * A recipe carries any number of categories, including none — which is what
 * every recipe saved before #196 carries, and what callers read as an ordinary
 * state rather than as data somebody forgot to fill in.
 *
 * **The vocabulary is one closed list, shared by every household.** That is the
 * important domain rule:
 *
 * - A category means the same thing in every household. Since #143 a recipe can
 *   be read and planned by a household that does not own it, so a per-household
 *   naming table would let the same shared lasagne be *Uuniruoka* to its owner
 *   and unlabelled to everybody else. A household's own habit belongs on
 *   `recipe_preference`; what a dish *is* belongs on the dish.
 * - Free text per recipe would grow both spelling and merge problems. One list
 *   an admin curates keeps category identity closed and predictable.
 *
 * Since #199 the list lives in the `category` table instead of a module
 * constant, so an admin can add, rename, reorder and remove a category without
 * a release (`src/category-admin.ts`, ADR-0013). Loading it is a query, so a
 * `Vocabulary` is read once per request and handed down; there is deliberately
 * no process-global cache or mutable module state.
 *
 * The database stores the slug (`jalkiruoka`), never the Finnish label. Renaming
 * a label therefore touches no recipe row, and the slugs stay plain ASCII so
 * downstream storage/query code does not have to treat `ä` as identifier data.
 *
 * Keep this module dependency-light: category HTML, CSS and browser enhancement
 * live in `categories.ts`. Background/domain code can use the value model and
 * D1 reads without importing `html.ts`.
 */

export interface Category {
  slug: string;
  label: string;
}

/**
 * The vocabulary as one request sees it: the whole list, in its stored order,
 * with the three questions category consumers share.
 *
 * A value object rather than a cache. Two operations in one request can share
 * the same value, while an admin's rename/reorder is visible on the next request
 * without an invalidation protocol or global mutable state.
 */
export class Vocabulary {
  readonly categories: readonly Category[];
  private readonly bySlug: Map<string, Category>;

  // Written out rather than declared as a constructor parameter property:
  // `npm run check` runs the dev checks under Node's strip-only TypeScript,
  // which refuses that syntax outright.
  constructor(categories: readonly Category[]) {
    this.categories = categories;
    this.bySlug = new Map(categories.map((category) => [category.slug, category]));
  }

  has(slug: string): boolean {
    return this.bySlug.has(slug);
  }

  /** The Finnish label for a slug, or the slug itself if it is not one of ours. */
  label(slug: string): string {
    return this.bySlug.get(slug)?.label ?? slug;
  }

  /** Slugs in vocabulary order, whatever order they arrived in. */
  sort(slugs: readonly string[]): string[] {
    return this.categories
      .map((category) => category.slug)
      .filter((slug) => slugs.includes(slug));
  }

  /**
   * The categories a submitted form asks for.
   *
   * A value outside the vocabulary is dropped rather than refused. Every one of
   * these is a checkbox with a fixed value, so an unknown slug cannot come from
   * somebody typing — it is a hand-written request, or a form left open while
   * an admin removed a category, and neither is worth putting a refusal in front
   * of a member who did nothing wrong. Duplicates collapse.
   */
  read(form: FormData): string[] {
    return this.sort(
      form
        .getAll("category")
        .map((value) => String(value))
        .filter((slug) => this.has(slug)),
    );
  }
}

/**
 * The vocabulary as it is stored. One small query, ordered by the position an
 * admin can change.
 */
export async function loadVocabulary(db: D1Database): Promise<Vocabulary> {
  const { results } = await db
    .prepare("SELECT slug, label FROM category ORDER BY position, slug")
    .all<Category>();
  return new Vocabulary(results);
}

/** Every category of the given recipes, keyed by recipe id. */
export async function categoriesForRecipes(
  db: D1Database,
  recipeIds: readonly number[],
): Promise<Map<number, string[]>> {
  const byRecipe = new Map<number, string[]>();
  for (const recipeChunk of boundedInChunks(recipeIds)) {
    const placeholders = recipeChunk.map(() => "?").join(", ");
    const { results } = await db
      .prepare(
        // Ordered by the vocabulary's own order, in SQL, so loading a recipe
        // does not have to carry a `Vocabulary` down with it. A slug the
        // vocabulary no longer has sorts last and still renders as itself.
        `SELECT recipe_category.recipe_id, recipe_category.category
           FROM recipe_category
           LEFT JOIN category ON category.slug = recipe_category.category
          WHERE recipe_category.recipe_id IN (${placeholders})
          ORDER BY category.position IS NULL, category.position,
                   recipe_category.category`,
      )
      .bind(...recipeChunk)
      .all<{ recipe_id: number; category: string }>();

    for (const row of results) {
      byRecipe.set(row.recipe_id, [
        ...(byRecipe.get(row.recipe_id) ?? []),
        row.category,
      ]);
    }
  }

  return byRecipe;
}

/** One recipe's categories. Cheap enough to ask for on its own. */
export async function categoriesForRecipe(
  db: D1Database,
  recipeId: number,
): Promise<string[]> {
  const byRecipe = await categoriesForRecipes(db, [recipeId]);
  return byRecipe.get(recipeId) ?? [];
}
