/**
 * Instant text search in the recipe browser (#307).
 *
 * Every recipe the household may see is already on the screen — the browser
 * does not paginate and does not fetch a page of rows — so asking the server to
 * search them again is a round trip for an answer the browser is holding. This
 * filters the rendered rows on every keystroke, with no debounce, because there
 * is nothing to wait for.
 *
 * Two facts keep that honest:
 *
 * - **It must never search a subset.** A page that arrives with `?q=` was
 *   narrowed by the server, so the rows that did not match are not in the DOM
 *   at all. Rather than filter what is left, this replaces that page once with
 *   the same one without `q` — the full list — carrying the typed text over in
 *   `#haku=`. So the round trip happens at most once, on arrival, and never
 *   while typing.
 * - **`?q=` still works.** It is what a browser without script submits, and
 *   what a bookmark or a shared link may hold. The server-side search is not
 *   removed; it is the floor this stands on.
 *
 * The typed text lives in the fragment rather than the query string: it is this
 * browser's view of the list, so it needs no request to change, and a category
 * or order chip carries it along instead of dropping it.
 */

var HASH_KEY = "#haku=";

browseInstantly();

function browseInstantly(): void {
  if (typeof document.querySelector !== "function") return;

  var browser = document.querySelector("[data-recipe-browser]");
  if (browser === null || typeof browser.addEventListener !== "function") return;

  // Scoped to the search form: the recipe list also carries the server-side
  // search as a hidden field inside the form its bulk buttons post.
  var box = browser.querySelector(
    ".browse-search input[name=q]",
  ) as HTMLInputElement | null;
  if (box === null) return;

  // Before anything else: make sure the rows on the screen are all of them.
  if (takeTheSearchOffTheUrl()) return;

  var rows = matchableRows(browser);
  var none = browser.querySelector(".browse-none") as HTMLElement | null;
  var template = browser.getAttribute("data-none") || "";
  var chips = browser.querySelectorAll(".chip");
  var posting = carriedForm(browser);

  var carried = textFromHash();
  if (carried !== null) box.value = carried;

  // The button is what submits a search to the server, and there is no longer
  // anything to submit. Pressing Enter in the box does the same thing, so that
  // is stopped too — the list under it is already the answer.
  var go = browser.querySelector(".browse-go") as HTMLElement | null;
  if (go !== null) go.hidden = true;
  var form = box.form;
  if (form !== null) {
    form.addEventListener("submit", function (event: Event): void {
      event.preventDefault();
    });
  }

  box.addEventListener("input", filter);
  // Safari's clear cross in a `type=search` box fires this and not `input`.
  box.addEventListener("search", filter);
  filter();

  function filter(): void {
    var typed = box === null ? "" : trim(box.value);
    var needle = typed.toLowerCase();
    var shown = 0;

    for (var index = 0; index < rows.length; index += 1) {
      var row = rows[index]!;
      var key = row.getAttribute("data-haku") || "";
      var matches = needle === "" || key.indexOf(needle) >= 0;
      row.hidden = !matches;
      if (matches) shown += 1;
      else unpick(row);
    }

    say(shown === 0 ? typed : null);
    remember(typed);
  }

  /** What the list says when the typed text matches none of its rows. */
  function say(typed: string | null): void {
    if (none === null) return;
    if (typed === null || rows.length === 0) {
      none.hidden = true;
      return;
    }
    while (none.firstChild) none.removeChild(none.firstChild);
    none.appendChild(
      document.createTextNode(
        template.replace("%s", function (): string {
          return typed;
        }),
      ),
    );
    none.hidden = false;
  }

  /**
   * Keep the typed text in the address, so a category or order chip leads to
   * the same search. Nothing here is required: without `replaceState` the text
   * simply does not survive a chip, and the filtering still works.
   */
  function remember(typed: string): void {
    var hash = typed === "" ? "" : HASH_KEY + encodeURIComponent(typed);
    if (
      window.history &&
      typeof window.history.replaceState === "function" &&
      hash !== window.location.hash
    ) {
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search + hash,
      );
    }
    for (var index = 0; index < chips.length; index += 1) {
      var chip = chips.item(index) as HTMLAnchorElement | null;
      if (chip === null) continue;
      chip.setAttribute("href", withHash(chip.getAttribute("href"), hash));
    }
    // A bulk action posts and comes back to a freshly rendered list. The
    // server renders the whole list — the hidden `q` it carries is the one the
    // server itself last used, which with script is none — so the text has to
    // travel the only way a post can carry it: on the address it posts to.
    for (var target = 0; target < posting.length; target += 1) {
      var where = posting[target]!;
      where.node.setAttribute(where.attribute, withHash(where.action, hash));
    }
  }
}

interface Posting {
  node: Element;
  /** `action` on the form itself, `formaction` on a button that overrides it. */
  attribute: string;
  /** What it said before any search was typed. */
  action: string;
}

/**
 * Every address the list's own form posts to: its `action`, and the
 * `formaction` of each button that goes somewhere else — the category bulk
 * buttons ride inside the publish form exactly that way.
 */
function carriedForm(browser: Element): Posting[] {
  var marker = browser.querySelector(".browse-carried") as HTMLInputElement | null;
  var form = marker === null ? null : marker.form;
  if (form === null) return [];

  var posting: Posting[] = [{
    node: form,
    attribute: "action",
    action: form.getAttribute("action") || "",
  }];
  var overriding = form.querySelectorAll("[formaction]");
  for (var index = 0; index < overriding.length; index += 1) {
    var button = overriding.item(index);
    if (button === null) continue;
    posting.push({
      node: button,
      attribute: "formaction",
      action: button.getAttribute("formaction") || "",
    });
  }
  return posting;
}

function withHash(address: string | null, hash: string): string {
  var text = address || "";
  var cut = text.indexOf("#");
  return (cut < 0 ? text : text.slice(0, cut)) + hash;
}

/**
 * A row hidden by the search is not a row somebody chose. The recipe list's
 * bulk actions read the ticks, and a tick under a hidden row would act on a
 * recipe that is not on the screen — so the tick goes with the row, and the
 * change is announced so the count beneath the list stays true.
 */
function unpick(row: Element): void {
  var boxes = row.getElementsByTagName("input");
  var cleared = false;
  for (var index = 0; index < boxes.length; index += 1) {
    var tick = boxes.item(index) as HTMLInputElement | null;
    if (tick === null || tick.type !== "checkbox" || !tick.checked) continue;
    tick.checked = false;
    cleared = true;
  }
  if (cleared) announceChange(row);
}

function announceChange(node: Element): void {
  if (typeof document.createEvent !== "function") return;
  var event = document.createEvent("HTMLEvents");
  event.initEvent("change", true, false);
  node.dispatchEvent(event);
}

function matchableRows(browser: Element): HTMLElement[] {
  var found = browser.getElementsByTagName("li");
  var rows: HTMLElement[] = [];
  for (var index = 0; index < found.length; index += 1) {
    var row = found.item(index) as HTMLElement | null;
    if (row !== null && row.getAttribute("data-haku") !== null) rows.push(row);
  }
  return rows;
}

/**
 * Replace a server-searched page with the whole list, once.
 *
 * Returns true when it has started that navigation, so the caller stops rather
 * than filtering the subset it is standing in for the moment before the new
 * page arrives.
 */
function takeTheSearchOffTheUrl(): boolean {
  var search = window.location.search;
  if (search.length < 2) return false;

  var kept: string[] = [];
  var asked: string | null = null;
  var pairs = search.slice(1).split("&");
  for (var index = 0; index < pairs.length; index += 1) {
    var pair = pairs[index]!;
    if (pair === "") continue;
    var split = pair.indexOf("=");
    var name = split < 0 ? pair : pair.slice(0, split);
    if (name !== "q") {
      kept.push(pair);
      continue;
    }
    asked = split < 0 ? "" : decodeURIComponent(pair.slice(split + 1).split("+").join(" "));
  }
  if (asked === null) return false;

  var rest = kept.length === 0 ? "" : "?" + kept.join("&");
  var hash = asked === "" ? "" : HASH_KEY + encodeURIComponent(asked);
  window.location.replace(window.location.pathname + rest + hash);
  return true;
}

function textFromHash(): string | null {
  var hash = window.location.hash;
  if (hash.indexOf(HASH_KEY) !== 0) return null;
  try {
    return decodeURIComponent(hash.slice(HASH_KEY.length));
  } catch (_error) {
    return null;
  }
}

function trim(value: string): string {
  return typeof value.trim === "function" ? value.trim() : value;
}
