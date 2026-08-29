import { html, raw, type Raw } from "./html.ts";

/**
 * What kind of food a recipe is (issues #196 and #199).
 *
 * A recipe carries any number of categories, including none — which is what
 * every recipe saved before #196 carries, and what the screens are written to
 * read as an ordinary state rather than as data somebody forgot to fill in.
 *
 * **The vocabulary is one closed list, shared by every household.** That half
 * of #196's decision is unchanged, and it is the important half:
 *
 * - A category means the same thing in every household. Since #143 a recipe can
 *   be read and planned by a household that does not own it, so a per-household
 *   naming table would have let the same shared lasagne be a *Uuniruoka* to its
 *   owner and an unlabelled recipe to everybody else. A household's own habit
 *   belongs on `recipe_preference`; what a dish *is* belongs on the dish.
 * - The picker stays one tap per category and the list filter stays a short row
 *   of chips. Free text per recipe would grow a merge problem and a spelling
 *   problem; a list somebody curates does not.
 *
 * **What #199 changes is where the list lives.** It was a constant in this file
 * and is now the `category` table, so an admin can add, rename, reorder and
 * remove a category without a release (`src/category-admin.ts`, ADR-0013).
 * Loading it is a query, so a `Vocabulary` is read once per request and handed
 * to whatever renders or reads a category — nothing here reaches for a module
 * global, because there no longer is one to reach for.
 *
 * The database still stores the slug (`jalkiruoka`), never the label. Renaming
 * a label still touches no recipe row, and the slugs are still plain ASCII so
 * nothing downstream has to think about `ä` in an identifier.
 */

export interface Category {
  slug: string;
  label: string;
}

/**
 * The vocabulary as one screen sees it: the whole list, in its stored order,
 * with the three questions everything asks of it.
 *
 * A value object rather than a cache. It is read once per request and passed
 * down; two screens in one request would rather share this than agree on
 * invalidation, and an admin's rename has to be visible on the next screen.
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
   * somebody typing — it is a hand-written request, or a form left open across
   * the moment an admin removed a category, and neither is worth putting a
   * refusal in front of a member who did nothing wrong. Duplicates collapse.
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
  if (recipeIds.length === 0) return byRecipe;

  const placeholders = recipeIds.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      // Ordered by the vocabulary's own order, in SQL, so that loading a
      // recipe does not have to carry a `Vocabulary` down with it. A slug the
      // vocabulary no longer has sorts last and still renders as itself.
      `SELECT recipe_category.recipe_id, recipe_category.category
         FROM recipe_category
         LEFT JOIN category ON category.slug = recipe_category.category
        WHERE recipe_category.recipe_id IN (${placeholders})
        ORDER BY category.position IS NULL, category.position,
                 recipe_category.category`,
    )
    .bind(...recipeIds)
    .all<{ recipe_id: number; category: string }>();

  for (const row of results) {
    byRecipe.set(row.recipe_id, [
      ...(byRecipe.get(row.recipe_id) ?? []),
      row.category,
    ]);
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

// ---------------------------------------------------------------- rendering

/**
 * The picker, on the editor and on the import review screen.
 *
 * Checkboxes and no script, which is the standing rule on the editing path. A
 * closed vocabulary is what lets it be this light: seven labels wrap onto two
 * lines on a phone and cost one tap each, so the form does not get heavier for
 * carrying it.
 */
export function categoryChoices(
  vocabulary: Vocabulary,
  selected: readonly string[],
): Raw {
  if (vocabulary.categories.length === 0) return raw("");
  return html`<fieldset class="category-choices">
    <legend>Kategoriat</legend>
    ${vocabulary.categories.map(
      (category) => html`<label
        ><input
          type="checkbox"
          name="category"
          value="${category.slug}"
          ${selected.includes(category.slug) ? raw("checked") : ""}
        />${category.label}</label
      >`,
    )}
  </fieldset>`;
}

/**
 * The recipe list's bulk category control (#199).
 *
 * It rides inside the list form that already exists for publishing, so ticking
 * rows means one thing on this screen rather than two: the same checkboxes feed
 * both. The buttons carry `formaction`, which is how one form reaches a second
 * handler without a second set of checkboxes to keep in step.
 *
 * A `<select>` rather than the editor's row of checkboxes, because a bulk edit
 * is one category at a time on purpose — "add Keitto to these four" is a thing
 * somebody means, while "make these four be exactly Keitto and Lisuke" would
 * quietly throw away categories the recipes already carry.
 *
 * The list keeps whichever category was last chosen, so a refusal comes back
 * with the member's own choice still in the box rather than reset to the first
 * option — and adding one category to two separate selections in a row is two
 * presses, not two presses and two re-pickings.
 */
export function categoryBulkControls(
  vocabulary: Vocabulary,
  selected: string | null,
): Raw {
  if (vocabulary.categories.length === 0) return raw("");
  return html`<fieldset class="bulk-categories">
    <legend>Kategoria valituille</legend>
    <select name="bulkCategory" aria-label="Kategoria">
      ${vocabulary.categories.map(
        (category) =>
          html`<option
            value="${category.slug}"
            ${category.slug === selected ? raw("selected") : ""}
          >
            ${category.label}
          </option>`,
      )}
    </select>
    <button
      type="submit"
      formaction="/recipes/kategoriat"
      name="action"
      value="add"
    >
      Lisää valituille
    </button>
    <button
      type="submit"
      formaction="/recipes/kategoriat"
      name="action"
      value="remove"
    >
      Poista valituilta
    </button>
  </fieldset>`;
}

/** A recipe's categories, as they are printed on the recipe and in a list. */
export function categoryTags(
  vocabulary: Vocabulary,
  slugs: readonly string[],
): Raw {
  if (slugs.length === 0) return raw("");
  return html`<p class="category-tags">
    ${slugs.map(
      (slug) =>
        html`<span class="category-tag">${vocabulary.label(slug)}</span>`,
    )}
  </p>`;
}

/**
 * The list's filter: one chip per category, plus **Kaikki**.
 *
 * Only categories something in the list actually has get a chip, so no chip
 * leads to an empty screen, and the row is as short as the household's own
 * cooking makes it. It scrolls sideways rather than wrapping, because the point
 * of a filter above a list on a phone is that the list is still visible under
 * it.
 *
 * Links rather than a form: the filter is a place, so it survives the back
 * button, a bookmark and a reload, and it needs no script to apply itself.
 */
export function categoryFilter(
  vocabulary: Vocabulary,
  path: string,
  query: string,
  current: string | null,
  available: readonly string[],
): Raw {
  const shown = vocabulary.sort([
    ...available,
    // A chip the reader is standing on stays even if it now matches nothing,
    // or "Kaikki" would be the only way back and the screen would look broken.
    ...(current === null ? [] : [current]),
  ]);
  if (shown.length === 0) return raw("");

  const href = (slug: string | null) => {
    const params = new URLSearchParams();
    if (query.trim() !== "") params.set("q", query);
    if (slug !== null) params.set("kategoria", slug);
    const search = params.toString();
    return search === "" ? path : `${path}?${search}`;
  };

  return html`<nav class="category-filter" aria-label="Rajaa kategorialla">
    <a
      class="${current === null ? "chip is-on" : "chip"}"
      href="${href(null)}"
      ${current === null ? raw('aria-current="page"') : ""}
      >Kaikki</a
    >
    ${shown.map(
      (slug) => html`<a
        class="${slug === current ? "chip is-on" : "chip"}"
        href="${href(slug)}"
        ${slug === current ? raw('aria-current="page"') : ""}
        >${vocabulary.label(slug)}</a
      >`,
    )}
  </nav>`;
}

/**
 * The category rules, kept beside the screens that use them rather than in the
 * shell's stylesheet — `src/html.ts` is the file every screen shares.
 */
export const CATEGORY_STYLE = html`<style>
  .category-filter {
    display: flex;
    gap: 0.4rem;
    margin: 0 0 1rem;
    padding-bottom: 0.2rem;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .category-filter .chip {
    flex: 0 0 auto;
    padding: 0.35rem 0.7rem;
    font-size: 0.85rem;
    text-decoration: none;
    color: inherit;
    white-space: nowrap;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 999px;
  }
  .category-filter .chip.is-on {
    color: var(--accent);
    border-color: var(--accent);
    font-weight: 600;
  }
  .category-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin: 0.3rem 0 0;
  }
  .category-tag {
    padding: 0.15rem 0.5rem;
    font-size: 0.8rem;
    color: var(--accent);
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 999px;
  }
  .category-choices {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem 0.9rem;
    padding: 0;
    margin: 0.8rem 0;
    border: 0;
  }
  .category-choices legend {
    width: 100%;
    margin-bottom: 0.25rem;
    font-weight: 600;
  }
  .category-choices label {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-height: var(--tap-compact);
  }
  .category-choices input {
    width: auto;
    min-height: 0;
  }
  .bulk-categories {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    padding: 0.6rem 0.7rem;
    margin: 0 0 1rem;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: var(--radius);
  }
  .bulk-categories legend {
    padding: 0 0.3rem;
    font-weight: 600;
  }
  .bulk-categories select {
    flex: 1 1 8rem;
    margin: 0;
  }
  .bulk-categories button {
    flex: 1 1 9rem;
  }
  /* Said before the buttons, so the reader knows what "valituille" means
     before pressing one. The island below the list keeps the number true. */
  .selection-count {
    margin: 1rem 0 0.4rem;
    font-size: 0.9rem;
    color: var(--muted);
  }
</style>`;

/**
 * How many recipes the bulk buttons are about to touch (#199).
 *
 * Deliberately ES5 and feature-detected: without it the line still says, in
 * words, that the action applies to the ticked recipes, and every button still
 * works. With it the line counts.
 */
export const SELECTION_COUNT_ISLAND = `
(function () {
  if (typeof document.querySelector !== 'function') return;

  var list = document.querySelector('.recipes.is-selectable');
  var line = document.querySelector('.selection-count');
  if (!list || !line || typeof list.addEventListener !== 'function') return;

  function refresh() {
    var boxes = list.getElementsByTagName('input');
    var chosen = 0;
    for (var index = 0; index < boxes.length; index += 1) {
      if (boxes[index].checked) chosen += 1;
    }
    var said =
      chosen === 0
        ? 'Ei yhtään reseptiä valittuna.'
        : chosen === 1
          ? '1 resepti valittuna.'
          : chosen + ' reseptiä valittuna.';
    while (line.firstChild) line.removeChild(line.firstChild);
    line.appendChild(document.createTextNode(said));
  }

  list.addEventListener('change', refresh, false);
  refresh();
}());`;
