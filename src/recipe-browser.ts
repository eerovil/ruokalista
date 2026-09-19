import { CATEGORY_STYLE, categoryFilter, type Vocabulary } from "./categories.ts";
import { cookedRecord, type CookHistory } from "./cook-history.ts";
import { shortDate } from "./dates.ts";
import recipeBrowserClient from "./generated/recipe-browser.ts";
import { html, raw, type Raw } from "./html.ts";
import { recipeImage } from "./recipe-picture.ts";
import type { RecipeSummary } from "./recipe-read.ts";

/**
 * The one recipe browser (#307).
 *
 * Browsing recipes is one thing the household does, and it was two: `/recipes`
 * had the search and the category chips, while `/picker` — the screen somebody
 * is actually standing on when they want to find a dish — had a search box and
 * nothing else. This module is the single surface both go through, so a filter
 * or a sort added here appears on every screen that lists recipes rather than
 * on whichever one it was written for.
 *
 * What a screen keeps for itself is what a row *does*: `/recipes` opens the
 * recipe and offers the bulk tick, `/picker` plans it at a multiplier. That
 * arrives as `row(recipe, card)` — the card is built here so both screens show
 * a recipe the same way, and the screen decides only what surrounds it.
 *
 * The three controls are links and a form, not script: the state is in the URL,
 * so it survives the back button, a bookmark and a reload. `recipe-browser.ts`
 * in `src/client/` adds instant text filtering on top of that, and takes
 * nothing away when it is absent.
 */

export const SORTS = ["uusin", "kokattu", "unohtuneet"] as const;
export type SortKey = (typeof SORTS)[number];

export const DEFAULT_SORT: SortKey = "uusin";

const SORT_LABELS: Record<SortKey, string> = {
  uusin: "Uusimmat",
  kokattu: "Viimeksi kokatut",
  unohtuneet: "Kauan kokkaamatta",
};

/** What the reader has asked this list to show, and in what order. */
export interface BrowseState {
  query: string;
  category: string | null;
  sort: SortKey;
}

/**
 * The category a list was asked to show, or null for all of them.
 * An unknown slug is read as no filter rather than as an empty list.
 */
export function askedCategory(
  vocabulary: Vocabulary,
  value: string | null,
): string | null {
  return value !== null && vocabulary.has(value) ? value : null;
}

/** An unknown order is the default one, for the same reason. */
export function askedSort(value: string | null): SortKey {
  return SORTS.includes(value as SortKey) ? (value as SortKey) : DEFAULT_SORT;
}

/**
 * Read the browse state from wherever this request carries it — a query string
 * on a screen, form fields on the post that comes back to one.
 */
export function browseState(
  vocabulary: Vocabulary,
  read: (name: string) => string | null,
): BrowseState {
  return {
    query: read("q") ?? "",
    category: askedCategory(vocabulary, read("kategoria")),
    sort: askedSort(read("jarjestys")),
  };
}

export function browseStateFrom(
  vocabulary: Vocabulary,
  params: URLSearchParams,
): BrowseState {
  return browseState(vocabulary, (name) => params.get(name));
}

/** The fields a form has to carry so a post comes back to the same list. */
export function browseFields(state: BrowseState): Raw {
  return html`<input
      type="hidden"
      name="q"
      class="browse-carried"
      value="${state.query}"
    />
    ${state.category === null
      ? ""
      : html`<input type="hidden" name="kategoria" value="${state.category}" />`}
    ${state.sort === DEFAULT_SORT
      ? ""
      : html`<input type="hidden" name="jarjestys" value="${state.sort}" />`}`;
}

function inCategory(
  summaries: readonly RecipeSummary[],
  category: string | null,
): RecipeSummary[] {
  if (category === null) return [...summaries];
  return summaries.filter((recipe) => recipe.categories.includes(category));
}

/**
 * Order the list the way the reader asked.
 *
 * A recipe nobody has cooked has no last-cooked day at all, and the two orders
 * put it where it means something rather than where a null sorts: last under
 * "viimeksi kokatut", because there is nothing recent about it, and first under
 * "kauan kokkaamatta", because nothing has been longer. The sort is stable, so
 * within either group the list keeps the order it arrived in — newest first for
 * a household's own dishes, and its own recipes still ahead of shared ones.
 */
export function sortRecipes(
  recipes: readonly RecipeSummary[],
  sort: SortKey,
  history: CookHistory,
): RecipeSummary[] {
  const ordered = [...recipes];
  if (sort === DEFAULT_SORT) return ordered;

  const cooked = (recipe: RecipeSummary) =>
    cookedRecord(history, recipe.id).lastCooked;

  return ordered.sort((a, b) => {
    const left = cooked(a);
    const right = cooked(b);
    if (left === right) return 0;
    if (left === null) return sort === "kokattu" ? 1 : -1;
    if (right === null) return sort === "kokattu" ? -1 : 1;
    return sort === "kokattu" ? right.localeCompare(left) : left.localeCompare(right);
  });
}

/** Where this browser is, and what every link it draws has to carry. */
export interface BrowseScreen {
  /** The screen's own path, which the form and every chip points back at. */
  path: string;
  /** Query fields this screen cannot lose — the picker's day and meal. */
  carried?: Record<string, string>;
}

export interface BrowseOptions {
  state: BrowseState;
  vocabulary: Vocabulary;
  /** Everything matching the text search, before the category narrows it. */
  matching: readonly RecipeSummary[];
  history: CookHistory;
  /** Whose screen this is, so another household's recipe says whose it is. */
  viewerHouseholdId: number;
  /** The `<ul>`'s classes: the list's own look is the screen's to keep. */
  listClass: string;
  /**
   * What one row holds: the shared card, and whatever this screen lets it do.
   * The `<li>` around it is the browser's, so every list is filterable alike.
   */
  row: (recipe: RecipeSummary, card: Raw) => Raw;
  /** What surrounds the list here — the recipe list's bulk form, or nothing. */
  wrap?: (list: Raw) => Raw;
  /** Said between the filters and the list, after a bulk action. */
  notice?: Raw;
  /** What this list calls its contents in a refusal. */
  noun?: string;
  /** What to say when the household has nothing here at all. */
  emptyAll: string;
  /** The way out of an empty filtered list, and of an empty screen. */
  emptyAction?: Raw;
  resetLabel?: string;
}

/**
 * The whole browse surface: search, chips, the list, and what to say when
 * nothing matches.
 */
export function recipeBrowser(
  screen: BrowseScreen,
  options: BrowseOptions,
): Raw {
  const { state, vocabulary, history } = options;
  const noun = options.noun ?? "reseptiä";
  const recipes = sortRecipes(
    inCategory(options.matching, state.category),
    state.sort,
    history,
  );
  const link = (changed: Partial<BrowseState>) =>
    browseHref(screen, { ...state, ...changed });

  const list = html`<ul class="${options.listClass}">
    ${recipes.map(
      (recipe) => html`<li data-haku="${searchKey(recipe)}">
        ${options.row(recipe, recipeCard(options, recipe))}
      </li>`,
    )}
  </ul>`;

  return html`<div
    class="browse"
    data-recipe-browser
    data-none="${`Haku "%s" ei löytänyt yhtään ${noun}.`}"
  >
    <form method="get" action="${screen.path}" class="browse-search">
      ${carriedFields(screen)}
      ${state.category === null
        ? ""
        : html`<input type="hidden" name="kategoria" value="${state.category}" />`}
      ${state.sort === DEFAULT_SORT
        ? ""
        : html`<input type="hidden" name="jarjestys" value="${state.sort}" />`}
      <input
        type="search"
        name="q"
        value="${state.query}"
        placeholder="Hae nimellä"
        aria-label="Hae nimellä"
      />
      <button type="submit" class="browse-go">Hae</button>
    </form>
    ${categoryFilter(
      vocabulary,
      (slug) => link({ category: slug }),
      state.category,
      availableCategories(options.matching),
    )}
    ${sortFilter(link, state.sort)}
    ${options.notice ?? ""}
    ${recipes.length === 0
      ? html`<div class="nothing">
          <p class="empty">
            ${state.category !== null
              ? `Kategoriassa ${vocabulary.label(state.category)} ei ole yhtään ${noun}.`
              : state.query.trim() === ""
                ? options.emptyAll
                : `Haku "${state.query.trim()}" ei löytänyt yhtään ${noun}.`}
          </p>
          ${state.category === null && state.query.trim() === ""
            ? (options.emptyAction ?? "")
            : html`<p>
                <a href="${browseHref(screen, { ...state, query: "", category: null })}"
                  >${options.resetLabel ?? "Näytä kaikki reseptit"}</a
                >
              </p>`}
        </div>`
      : (options.wrap ?? ((inner: Raw) => inner))(list)}
    <p class="empty browse-none" hidden></p>
    <script>${raw(recipeBrowserClient)}</script>
    ${BROWSE_STYLE} ${CATEGORY_STYLE}
  </div>`;
}

/** One recipe, drawn the same way wherever it is browsed. */
function recipeCard(options: BrowseOptions, recipe: RecipeSummary): Raw {
  return html`${recipeImage(recipe, "thumb")}
    <span class="recipes-text">
      <span class="recipes-title">${recipe.title}</span>
      <span class="meta">${metaLine(options, recipe)}</span>
    </span>`;
}

/**
 * The one line under a recipe's name.
 *
 * Cooking first, because that is what the reader is choosing on: how many times
 * this kitchen has made it and when it last did. Categories after it, and — on
 * a recipe somebody else shared — whose it is, which is the one thing a shared
 * row cannot leave out. One line and not three: the picker row already carries
 * a thumbnail, a multiplier and a button, and this list is read on a phone.
 */
function metaLine(options: BrowseOptions, recipe: RecipeSummary): string {
  const parts = [cookLine(options.history, recipe)];
  if (recipe.householdId !== options.viewerHouseholdId) {
    parts.push(recipe.householdName);
  }
  if (recipe.categories.length > 0) {
    parts.push(
      recipe.categories.map((slug) => options.vocabulary.label(slug)).join(", "),
    );
  }
  return parts.join(" · ");
}

export function cookLine(
  history: CookHistory,
  recipe: RecipeSummary,
): string {
  const record = cookedRecord(history, recipe.id);
  if (record.times === 0 || record.lastCooked === null) return "Ei vielä kokattu";
  return `Kokattu ${record.times}× · viimeksi ${shortDate(record.lastCooked)}`;
}

/**
 * The lowercased text the browser's instant search matches a row against.
 *
 * The recipe's name and nothing else, because that is exactly what the server
 * matches in `recipe-read.ts::filterByTitle` and the box says **Hae nimellä**.
 * The instant search is an enhancement of `?q=`, not a second search with its
 * own idea of a match: a name that finds a dish with script has to find it
 * without, or the fallback is a different feature wearing the same box. It
 * briefly also matched the sharing household's name, which made `Naapuri` a
 * query that worked one way and not the other.
 *
 * Finnish folding in memory, for the same reason the server does it there:
 * SQLite's case-insensitivity is ASCII-only, and Ä is not ASCII. The browser's
 * own `toLowerCase` agrees with this for the Finnish alphabet.
 */
export function searchKey(recipe: RecipeSummary): string {
  return recipe.title.toLocaleLowerCase("fi");
}

function availableCategories(recipes: readonly RecipeSummary[]): string[] {
  return [...new Set(recipes.flatMap((recipe) => recipe.categories))];
}

/**
 * The order chips, drawn as the category chips are and for the same reason: a
 * chosen order is a place, so it survives a reload and needs no script. Three
 * of them, because the fourth way to order a list of dinners is the one nobody
 * asked for.
 */
function sortFilter(
  link: (changed: Partial<BrowseState>) => string,
  current: SortKey,
): Raw {
  return html`<nav class="browse-sort" aria-label="Järjestys">
    ${SORTS.map(
      (sort) => html`<a
        class="${sort === current ? "chip is-on" : "chip"}"
        href="${link({ sort })}"
        ${sort === current ? raw('aria-current="page"') : ""}
        >${SORT_LABELS[sort]}</a
      >`,
    )}
  </nav>`;
}

function carriedFields(screen: BrowseScreen): Raw {
  return html`${Object.entries(screen.carried ?? {}).map(
    ([name, value]) => html`<input type="hidden" name="${name}" value="${value}" />`,
  )}`;
}

/** One address for one browse state, so every control builds links alike. */
export function browseHref(screen: BrowseScreen, state: BrowseState): string {
  const params = new URLSearchParams(screen.carried ?? {});
  if (state.query.trim() !== "") params.set("q", state.query);
  if (state.category !== null) params.set("kategoria", state.category);
  if (state.sort !== DEFAULT_SORT) params.set("jarjestys", state.sort);
  const search = params.toString();
  return search === "" ? screen.path : `${screen.path}?${search}`;
}

/**
 * The browser's own rules. The chip row's are `CATEGORY_STYLE`'s, which this
 * screen already loads — the order chips deliberately reuse them rather than
 * inventing a second chip.
 */
export const BROWSE_STYLE = html`<style>
  .browse-search {
    display: flex;
    gap: 0.4rem;
  }
  .browse-sort {
    margin-top: -0.6rem;
  }
  /* A row the instant search has filtered out. Said here because .recipes a
     and .pick li both set a display of their own. */
  .browse li[hidden] {
    display: none;
  }
  /* The picker's row: the card sits beside the multiplier and the button, so
     it is the row's flexible part and the thumbnail rides inside it. */
  .pick .pick-title {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .browse-none {
    margin: 1.5rem 0;
    text-align: center;
  }
  .recipes-title {
    overflow-wrap: break-word;
  }
</style>`;
