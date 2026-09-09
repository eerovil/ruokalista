import { boundedInChunks } from "./d1-query.ts";

/**
 * What kind of food a recipe is (issues #196 and #199), without any rendering.
 *
 * A recipe carries any number of categories, including none. The vocabulary is
 * one closed list shared by every household, stored in the `category` table and
 * read once per request by callers that need it. The database stores the slug,
 * never the Finnish label, so renaming a label does not rewrite recipe rows.
 *
 * Keep this module dependency-light: category HTML, CSS and browser enhancement
 * live in `categories.ts`. Background/domain code can therefore use the value
 * model and D1 reads without importing `html.ts`.
 */

export interface Category {
  slug: string;
  label: string;
}

/**
 * The vocabulary as one request sees it: the whole list, in stored order, with
 * the small set of lookup/form operations category consumers share.
 *
 * A value object rather than a cache. An admin's rename or reorder is visible
 * on the next request without any invalidation protocol or global mutable state.
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
   * A value outside the vocabulary is dropped rather than refused. These are
   * fixed-value checkboxes, so an unknown slug is a hand-written request or a
   * form left open while an admin removed a category. Duplicates collapse.
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

/** The vocabulary as it is stored, ordered by the position an admin controls. */
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
        // Ordered by the vocabulary's own order, in SQL, so a recipe load does
        // not need to carry a Vocabulary down with it. A removed/unknown slug
        // sorts last and still remains visible as itself.
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
