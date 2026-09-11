/**
 * Choosing a shop product for an ingredient, in the browser — the one
 * component, wherever the server drew it.
 *
 * This is the optional half of `src/product-picker.ts`. Every form it takes
 * over remains usable without it: the open button is a real GET to a real
 * product screen, and the result list there is a real POST. What this adds is
 * the fixed sheet, an optimistic selection saved in the background, and a
 * spinner on everything asynchronous (#159, #200).
 *
 * It was the shopping list's, and #302 asks for it on a recipe's ingredient row
 * as well — as the same component rather than a second one, so the two screens
 * cannot drift apart. Nothing here knows which screen it is on: a row says
 * where its selection posts (`data-tallenna`), and one hidden element per
 * screen carries the picture sizes the server drew with.
 */

export interface ProductPictureSlot {
  size: number;
  width: number;
}

export interface ProductPictures {
  row: ProductPictureSlot;
  summary: ProductPictureSlot;
  result: ProductPictureSlot;
}

export interface PickedProduct {
  ean: string;
  name: string;
  imageUrl: string;
  price: number | null;
  priceUnit: string | null;
  available: boolean | null;
  packageQuantity: number | null;
  packageUnit: string | null;
}

export interface PickerRow {
  /** The `<details>` or `<li>` the server marked with `data-product-row`. */
  container: HTMLElement;
  block: HTMLElement;
  body: HTMLElement;
  thumb: HTMLElement | null;
  openers: NodeListOf<HTMLFormElement>;
  opener: HTMLFormElement;
  scopeSource: HTMLElement | null;
  scope: HTMLElement | null;
  mode: "korvaa" | "lisaa";
  name: string;
  aines: string;
  total: string;
  query: string;
  status: HTMLElement | null;
  saving: boolean;
  /** Where a selection posts. The row knows; the component does not. */
  saveUrl: string;
  /** This row follows one dish's own product, not the ingredient's. */
  ownRecipe: boolean;
}

export interface PickerHooks {
  /** A save finished, either way. The shopping list waits for these. */
  onSaveSettled?: (ok: boolean) => void;
  /** A row that was going as a note now has a product. */
  onNoteBecameProduct?: () => void;
}

export interface PickerHandle {
  rows: PickerRow[];
  savesPending: () => boolean;
}

export type RequestCallback = (ok: boolean, payload: unknown) => void;

type FormField =
  | HTMLInputElement
  | HTMLSelectElement
  | HTMLTextAreaElement
  | HTMLButtonElement;

interface SearchEntry {
  done: boolean;
  ok: boolean;
  payload: unknown;
  waiting: RequestCallback[];
}

interface PickerSheet {
  node: HTMLDivElement;
  title: HTMLElement;
  sub: HTMLElement;
  input: HTMLInputElement;
  scopeSlot: HTMLDivElement;
  state: HTMLParagraphElement;
  results: HTMLDivElement;
}

interface SizeFields {
  amount: HTMLInputElement;
  unit: HTMLSelectElement;
}

interface BeforeProduct {
  body: string;
  thumb: string | null;
  blockClass: string;
  openLabel: string | null;
  disabledOpeners: boolean[];
}

var IMAGE_BASE = "https://cdn.s-cloud.fi/v1/";
var SIZE_UNITS = ["g", "kg", "ml", "dl", "l", "kpl"];

// ------------------------------------------------------- shared DOM helpers

/** Nothing on either screen runs at all without these. */
export function browserIsCapable(): boolean {
  return !!(
    window.XMLHttpRequest && window.JSON &&
    typeof document.querySelectorAll === "function" &&
    typeof document.addEventListener === "function"
  );
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (typeof text === "string") node.appendChild(document.createTextNode(text));
  return node;
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function spinner(): HTMLSpanElement {
  var node = el("span", "spinner");
  node.setAttribute("aria-hidden", "true");
  return node;
}

export function busy(node: HTMLElement, text: string): void {
  clear(node);
  node.appendChild(spinner());
  node.appendChild(document.createTextNode(text));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function request(
  method: string,
  url: string,
  body: string | null,
  done: RequestCallback,
): void {
  var xhr = new XMLHttpRequest();
  xhr.open(method, url, true);
  xhr.setRequestHeader("accept", "application/json");
  if (body !== null) {
    xhr.setRequestHeader("content-type", "application/x-www-form-urlencoded");
  }
  xhr.onreadystatechange = function () {
    if (xhr.readyState !== 4) return;
    var payload: unknown = null;
    try {
      payload = JSON.parse(xhr.responseText);
    } catch (_error) {
      payload = null;
    }
    done(xhr.status >= 200 && xhr.status < 300, payload);
  };
  xhr.send(body);
}

export function fieldsOf(
  form: HTMLFormElement,
  extra: Record<string, string>,
  skip: Record<string, number> | null,
): string {
  var parts: string[] = [];
  var fields = form.elements;
  for (var index = 0; index < fields.length; index += 1) {
    var field = fields.item(index) as FormField | null;
    if (!field || !field.name || field.disabled) continue;
    if (skip && skip[field.name]) continue;
    if (field.type === "submit" || field.type === "button") continue;
    if ((field.type === "checkbox" || field.type === "radio") &&
        !(field as HTMLInputElement).checked) {
      continue;
    }
    parts.push(
      encodeURIComponent(field.name) + "=" + encodeURIComponent(field.value),
    );
  }
  for (var key in extra) {
    if (Object.prototype.hasOwnProperty.call(extra, key)) {
      parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(extra[key]!));
    }
  }
  return parts.join("&");
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && isFinite(value) && value > 0 && value % 1 === 0;
}

function pictureSlot(value: unknown): ProductPictureSlot | null {
  if (!isRecord(value)) return null;
  var size = value["size"];
  var width = value["width"];
  return positiveInteger(size) && positiveInteger(width)
    ? { size: size, width: width }
    : null;
}

function readPictureConfig(value: string | null): ProductPictures | null {
  if (!value) return null;
  var parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (_error) {
    return null;
  }
  if (!isRecord(parsed)) return null;
  var row = pictureSlot(parsed["row"]);
  var summary = pictureSlot(parsed["summary"]);
  var result = pictureSlot(parsed["result"]);
  return row && summary && result ? { row: row, summary: summary, result: result } : null;
}

// ------------------------------------------------------------- the component

/**
 * Wire up every picker row this screen drew, and hand back the little the
 * screen around it still needs to know.
 *
 * Returns null when there is nothing to wire — no browser for it, or a screen
 * whose household does not have the integration and therefore drew no settings
 * element at all.
 */
export function startProductPicker(given?: PickerHooks): PickerHandle | null {
  if (!browserIsCapable()) return null;
  var hooks: PickerHooks = given || {};

  var settings = document.querySelector<HTMLElement>("[data-product-picture]");
  if (!settings) return null;
  var picture = readPictureConfig(settings.getAttribute("data-product-picture"));
  if (!picture) return null;

  var PICTURE = picture;
  var rows: PickerRow[] = [];
  var searches: Record<string, SearchEntry | null | undefined> = {};
  var sheet: PickerSheet | null = null;
  var openRow: PickerRow | null = null;
  var toast: HTMLDivElement | null = null;

  // ------------------------------------------- searches, kept by search term

  function search(query: string, callback: RequestCallback | null): void {
    var key = "q:" + query;
    var entry = searches[key];
    if (entry && entry.done) {
      if (callback) callback(entry.ok, entry.payload);
      return;
    }
    if (entry) {
      if (callback) entry.waiting.push(callback);
      return;
    }
    entry = { done: false, ok: false, payload: null, waiting: [] };
    if (callback) entry.waiting.push(callback);
    searches[key] = entry;
    request(
      "GET",
      "/ostoslista/haku?haku=" + encodeURIComponent(query),
      null,
      function (ok, payload) {
        entry!.done = true;
        entry!.ok = ok;
        entry!.payload = payload;
        if (!ok) searches[key] = null;
        var waiting = entry!.waiting;
        entry!.waiting = [];
        for (var index = 0; index < waiting.length; index += 1) {
          waiting[index]!(ok, payload);
        }
      },
    );
  }

  // ----------------------------------------------------------------- the rows

  function collect(): void {
    var items = document.querySelectorAll<HTMLElement>("[data-product-row]");
    for (var index = 0; index < items.length; index += 1) {
      var container = items.item(index);
      if (!container) continue;
      var block = container.querySelector<HTMLElement>(".s-shopping-product");
      var openers = block
        ? block.querySelectorAll<HTMLFormElement>("form.s-product-open")
        : null;
      if (!block || !openers || openers.length === 0) continue;
      var body = block.querySelector<HTMLElement>(".s-shopping-product-body");
      var opener = openers.item(0);
      if (!body || !opener) continue;
      var total = container.querySelector<HTMLElement>(".shopping-total");
      var scopeSource = block.querySelector<HTMLElement>(".s-scope-source");
      var row: PickerRow = {
        container: container,
        block: block,
        body: body,
        thumb: container.querySelector<HTMLElement>(".shopping-thumb"),
        openers: openers,
        opener: opener,
        scopeSource: scopeSource,
        scope: scopeSource
          ? scopeSource.querySelector<HTMLElement>(".s-product-scope-choice")
          : null,
        mode: "korvaa",
        name: container.getAttribute("data-haku") || "",
        aines: container.getAttribute("data-aines") || "",
        total: total ? total.textContent || "" : container.getAttribute("data-maara") || "",
        query: container.getAttribute("data-haku") || "",
        status: block.querySelector<HTMLElement>(".s-status"),
        saving: false,
        saveUrl: opener.getAttribute("data-tallenna") || "/ostoslista/tuote",
        ownRecipe: block.getAttribute("data-oma-resepti") !== null,
      };
      rows.push(row);
    }
  }

  function pictureAtWidth(url: string, width: number): string {
    if (url.indexOf(IMAGE_BASE) !== 0) return url;
    var path = url.slice(IMAGE_BASE.length);
    var slash = path.indexOf("/");
    if (slash <= 0) return url;
    return IMAGE_BASE + "w" + width + "_q75/" + path.slice(slash + 1);
  }

  function productImage(url: string, slot: ProductPictureSlot): HTMLImageElement {
    var image = document.createElement("img");
    image.setAttribute("alt", "");
    image.setAttribute("width", String(slot.size));
    image.setAttribute("height", String(slot.size));
    image.onerror = function () { this.hidden = true; };
    image.src = pictureAtWidth(url, slot.width);
    return image;
  }

  function readProduct(value: unknown): PickedProduct | null {
    if (!isRecord(value)) return null;
    var ean = value["ean"];
    var name = value["name"];
    var imageUrl = value["imageUrl"];
    if (typeof ean !== "string" || typeof name !== "string" || typeof imageUrl !== "string") {
      return null;
    }
    return {
      ean: ean,
      name: name,
      imageUrl: imageUrl,
      price: typeof value["price"] === "number" ? value["price"] as number : null,
      priceUnit: typeof value["priceUnit"] === "string" ? value["priceUnit"] as string : null,
      available: typeof value["available"] === "boolean" ? value["available"] as boolean : null,
      packageQuantity: typeof value["packageQuantity"] === "number"
        ? value["packageQuantity"] as number
        : null,
      packageUnit: typeof value["packageUnit"] === "string"
        ? value["packageUnit"] as string
        : null,
    };
  }

  function readProducts(value: unknown): PickedProduct[] | null {
    if (!Array.isArray(value)) return null;
    var products: PickedProduct[] = [];
    for (var index = 0; index < value.length; index += 1) {
      var product = readProduct(value[index]);
      if (!product) return null;
      products.push(product);
    }
    return products;
  }

  function price(product: PickedProduct): string | null {
    if (typeof product.price !== "number") return null;
    var text = product.price.toFixed(2).split(".").join(",") + " euroa";
    if (typeof product.priceUnit === "string" && product.priceUnit !== "") {
      text += " / " + product.priceUnit.toLowerCase();
    }
    return text;
  }

  // ---------------------------------------------------------------- the sheet

  function buildSheet(): PickerSheet {
    var node = el("div", "s-sheet");
    node.hidden = true;

    var backdrop = el("div", "s-sheet-backdrop");
    backdrop.addEventListener("click", closeSheet);
    node.appendChild(backdrop);

    var panel = el("div", "s-sheet-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "s-sheet-title");

    var head = el("div", "s-sheet-head");
    var titles = el("div", "s-sheet-titles");
    var title = el("h2", "s-sheet-name", "");
    title.id = "s-sheet-title";
    titles.appendChild(title);
    var sub = el("p", "s-sheet-sub", "");
    titles.appendChild(sub);
    head.appendChild(titles);
    var close = el("button", "quiet s-sheet-close", "Sulje");
    close.type = "button";
    close.addEventListener("click", closeSheet);
    head.appendChild(close);
    panel.appendChild(head);

    var form = el("form", "s-product-search");
    var label = el("label", "", "Haku ");
    var input = document.createElement("input");
    input.type = "search";
    input.name = "haku";
    label.appendChild(input);
    form.appendChild(label);
    var go = el("button", "", "Hae");
    go.type = "submit";
    form.appendChild(go);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (!openRow) return;
      var wanted = input.value.trim ? input.value.trim() : input.value;
      if (wanted === "") return;
      openRow.query = wanted;
      runSearch(openRow);
    });
    panel.appendChild(form);

    var scopeSlot = el("div", "s-sheet-scope");
    panel.appendChild(scopeSlot);
    var state = el("p", "s-product-panel-state", "");
    panel.appendChild(state);
    var results = el("div", "s-product-panel-results");
    panel.appendChild(results);

    node.appendChild(panel);
    document.body.appendChild(node);
    sheet = {
      node: node,
      title: title,
      sub: sub,
      input: input,
      scopeSlot: scopeSlot,
      state: state,
      results: results,
    };
    return sheet;
  }

  function subtitle(row: PickerRow): string {
    if (row.mode === "lisaa") return row.total + " · Lisää pakkauskoko";
    var chosen = row.block.querySelector<HTMLElement>(".s-shopping-product-copy strong");
    var mapped = row.block.className.indexOf("is-mapped") !== -1;
    if (mapped && chosen) return row.total + " · Nyt: " + (chosen.textContent || "");
    return row.total + " · Ei valittua tuotetta";
  }

  function returnScope(row: PickerRow): void {
    if (row.scope && row.scopeSource && row.scope.parentNode !== row.scopeSource) {
      row.scopeSource.appendChild(row.scope);
    }
  }

  function openSheet(row: PickerRow, mode: "korvaa" | "lisaa"): void {
    var it = sheet || buildSheet();
    if (openRow && openRow !== row) returnScope(openRow);
    openRow = row;
    row.mode = mode;

    clear(it.title);
    it.title.appendChild(document.createTextNode(row.name));
    clear(it.sub);
    it.sub.appendChild(document.createTextNode(subtitle(row)));
    it.input.value = row.query;

    if (row.scope && mode !== "lisaa") {
      it.scopeSlot.appendChild(row.scope);
      it.scopeSlot.hidden = false;
    } else {
      it.scopeSlot.hidden = true;
    }

    it.node.hidden = false;
    runSearch(row);
    prefetchNext(row);
  }

  function closeSheet(): void {
    if (!sheet || sheet.node.hidden) return;
    if (openRow) returnScope(openRow);
    sheet.node.hidden = true;
    openRow = null;
  }

  function sheetIsOpenFor(row: PickerRow): boolean {
    return sheet !== null && !sheet.node.hidden && openRow === row;
  }

  function say(row: PickerRow, text: string, working: boolean): void {
    if (!sheetIsOpenFor(row) || !sheet) return;
    if (working) busy(sheet.state, text);
    else {
      clear(sheet.state);
      sheet.state.appendChild(document.createTextNode(text));
    }
    sheet.state.hidden = false;
  }

  function runSearch(row: PickerRow): void {
    var query = row.query;
    if (sheetIsOpenFor(row) && sheet) clear(sheet.results);
    say(row, "Haetaan tuotteita…", true);
    search(query, function (ok, payload) {
      if (row.query !== query || !sheetIsOpenFor(row) || !sheet) return;
      var record = isRecord(payload) ? payload : null;
      var results = record ? readProducts(record["results"]) : null;
      if (!ok || !record || !results) {
        say(
          row,
          record && typeof record["error"] === "string"
            ? record["error"] as string
            : "S-ostoslistan tuotehakua ei saatu avattua. Yritä uudelleen.",
          false,
        );
        return;
      }
      if (record["query"] !== query) return;
      if (results.length === 0) {
        say(row, "Haulla ei löytynyt tuotteita.", false);
        return;
      }
      clear(sheet.state);
      sheet.state.hidden = true;
      showResults(row, query, results);
    });
  }

  function showResults(row: PickerRow, query: string, results: PickedProduct[]): void {
    if (!sheetIsOpenFor(row) || !sheet) return;
    clear(sheet.results);
    var list = el("ul", "s-product-results");
    for (var index = 0; index < results.length; index += 1) {
      list.appendChild(resultRow(row, query, results[index]!));
    }
    sheet.results.appendChild(list);
  }

  function sizeFields(item: HTMLElement): SizeFields {
    var wrap = el("span", "s-product-size-entry");
    var amountLabel = el("label", "", "Pakkauskoko ");
    var amount = document.createElement("input");
    amount.type = "text";
    amount.setAttribute("inputmode", "decimal");
    amount.size = 5;
    amountLabel.appendChild(amount);
    wrap.appendChild(amountLabel);

    var unitLabel = el("label", "", "Yksikkö ");
    var unit = document.createElement("select");
    unit.appendChild(new Option("–", ""));
    for (var index = 0; index < SIZE_UNITS.length; index += 1) {
      unit.appendChild(new Option(SIZE_UNITS[index]!, SIZE_UNITS[index]!));
    }
    unitLabel.appendChild(unit);
    wrap.appendChild(unitLabel);

    item.appendChild(wrap);
    return { amount: amount, unit: unit };
  }

  function resultRow(
    row: PickerRow,
    query: string,
    product: PickedProduct,
  ): HTMLLIElement {
    var item = document.createElement("li");
    item.appendChild(productImage(product.imageUrl, PICTURE.result));
    var copy = el("div", "s-product-result-copy");
    copy.appendChild(el("strong", "", product.name));
    copy.appendChild(el("span", "meta", "EAN " + product.ean));
    var priceText = price(product);
    if (priceText) copy.appendChild(el("span", "meta", priceText));
    if (product.available === false) {
      copy.appendChild(el("span", "meta", "Ei saatavilla valitussa kaupassa"));
    }
    var known = typeof product.packageQuantity === "number" && !!product.packageUnit;
    if (known) {
      copy.appendChild(
        el(
          "span",
          "meta s-product-size",
          "Pakkaus " +
            String(product.packageQuantity).split(".").join(",") +
            " " +
            product.packageUnit,
        ),
      );
    }
    item.appendChild(copy);
    var fields = known ? null : sizeFields(item);
    var choose = el("button", "primary", "Valitse");
    choose.type = "button";
    choose.addEventListener("click", function () {
      chooseProduct(row, query, product, fields);
    });
    item.appendChild(choose);
    return item;
  }

  function prefetchNext(row: PickerRow): void {
    for (var index = 0; index < rows.length; index += 1) {
      if (rows[index] !== row) continue;
      var next = rows[index + 1];
      if (next && next.name !== "") search(next.name, null);
      return;
    }
  }

  // ----------------------------------------------- choosing, optimistically

  function chooseProduct(
    row: PickerRow,
    query: string,
    product: PickedProduct,
    fields: SizeFields | null,
  ): void {
    if (row.saving) return;
    var extra: Record<string, string> = {
      tapa: row.mode,
      laajuus: row.scope && row.mode !== "lisaa" ? scopeValue(row) : "aines",
    };
    if (fields) {
      var typed = fields.amount.value;
      if (typed && typed.replace(" ", "") !== "" && fields.unit.value) {
        extra["pakkaus_" + product.ean] = typed;
        extra["pakkausyksikko_" + product.ean] = fields.unit.value;
      }
    }
    closeSheet();

    // A second package size, or a product pinned to one dish, changes what the
    // *rest* of the screen adds up to — and that arithmetic is the server's. So
    // these two say they are saving and then reload onto the row, rather than
    // drawing a guess the server would immediately contradict.
    if (extra["tapa"] === "lisaa" || extra["laajuus"] !== "aines") {
      row.saving = true;
      status(row, "Tallennetaan…");
      send(row, query, product, extra, function (ok, payload) {
        row.saving = false;
        if (ok) {
          settled(true);
          reloadOnto(row);
          return;
        }
        status(row, null);
        var record = isRecord(payload) ? payload : null;
        showError(
          "Tuotteen tallennus epäonnistui.",
          record && typeof record["error"] === "string"
            ? record["error"] as string
            : null,
          function () { chooseProduct(row, query, product, fields); },
        );
        settled(false);
      });
      return;
    }

    var before: BeforeProduct = {
      body: row.body.innerHTML,
      thumb: row.thumb ? row.thumb.innerHTML : null,
      blockClass: row.block.className,
      openLabel: openerLabel(row),
      disabledOpeners: openerAvailability(row),
    };
    showProduct(row, product);
    persist(row, query, product, extra, before);
  }

  function reloadOnto(row: PickerRow): void {
    if (row.aines !== "") {
      window.location.hash = "aines-" + row.aines;
    }
    window.location.reload();
  }

  function scopeValue(row: PickerRow): string {
    var select = row.scope ? row.scope.querySelector<HTMLSelectElement>("select") : null;
    return select ? select.value : "aines";
  }

  function send(
    row: PickerRow,
    query: string,
    product: PickedProduct,
    extra: Record<string, string>,
    done: RequestCallback,
  ): void {
    var body: Record<string, string> = { haku: query, ean: product.ean, muoto: "json" };
    for (var key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) body[key] = extra[key]!;
    }
    request(
      "POST",
      row.saveUrl,
      fieldsOf(row.opener, body, { haku: 1, tapa: 1 }),
      done,
    );
  }

  function openerButton(form: HTMLFormElement): HTMLButtonElement | null {
    return form.querySelector<HTMLButtonElement>("button");
  }

  function openerAvailability(row: PickerRow): boolean[] {
    var off: boolean[] = [];
    for (var index = 0; index < row.openers.length; index += 1) {
      var form = row.openers.item(index);
      var button = form ? openerButton(form) : null;
      off.push(button ? button.disabled : false);
    }
    return off;
  }

  function openerLabel(row: PickerRow): string | null {
    var button = openerButton(row.opener);
    return button ? button.innerHTML : null;
  }

  function setOpenerLabel(row: PickerRow, text: string): void {
    var button = openerButton(row.opener);
    if (!button) return;
    clear(button);
    button.appendChild(document.createTextNode(text));
  }

  function restore(row: PickerRow, before: BeforeProduct): void {
    row.body.innerHTML = before.body;
    if (row.thumb && before.thumb !== null) row.thumb.innerHTML = before.thumb;
    row.block.className = before.blockClass;
    for (var index = 0; index < row.openers.length; index += 1) {
      var form = row.openers.item(index);
      var opener = form ? openerButton(form) : null;
      if (opener) opener.disabled = before.disabledOpeners[index] || false;
    }
    var button = openerButton(row.opener);
    if (button && before.openLabel !== null) button.innerHTML = before.openLabel;
  }

  /** A `<details>` row shuts itself once its product has saved (#204). */
  function closeRow(row: PickerRow): void {
    if (row.container.tagName === "DETAILS") {
      (row.container as HTMLDetailsElement).open = false;
    }
  }

  function persist(
    row: PickerRow,
    query: string,
    product: PickedProduct,
    extra: Record<string, string>,
    before: BeforeProduct,
  ): void {
    row.saving = true;
    clearError();
    status(row, "Tallennetaan…");
    send(row, query, product, extra, function (ok, payload) {
      row.saving = false;
      status(row, null);
      var record = isRecord(payload) ? payload : null;
      var confirmed = record ? readProduct(record["product"]) : null;
      if (ok && confirmed) {
        // The save can say the answer is bigger than this row — a package size
        // added, or a product pinned to one dish. That arithmetic is the
        // server's, so the screen is re-read rather than guessed at.
        if (record && record["reload"] === true) {
          settled(true);
          reloadOnto(row);
          return;
        }
        showProduct(row, confirmed);
        followIngredient(row, confirmed);
        if (before.blockClass.indexOf("is-note") !== -1 && hooks.onNoteBecameProduct) {
          hooks.onNoteBecameProduct();
        }
        closeRow(row);
        settled(true);
        return;
      }
      restore(row, before);
      showError(
        "Tuotteen tallennus epäonnistui.",
        record && typeof record["error"] === "string"
          ? record["error"] as string
          : null,
        function () {
          showProduct(row, product);
          persist(row, query, product, extra, before);
        },
      );
      settled(false);
    });
  }

  /**
   * The same ingredient can be on the screen twice — a dish naming it and one
   * of its parts naming it again — and a choice made on either is a choice
   * about the ingredient, so both rows have to show it. Left alone, the row
   * nobody pressed sat there saying "Ei tuotetta" until a reload, which is the
   * local-and-server-disagree state #159 rules out.
   *
   * A row following one dish's own product is skipped: it is not reading the
   * mapping that just changed, and drawing this product into it would be a lie.
   */
  function followIngredient(row: PickerRow, product: PickedProduct): void {
    if (row.aines === "" || row.ownRecipe) return;
    for (var index = 0; index < rows.length; index += 1) {
      var other = rows[index]!;
      if (other === row || other.saving) continue;
      if (other.ownRecipe || other.aines !== row.aines) continue;
      showProduct(other, product);
    }
  }

  function settled(ok: boolean): void {
    if (hooks.onSaveSettled) hooks.onSaveSettled(ok);
  }

  function savesPending(): boolean {
    for (var index = 0; index < rows.length; index += 1) {
      if (rows[index]!.saving) return true;
    }
    return false;
  }

  function showProduct(row: PickerRow, product: PickedProduct): void {
    row.block.className = row.block.className.indexOf("is-compact") !== -1
      ? "s-shopping-product is-compact is-mapped"
      : "s-shopping-product is-mapped";
    var scope = row.body.querySelector<HTMLElement>(".s-product-scope");

    clear(row.body);
    var summary = el("div", "s-shopping-product-summary");
    if (scope) summary.appendChild(scope);
    var one = el("span", "s-shopping-product-one");
    one.appendChild(productImage(product.imageUrl, PICTURE.summary));
    var copy = el("span", "s-shopping-product-copy");
    copy.appendChild(el("strong", "", product.name));
    copy.appendChild(el("span", "meta", "EAN " + product.ean));
    one.appendChild(copy);
    summary.appendChild(one);
    row.body.appendChild(summary);

    if (row.thumb) {
      clear(row.thumb);
      row.thumb.appendChild(productImage(product.imageUrl, PICTURE.row));
    }

    setOpenerLabel(row, row.opener.getAttribute("data-vaihda") || "Vaihda tuote");
    for (var which = 0; which < row.openers.length; which += 1) {
      var form = row.openers.item(which);
      var opener = form ? openerButton(form) : null;
      if (opener) opener.disabled = false;
    }
  }

  function status(row: PickerRow, text: string | null): void {
    if (!row.status) return;
    if (text === null) {
      clear(row.status);
      return;
    }
    busy(row.status, text);
  }

  // --------------------------------------------------------------- refusals

  function toastNode(): HTMLDivElement {
    if (toast) return toast;
    toast = el("div", "s-toast");
    toast.setAttribute("role", "alert");
    toast.hidden = true;
    document.body.appendChild(toast);
    return toast;
  }

  function clearError(): void {
    if (toast) toast.hidden = true;
  }

  /**
   * A refusal is a fixed strip above the tab bar with the retry in it (#200),
   * rather than a paragraph pushed into the list at the moment somebody is
   * being told something went wrong.
   */
  function showError(
    fallback: string,
    said: string | null,
    retry: () => void,
  ): void {
    var node = toastNode();
    clear(node);
    node.appendChild(el("span", "s-toast-text", said || fallback));
    var again = el("button", "", "Yritä uudelleen");
    again.type = "button";
    again.addEventListener("click", function () {
      node.hidden = true;
      retry();
    });
    node.appendChild(again);
    var away = el("button", "quiet", "Sulje");
    away.type = "button";
    away.addEventListener("click", function () { node.hidden = true; });
    node.appendChild(away);
    node.hidden = false;
  }

  // ----------------------------------------------------------------- wiring

  collect();
  for (var index = 0; index < rows.length; index += 1) {
    (function (row: PickerRow) {
      for (var which = 0; which < row.openers.length; which += 1) {
        var form = row.openers.item(which);
        if (!form) continue;
        (function (opener: HTMLFormElement) {
          opener.addEventListener("submit", function (event) {
            event.preventDefault();
            var rawMode = opener.getAttribute("data-tapa") || "korvaa";
            var mode: "korvaa" | "lisaa" = rawMode === "lisaa" ? "lisaa" : "korvaa";
            if (sheetIsOpenFor(row) && row.mode === mode) {
              closeSheet();
              return;
            }
            openSheet(row, mode);
          });
        })(form);
      }
    })(rows[index]!);
  }
  document.addEventListener("keydown", function (event) {
    var escape = event.key === "Escape" || event.key === "Esc" || event.keyCode === 27;
    if (escape) closeSheet();
  });

  return { rows: rows, savesPending: savesPending };
}
