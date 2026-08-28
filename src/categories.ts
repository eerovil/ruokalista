import { html, raw, type Raw } from "./html.ts";

/**
 * What kind of food a recipe is (issue #196).
 *
 * A recipe carries any number of categories, including none — which is what
 * every recipe saved before this carries, and what the screens are written to
 * read as an ordinary state rather than as data somebody forgot to fill in.
 *
 * **The vocabulary is closed and lives here.** Two things follow from that, and
 * both are the point:
 *
 * - A category means the same thing in every household. Since #143 a recipe can
 *   be read and planned by a household that does not own it, so a per-household
 *   naming table would have let the same shared lasagne be a *Uuniruoka* to its
 *   owner and an unlabelled recipe to everybody else. A household's own habit
 *   belongs on `recipe_preference`; what a dish *is* belongs on the dish.
 * - The picker stays one tap per category and the list filter stays a short row
 *   of chips. Free text would have grown a management screen, a merge problem
 *   and a spelling problem, none of which #196 asks for.
 *
 * The database stores the slug (`jalkiruoka`), never the label. Renaming a
 * label is then a code change and never a data migration, and the slugs are
 * plain ASCII so nothing downstream has to think about `ä` in an identifier.
 */

export interface Category {
  slug: string;
  label: string;
}

/** The whole vocabulary, in the order it is offered and drawn. */
export const CATEGORIES: readonly Category[] = [
  { slug: "pasta", label: "Pasta" },
  { slug: "keitto", label: "Keitto" },
  { slug: "salaatti", label: "Salaatti" },
  { slug: "uuniruoka", label: "Uuniruoka" },
  { slug: "leivonta", label: "Leivonta" },
  { slug: "jalkiruoka", label: "Jälkiruoka" },
  { slug: "lisuke", label: "Lisuke" },
];

const BY_SLUG = new Map(CATEGORIES.map((category) => [category.slug, category]));

export function isCategorySlug(value: string): boolean {
  return BY_SLUG.has(value);
}

/** The Finnish label for a slug, or the slug itself if it is not one of ours. */
export function categoryLabel(slug: string): string {
  return BY_SLUG.get(slug)?.label ?? slug;
}

/** Slugs in vocabulary order, whatever order they arrived in. */
export function sortCategories(slugs: readonly string[]): string[] {
  return CATEGORIES.map((category) => category.slug).filter((slug) =>
    slugs.includes(slug),
  );
}

/**
 * The categories a submitted form asks for.
 *
 * A value outside the vocabulary is dropped rather than refused. Every one of
 * these is a checkbox with a fixed value, so an unknown slug cannot come from
 * somebody typing — it is a hand-written request or a form left open across a
 * release that removed a category, and neither is worth putting a refusal in
 * front of a member who did nothing wrong. Duplicates collapse.
 */
export function readCategories(form: FormData): string[] {
  return sortCategories(
    form.getAll("category").map((value) => String(value)).filter(isCategorySlug),
  );
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
      `SELECT recipe_id, category
         FROM recipe_category
        WHERE recipe_id IN (${placeholders})`,
    )
    .bind(...recipeIds)
    .all<{ recipe_id: number; category: string }>();

  for (const row of results) {
    byRecipe.set(row.recipe_id, [
      ...(byRecipe.get(row.recipe_id) ?? []),
      row.category,
    ]);
  }

  for (const [recipeId, slugs] of byRecipe) {
    byRecipe.set(recipeId, sortCategories(slugs));
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
export function categoryChoices(selected: readonly string[]): Raw {
  return html`<fieldset class="category-choices">
    <legend>Kategoriat</legend>
    ${CATEGORIES.map(
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
export function categoryBulkControls(selected: string | null): Raw {
  return html`<fieldset class="bulk-categories">
    <legend>Kategoria valituille</legend>
    <select name="bulkCategory" aria-label="Kategoria">
      ${CATEGORIES.map(
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
export function categoryTags(slugs: readonly string[]): Raw {
  if (slugs.length === 0) return raw("");
  return html`<p class="category-tags">
    ${slugs.map(
      (slug) => html`<span class="category-tag">${categoryLabel(slug)}</span>`,
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
  path: string,
  query: string,
  current: string | null,
  available: readonly string[],
): Raw {
  const shown = sortCategories([
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
        >${categoryLabel(slug)}</a
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
