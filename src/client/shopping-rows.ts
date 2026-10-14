/**
 * The shopping list's rows: ticking one off without leaving the page, and
 * what a tap on one opens (#358). Loaded on every shopping list.
 *
 * Ticking:
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
      if (row) {
        var still = row.className.indexOf("is-static") !== -1 ? " is-static" : "";
        row.className = (on ? "shopping-item is-excluded" : "shopping-item") + still;
      }
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

  // ------------------------------------------------------ the row's sheet

  /**
   * A tap on a row opens the S-ostoslista product sheet straight away; the
   * old in-page row window is gone (#358). The sheet is the picker's own
   * (`product-picker.ts`), with the row's few actions added to it here: where
   * the amount comes from, a dish's own product and its undo, and the
   * cupboard. A row the picker cannot choose for opens nothing — see
   * `openRow`.
   *
   * Every action here submits the row's own hidden form, not a copy of it, so
   * the scroll keeper sees a press inside the list and puts the list back
   * where it was after the round-trip.
   */

  function requestSubmit(form: HTMLFormElement): void {
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else if (form.dispatchEvent(new Event("submit", { cancelable: true }))) form.submit();
  }

  function make<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.appendChild(document.createTextNode(text));
    return node;
  }

  /** A copy that looks like the row's form and submits the original. */
  function proxy(original: HTMLFormElement): HTMLFormElement {
    var copy = original.cloneNode(true) as HTMLFormElement;
    copy.addEventListener("submit", function (event) {
      event.preventDefault();
      requestSubmit(original);
    });
    return copy;
  }

  function closeAll(): void {
    var close = document.querySelector<HTMLButtonElement>(".s-sheet:not([hidden]) .s-sheet-close");
    if (close) close.click();
  }

  /** The row's own actions on the picker's sheet. */
  function decorate(item: HTMLElement, panel: HTMLElement): void {
    var current = panel.querySelector<HTMLElement>(".s-sheet-current");
    if (!current) return;
    var old = panel.querySelectorAll(".s-sheet-foot, .s-sheet-breakdown, .s-sheet-pinned");
    for (var at = 0; at < old.length; at += 1) old[at]!.parentNode!.removeChild(old[at]!);

    // The amount opens where it comes from.
    var from = item.querySelector(".row-data .shopping-from");
    var amount = panel.querySelector<HTMLElement>(".s-sheet-amount");
    if (from && amount) {
      var breakdown = make("div", "s-sheet-breakdown");
      breakdown.hidden = true;
      breakdown.appendChild(from.cloneNode(true));
      amount.className = "s-sheet-amount is-open-able";
      amount.setAttribute("role", "button");
      amount.setAttribute("tabindex", "0");
      amount.setAttribute("aria-label", "Mistä määrä tulee");
      amount.appendChild(make("span", "s-sheet-amount-caret", " ▾"));
      amount.addEventListener("click", function () {
        breakdown.hidden = !breakdown.hidden;
      });
      current.parentNode!.insertBefore(breakdown, current);
    }

    var foot = make("div", "s-sheet-foot");
    var pantry = item.querySelector<HTMLFormElement>(".row-data form.pantry-action");
    if (pantry) {
      var home = make("div", "s-sheet-foot-line");
      home.appendChild(proxy(pantry));
      home.appendChild(make("span", "meta", item.getAttribute("data-kind") === "pantry"
        ? "Takaisin ostettavaksi, jos sitä ei olekaan kotona."
        : "Aina kotona – ei tule listalle ennen kuin poistat sen kaapista."));
      foot.appendChild(home);
    }

    // A product chosen for one dish only says so, and can be undone (#358).
    var own = item.querySelector<HTMLElement>(".row-data .s-shopping-product[data-oma-resepti]");
    var undo = own ? own.querySelector<HTMLFormElement>(".s-product-sizes form") : null;
    if (own && undo) {
      var scope = own.querySelector(".s-product-scope");
      var pinned = make("div", "s-sheet-pinned");
      pinned.appendChild(make("span", "", scope ? (scope.textContent || "").trim() : "Vain tässä reseptissä"));
      var form = proxy(undo);
      var label = form.querySelector("button");
      if (label) label.textContent = "Kaikille samaksi";
      pinned.appendChild(form);
      current.appendChild(pinned);
    }

    // Package sizes are not offered here: the owner never used them (#358).
    // Sizes already taught keep counting packets on the list.
    if (foot.firstChild) panel.appendChild(foot);
  }

  /**
   * Only a row the S-ostoslista picker can choose a product for opens
   * anything. A cupboard row has its one action on the row, a ticked row is
   * unticked on the row, and a household without the S-ostoslista has nothing
   * to choose — so none of those open a window at all (#358).
   */
  function openRow(item: HTMLElement): void {
    var opener = item.querySelector<HTMLFormElement>(
      '.row-data form.s-product-open:not([data-tapa="lisaa"])',
    );
    var button = opener ? opener.querySelector<HTMLButtonElement>("button") : null;
    if (!opener || (button && button.disabled)) return;
    requestSubmit(opener);
    var panel = document.querySelector<HTMLElement>(".s-sheet .s-sheet-panel");
    if (panel) decorate(item, panel);
  }

  // A row that opens nothing does not say it does.
  each<HTMLElement>(".shopping-item", function (item) {
    if (!item.querySelector('.row-data form.s-product-open:not([data-tapa="lisaa"])')) {
      item.className += " is-static";
      var summary = item.querySelector(".shopping-summary");
      if (summary) {
        summary.removeAttribute("role");
        summary.removeAttribute("tabindex");
      }
    }
  });

  document.addEventListener("click", function (event) {
    var target = event.target instanceof Element ? event.target : null;
    var summary = target ? target.closest(".shopping-summary") : null;
    var item = summary ? summary.closest<HTMLElement>(".shopping-item") : null;
    if (!item) return;
    event.preventDefault();
    closeAll();
    openRow(item);
  });
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    var target = event.target instanceof Element ? event.target : null;
    if (!target || !target.classList.contains("shopping-summary")) return;
    var item = target.closest<HTMLElement>(".shopping-item");
    if (!item) return;
    event.preventDefault();
    openRow(item);
  });

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
