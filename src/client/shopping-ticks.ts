/**
 * Ticking a row off the shopping list without leaving the page (#358).
 *
 * "Not this time" (#313) is stored nowhere but the list's own address — the
 * `pois` keys — so a tick has nothing to save and nothing to ask the server.
 * Without this file each tick is a link to the next address and a whole page
 * load; with it, the tap flips the row and rewrites that address in place:
 * the address bar, every form's hidden `pois` fields and every link back to
 * the list, so whatever is pressed next carries the same selection the server
 * would have drawn into it.
 *
 * The links stay real links underneath, which is the no-script path, and the
 * send counts above the list are recounted from the rows themselves so a
 * product picked since the page loaded counts as a product.
 */

var EXCLUDED = "pois";
/** Every form that carries the whole selection carries this field too. */
var CHOSEN = "valittu";
/** `shopping-screens.ts::PANTRY_LIST`: cupboard rows are never on the trip. */
var PANTRY_LIST = "loytyy";

(function () {
  if (!document.querySelector || typeof URL !== "function" || !window.history || !window.history.replaceState) return;

  var excluded: string[] = new URL(window.location.href).searchParams.getAll(EXCLUDED);

  function has(key: string): boolean {
    return excluded.indexOf(key) !== -1;
  }

  function toggled(key: string): string[] {
    var next: string[] = [];
    var index: number;
    for (index = 0; index < excluded.length; index += 1) {
      if (excluded[index] !== key) next.push(excluded[index]!);
    }
    if (!has(key)) next.push(key);
    return next;
  }

  /** The same list address, with `keys` as its rows left off. */
  function withExcluded(href: string, keys: string[]): string {
    var url = new URL(href, window.location.href);
    url.searchParams.delete(EXCLUDED);
    var index: number;
    for (index = 0; index < keys.length; index += 1) url.searchParams.append(EXCLUDED, keys[index]!);
    return url.pathname + url.search + url.hash;
  }

  function each<T extends Element>(selector: string, run: (element: T) => void): void {
    var found = document.querySelectorAll<T>(selector);
    var index: number;
    for (index = 0; index < found.length; index += 1) run(found[index]!);
  }

  function apply(): void {
    window.history.replaceState(window.history.state, "", withExcluded(window.location.href, excluded));

    each<HTMLAnchorElement>("a.row-tick[data-rivi]", function (tick) {
      var key = tick.getAttribute("data-rivi") || "";
      var name = tick.getAttribute("data-nimi") || "";
      var on = has(key);
      tick.className = on ? "row-tick is-on" : "row-tick";
      var label = on
        ? "Ota " + name + " takaisin listalle"
        : "Jätä " + name + " pois tältä listalta";
      tick.setAttribute("aria-label", label);
      tick.setAttribute("title", label);
      tick.setAttribute("href", withExcluded(tick.getAttribute("href") || "", toggled(key)));
      var row = tick.parentElement ? tick.parentElement.querySelector(".shopping-item") : null;
      if (row) row.className = on ? "shopping-item is-excluded" : "shopping-item";
    });

    // Every other way back to this list: the grouping pills and the like.
    each<HTMLAnchorElement>('a[href^="/ostoslista?"]:not(.row-tick)', function (link) {
      link.setAttribute("href", withExcluded(link.getAttribute("href") || "", excluded));
    });

    each<HTMLFormElement>("form", function (form) {
      if (!form.querySelector('input[name="' + CHOSEN + '"]')) return;
      var old = form.querySelectorAll('input[type="hidden"][name="' + EXCLUDED + '"]');
      var anchor: Node | null = form.querySelector('input[name="' + CHOSEN + '"]');
      var index: number;
      for (index = 0; index < old.length; index += 1) old[index]!.parentNode!.removeChild(old[index]!);
      for (index = 0; index < excluded.length; index += 1) {
        var field = document.createElement("input");
        field.type = "hidden";
        field.name = EXCLUDED;
        field.value = excluded[index]!;
        anchor!.parentNode!.insertBefore(field, anchor!.nextSibling);
        anchor = field;
      }
    });

    each<HTMLElement>(".shopping-excluded-note", function (note) {
      note.hidden = excluded.length === 0;
    });

    recount();
  }

  /** `shopping-screens.ts::externalSendPanel`'s counts, read off the rows. */
  function recount(): void {
    var line = document.querySelector<HTMLElement>(".s-send-counts");
    if (!line) return;
    var seen: string[] = [];
    var products = 0;
    var notes = 0;
    each<HTMLElement>(".shopping-list[data-lista] .shopping-item[data-rivi]", function (row) {
      var list = row.closest("[data-lista]");
      if (list && list.getAttribute("data-lista") === PANTRY_LIST) return;
      var key = row.getAttribute("data-rivi") || "";
      if (has(key) || seen.indexOf(key) !== -1) return;
      seen.push(key);
      if (row.querySelector(".s-shopping-product.is-mapped")) products += 1;
      else notes += 1;
    });
    line.setAttribute("data-tuotteet", String(products));
    line.setAttribute("data-muistutukset", String(notes));
    var text = products + (products === 1 ? " tuote" : " tuotetta");
    if (notes > 0) text += " · " + notes + (notes === 1 ? " teksti" : " tekstiä");
    line.textContent = text;
    var empty = products + notes === 0;
    line.hidden = empty;
    each<HTMLElement>(".s-send-form", function (form) {
      form.hidden = empty;
    });
  }

  // Capture phase, so the scroll keeper's bubble-phase listener sees the
  // press already cancelled and writes nothing down for a page that stays.
  document.addEventListener("click", function (event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var target = event.target instanceof Element ? event.target.closest("a.row-tick[data-rivi]") : null;
    if (!target) return;
    event.preventDefault();
    excluded = toggled(target.getAttribute("data-rivi") || "");
    // The first tick shows a sentence above the list and the last one hides
    // it, which would move every row under the thumb; put the tapped one back.
    var before = target.getBoundingClientRect().top;
    apply();
    var moved = target.getBoundingClientRect().top - before;
    if (moved !== 0) window.scrollBy(0, moved);
  }, true);
})();
