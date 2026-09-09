/**
 * Optional browser enhancement for the server-rendered shopping list.
 *
 * Every underlying form remains usable without this file. This client only
 * makes product choice, sending, retry state and the current S-list immediate.
 * Server-owned picture sizes arrive as a data attribute on
 * `.s-shopping-send`, so the browser and server draw the same slots.
 */

interface ProductPictureSlot {
  size: number;
  width: number;
}

interface ProductPictures {
  row: ProductPictureSlot;
  summary: ProductPictureSlot;
  result: ProductPictureSlot;
}

interface ShoppingProduct {
  ean: string;
  name: string;
  imageUrl: string;
  price: number | null;
  priceUnit: string | null;
  available: boolean | null;
  packageQuantity: number | null;
  packageUnit: string | null;
}

interface ShoppingRow {
  details: HTMLDetailsElement;
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
}

interface SearchEntry {
  done: boolean;
  ok: boolean;
  payload: unknown;
  waiting: RequestCallback[];
}

interface ShoppingSheet {
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

interface PendingSend {
  failed: boolean;
  done: (ready: boolean) => void;
}

interface CurrentListItem {
  name: string;
  ean: string | null;
}

type RequestCallback = (ok: boolean, payload: unknown) => void;

type FormField = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement;

(function () {
  if (
    !window.XMLHttpRequest || !window.JSON ||
    typeof document.querySelectorAll !== "function" ||
    typeof document.addEventListener !== "function"
  ) return;

  var settings = document.querySelector<HTMLElement>(".s-shopping-send[data-product-picture]");
  if (!settings) return;
  var picture = readPictureConfig(settings.getAttribute("data-product-picture"));
  if (!picture) return;

  var PICTURE = picture;
  var IMAGE_BASE = "https://cdn.s-cloud.fi/v1/";
  var rows: ShoppingRow[] = [];
  var sending = false;
  var sendAfterSaves: PendingSend | null = null;

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

  function pictureSlot(value: unknown): ProductPictureSlot | null {
    if (!isRecord(value)) return null;
    var size = value["size"];
    var width = value["width"];
    return positiveInteger(size) && positiveInteger(width)
      ? { size: size, width: width }
      : null;
  }

  function positiveInteger(value: unknown): value is number {
    return typeof value === "number" && isFinite(value) && value > 0 && value % 1 === 0;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (typeof text === "string") node.appendChild(document.createTextNode(text));
    return node;
  }

  function clear(node: Node): void {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function spinner(): HTMLSpanElement {
    var node = el("span", "spinner");
    node.setAttribute("aria-hidden", "true");
    return node;
  }

  function busy(node: HTMLElement, text: string): void {
    clear(node);
    node.appendChild(spinner());
    node.appendChild(document.createTextNode(text));
  }

  function request(
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

  function fieldsOf(
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

  // ------------------------------------------------ searches, kept by term

  var searches: Record<string, SearchEntry | null | undefined> = {};

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

  // ------------------------------------------------------------- the rows

  function collect(): void {
    var items = document.querySelectorAll<HTMLDetailsElement>(".shopping-item[data-rivi]");
    for (var index = 0; index < items.length; index += 1) {
      var details = items.item(index);
      if (!details) continue;
      var block = details.querySelector<HTMLElement>(".s-shopping-product");
      var openers = block
        ? block.querySelectorAll<HTMLFormElement>("form.s-product-open")
        : null;
      if (!block || !openers || openers.length === 0) continue;
      var body = block.querySelector<HTMLElement>(".s-shopping-product-body");
      var opener = openers.item(0);
      if (!body || !opener) continue;
      var total = details.querySelector<HTMLElement>(".shopping-total");
      var scopeSource = block.querySelector<HTMLElement>(".s-scope-source");
      var row: ShoppingRow = {
        details: details,
        block: block,
        body: body,
        thumb: details.querySelector<HTMLElement>(".shopping-thumb"),
        openers: openers,
        opener: opener,
        scopeSource: scopeSource,
        scope: scopeSource
          ? scopeSource.querySelector<HTMLElement>(".s-product-scope-choice")
          : null,
        mode: "korvaa",
        name: details.getAttribute("data-haku") || "",
        aines: details.getAttribute("data-aines") || "",
        total: total ? total.textContent || "" : "",
        query: details.getAttribute("data-haku") || "",
        status: block.querySelector<HTMLElement>(".s-status"),
        saving: false,
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

  function readProduct(value: unknown): ShoppingProduct | null {
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

  function readProducts(value: unknown): ShoppingProduct[] | null {
    if (!Array.isArray(value)) return null;
    var products: ShoppingProduct[] = [];
    for (var index = 0; index < value.length; index += 1) {
      var product = readProduct(value[index]);
      if (!product) return null;
      products.push(product);
    }
    return products;
  }

  function price(product: ShoppingProduct): string | null {
    if (typeof product.price !== "number") return null;
    var text = product.price.toFixed(2).split(".").join(",") + " euroa";
    if (typeof product.priceUnit === "string" && product.priceUnit !== "") {
      text += " / " + product.priceUnit.toLowerCase();
    }
    return text;
  }

  // ------------------------------------------------------------- the sheet

  var sheet: ShoppingSheet | null = null;
  var openRow: ShoppingRow | null = null;

  function buildSheet(): ShoppingSheet {
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

  function subtitle(row: ShoppingRow): string {
    if (row.mode === "lisaa") return row.total + " · Lisää pakkauskoko";
    var chosen = row.block.querySelector<HTMLElement>(".s-shopping-product-copy strong");
    var mapped = row.block.className.indexOf("is-mapped") !== -1;
    if (mapped && chosen) return row.total + " · Nyt: " + (chosen.textContent || "");
    return row.total + " · Ei valittua tuotetta";
  }

  function returnScope(row: ShoppingRow): void {
    if (row.scope && row.scopeSource && row.scope.parentNode !== row.scopeSource) {
      row.scopeSource.appendChild(row.scope);
    }
  }

  function openSheet(row: ShoppingRow, mode: "korvaa" | "lisaa"): void {
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

  function sheetIsOpenFor(row: ShoppingRow): boolean {
    return sheet !== null && !sheet.node.hidden && openRow === row;
  }

  function say(row: ShoppingRow, text: string, working: boolean): void {
    if (!sheetIsOpenFor(row) || !sheet) return;
    if (working) busy(sheet.state, text);
    else {
      clear(sheet.state);
      sheet.state.appendChild(document.createTextNode(text));
    }
    sheet.state.hidden = false;
  }

  function runSearch(row: ShoppingRow): void {
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

  function showResults(row: ShoppingRow, query: string, results: ShoppingProduct[]): void {
    if (!sheetIsOpenFor(row) || !sheet) return;
    clear(sheet.results);
    var list = el("ul", "s-product-results");
    for (var index = 0; index < results.length; index += 1) {
      list.appendChild(resultRow(row, query, results[index]!));
    }
    sheet.results.appendChild(list);
  }

  var SIZE_UNITS = ["g", "kg", "ml", "dl", "l", "kpl"];

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
    row: ShoppingRow,
    query: string,
    product: ShoppingProduct,
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

  function prefetchNext(row: ShoppingRow): void {
    for (var index = 0; index < rows.length; index += 1) {
      if (rows[index] !== row) continue;
      var next = rows[index + 1];
      if (next && next.name !== "") search(next.name, null);
      return;
    }
  }

  // ------------------------------------------------- choosing, optimistically

  function chooseProduct(
    row: ShoppingRow,
    query: string,
    product: ShoppingProduct,
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

    if (extra["tapa"] === "lisaa" || extra["laajuus"] !== "aines") {
      row.saving = true;
      status(row, "Tallennetaan…");
      send(row, query, product, extra, function (ok, payload) {
        row.saving = false;
        if (ok) {
          reloadOnto(row);
          return;
        }
        status(row, null);
        var record = isRecord(payload) ? payload : null;
        showError(
          row,
          record && typeof record["error"] === "string"
            ? record["error"] as string
            : "Tuotteen tallennus epäonnistui.",
          function () { chooseProduct(row, query, product, fields); },
        );
        saveSettled(false);
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

  function reloadOnto(row: ShoppingRow): void {
    if (row.aines !== "") {
      window.location.hash = "aines-" + row.aines;
    }
    window.location.reload();
  }

  function scopeValue(row: ShoppingRow): string {
    var select = row.scope ? row.scope.querySelector<HTMLSelectElement>("select") : null;
    return select ? select.value : "aines";
  }

  function send(
    row: ShoppingRow,
    query: string,
    product: ShoppingProduct,
    extra: Record<string, string>,
    done: RequestCallback,
  ): void {
    var body: Record<string, string> = { haku: query, ean: product.ean, muoto: "json" };
    for (var key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) body[key] = extra[key]!;
    }
    request(
      "POST",
      "/ostoslista/tuote",
      fieldsOf(row.opener, body, { haku: 1, tapa: 1 }),
      done,
    );
  }

  function openerButton(form: HTMLFormElement): HTMLButtonElement | null {
    return form.querySelector<HTMLButtonElement>("button");
  }

  function openerAvailability(row: ShoppingRow): boolean[] {
    var off: boolean[] = [];
    for (var index = 0; index < row.openers.length; index += 1) {
      var form = row.openers.item(index);
      var button = form ? openerButton(form) : null;
      off.push(button ? button.disabled : false);
    }
    return off;
  }

  function openerLabel(row: ShoppingRow): string | null {
    var button = openerButton(row.opener);
    return button ? button.innerHTML : null;
  }

  function setOpenerLabel(row: ShoppingRow, text: string): void {
    var button = openerButton(row.opener);
    if (!button) return;
    clear(button);
    button.appendChild(document.createTextNode(text));
  }

  function restore(row: ShoppingRow, before: BeforeProduct): void {
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

  function persist(
    row: ShoppingRow,
    query: string,
    product: ShoppingProduct,
    extra: Record<string, string>,
    before: BeforeProduct,
  ): void {
    row.saving = true;
    clearError(row);
    status(row, "Tallennetaan…");
    send(row, query, product, extra, function (ok, payload) {
      row.saving = false;
      status(row, null);
      var record = isRecord(payload) ? payload : null;
      var confirmed = record ? readProduct(record["product"]) : null;
      if (ok && confirmed) {
        showProduct(row, confirmed);
        if (before.blockClass.indexOf("is-note") !== -1) countProduct();
        row.details.open = false;
        saveSettled(true);
        return;
      }
      restore(row, before);
      showError(
        row,
        record && typeof record["error"] === "string"
          ? record["error"] as string
          : "Tuotteen tallennus epäonnistui.",
        function () {
          showProduct(row, product);
          persist(row, query, product, extra, before);
        },
      );
      saveSettled(false);
    });
  }

  function saveSettled(ok: boolean): void {
    if (!sendAfterSaves) return;
    if (!ok) sendAfterSaves.failed = true;
    if (savesPending()) return;
    var after = sendAfterSaves;
    sendAfterSaves = null;
    after.done(!after.failed);
  }

  function savesPending(): boolean {
    for (var index = 0; index < rows.length; index += 1) {
      if (rows[index]!.saving) return true;
    }
    return false;
  }

  function showProduct(row: ShoppingRow, product: ShoppingProduct): void {
    row.block.className = "s-shopping-product is-mapped";
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

    setOpenerLabel(row, "Vaihda tuote");
    for (var which = 0; which < row.openers.length; which += 1) {
      var form = row.openers.item(which);
      var opener = form ? openerButton(form) : null;
      if (opener) opener.disabled = false;
    }
  }

  function status(row: ShoppingRow, text: string | null): void {
    if (!row.status) return;
    if (text === null) {
      clear(row.status);
      return;
    }
    busy(row.status, text);
  }

  // --------------------------------------------------------------- refusals

  var toast: HTMLDivElement | null = null;

  function toastNode(): HTMLDivElement {
    if (toast) return toast;
    toast = el("div", "s-toast");
    toast.setAttribute("role", "alert");
    toast.hidden = true;
    document.body.appendChild(toast);
    return toast;
  }

  function clearError(_row: ShoppingRow): void {
    if (toast) toast.hidden = true;
  }

  function showError(row: ShoppingRow, message: string, retry: () => void): void {
    var node = toastNode();
    clear(node);
    node.appendChild(el("span", "s-toast-text", message));
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
    // row is deliberately carried with the retry closure: the refusal belongs
    // to the exact row whose optimistic drawing was rolled back.
    void row;
  }

  function countProduct(): void {
    var line = document.querySelector<HTMLElement>(".s-send-counts");
    if (!line) return;
    var products = Number(line.getAttribute("data-tuotteet")) + 1;
    var notes = Number(line.getAttribute("data-muistutukset")) - 1;
    if (notes < 0) return;
    line.setAttribute("data-tuotteet", String(products));
    line.setAttribute("data-muistutukset", String(notes));
    var text = products + (products === 1 ? " tuote" : " tuotetta");
    if (notes > 0) {
      text += " · " + notes + (notes === 1 ? " teksti" : " tekstiä");
    }
    clear(line);
    line.appendChild(document.createTextNode(text));
  }

  // ------------------------------------------------------------- the sending

  function wireSend(): void {
    var foundForm = document.querySelector<HTMLFormElement>(".s-shopping-send form.s-send-form");
    if (!foundForm) return;
    var form: HTMLFormElement = foundForm;
    var foundButton = form.querySelector<HTMLButtonElement>("button");
    if (!foundButton) return;
    var button: HTMLButtonElement = foundButton;

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (sending) return;
      sending = true;
      var label = button.innerHTML;
      button.disabled = true;
      note(null, null);

      function releaseSend(): void {
        sending = false;
        button.disabled = false;
        button.innerHTML = label;
      }

      function sendNow(): void {
        busy(button, "Lähetetään…");
        request(
          "POST",
          "/ostoslista/laheta",
          fieldsOf(form, { muoto: "json" }, null),
          function (ok, payload) {
            releaseSend();
            var record = isRecord(payload) ? payload : null;
            if (ok && record && typeof record["sent"] === "number") {
              note(
                "shopping-sent",
                String(record["sent"]) + " ainesta lähetettiin S-ostoslistaan.",
              );
              if (record["synced"] === false) {
                note(
                  "refused",
                  typeof record["warning"] === "string"
                    ? record["warning"] as string
                    : "Puhelimen S-ostoslistan päivitystä ei saatu käynnistettyä.",
                );
              }
              loadCurrent();
              return;
            }
            note(
              "refused",
              record && typeof record["error"] === "string"
                ? record["error"] as string
                : "S-ostoslistaan ei saatu lähetettyä kaikkea.",
            );
          },
        );
      }

      if (savesPending()) {
        busy(button, "Tallennetaan valintoja…");
        sendAfterSaves = {
          failed: false,
          done: function (ready) {
            if (ready) {
              sendNow();
              return;
            }
            releaseSend();
            note(
              "refused",
              "Lähetystä ei aloitettu, koska tuotteen tallennus epäonnistui. Korjaa valinta ja yritä uudelleen.",
            );
          },
        };
        return;
      }

      sendNow();
    });
  }

  var sendNotes: HTMLElement[] = [];

  function note(className: string | null, text: string | null): void {
    if (className === null) {
      for (var index = 0; index < sendNotes.length; index += 1) {
        var old = sendNotes[index]!;
        if (old.parentNode) old.parentNode.removeChild(old);
      }
      sendNotes = [];
      return;
    }
    var panel = document.querySelector<HTMLElement>(".s-shopping-send");
    if (!panel) return;
    var line = el("p", className, text || "");
    panel.appendChild(line);
    sendNotes.push(line);
  }

  // --------------------------------------------- what the S list already has

  var NOTHING_LEFT = "S-ostoslistalla ei ole keräämättömiä rivejä.";
  var removing = false;
  var drawing = 0;

  function readCurrentItems(payload: unknown): CurrentListItem[] | null {
    if (!isRecord(payload) || !Array.isArray(payload["items"])) return null;
    var raw = payload["items"] as unknown[];
    var items: CurrentListItem[] = [];
    for (var index = 0; index < raw.length; index += 1) {
      var one = raw[index];
      if (!isRecord(one) || typeof one["name"] !== "string") return null;
      var ean = one["ean"];
      if (ean !== null && typeof ean !== "string") return null;
      items.push({ name: one["name"] as string, ean: ean as string | null });
    }
    return items;
  }

  function loadCurrent(): void {
    var panel = document.querySelector<HTMLElement>(".s-current");
    if (!panel) return;
    var foundState = panel.querySelector<HTMLElement>(".s-current-state");
    var foundList = panel.querySelector<HTMLUListElement>(".s-current-items");
    if (!foundState || !foundList) return;
    var state: HTMLElement = foundState;
    var list: HTMLUListElement = foundList;
    panel.hidden = false;
    clear(list);
    state.hidden = false;
    drawing += 1;
    busy(state, "Luetaan S-ostoslistaa…");

    request("GET", "/ostoslista/s-lista", null, function (ok, payload) {
      clear(state);
      var items = readCurrentItems(payload);
      if (!ok || !items) {
        var record = isRecord(payload) ? payload : null;
        state.appendChild(
          document.createTextNode(
            (record && typeof record["error"] === "string"
              ? record["error"] as string
              : "S-ostoslistan sisältöä ei saatu luettua.") + " ",
          ),
        );
        var again = el("button", "", "Yritä uudelleen");
        again.type = "button";
        again.addEventListener("click", loadCurrent);
        state.appendChild(again);
        return;
      }
      if (items.length === 0) {
        state.appendChild(document.createTextNode(NOTHING_LEFT));
        return;
      }
      state.hidden = true;
      for (var index = 0; index < items.length; index += 1) {
        list.appendChild(currentRow(items[index]!, list, state));
      }
    });
  }

  function currentRow(
    item: CurrentListItem,
    list: HTMLUListElement,
    state: HTMLElement,
  ): HTMLLIElement {
    var entry = document.createElement("li");
    entry.className = item.ean ? "s-current-product" : "s-current-note";
    entry.appendChild(el("span", "s-current-name", item.name));
    entry.appendChild(el("span", "meta", item.ean ? "Tuote" : "Teksti"));

    var drop = el("button", "s-current-remove", "✕");
    drop.type = "button";
    drop.setAttribute("aria-label", "Poista S-ostoslistalta: " + item.name);
    entry.appendChild(drop);
    drop.addEventListener("click", function () {
      removeCurrent(item, entry, list, state);
    });
    return entry;
  }

  function removeCurrent(
    item: CurrentListItem,
    entry: HTMLLIElement,
    list: HTMLUListElement,
    state: HTMLElement,
  ): void {
    if (removing || !entry.parentNode) return;
    removing = true;
    var drawn = drawing;
    var after = entry.nextSibling;
    list.removeChild(entry);
    clear(state);
    state.hidden = list.firstChild !== null;
    if (!state.hidden) state.appendChild(document.createTextNode(NOTHING_LEFT));

    var body = item.ean
      ? "ean=" + encodeURIComponent(item.ean)
      : "teksti=" + encodeURIComponent(item.name);
    request("POST", "/ostoslista/s-lista/poista", body, function (ok, payload) {
      removing = false;
      if (ok) return;
      if (drawn !== drawing) return;
      list.insertBefore(entry, after && after.parentNode === list ? after : null);
      clear(state);
      state.hidden = false;
      var record = isRecord(payload) ? payload : null;
      state.appendChild(
        document.createTextNode(
          (record && typeof record["error"] === "string"
            ? record["error"] as string
            : "Rivin poisto S-ostoslistalta ei onnistunut. Yritä uudelleen.") + " ",
        ),
      );
      var again = el("button", "", "Yritä uudelleen");
      again.type = "button";
      again.addEventListener("click", function () {
        clear(state);
        state.hidden = true;
        removeCurrent(item, entry, list, state);
      });
      state.appendChild(again);
    });
  }

  // ------------------------------------------------------------------ wiring

  collect();
  for (var index = 0; index < rows.length; index += 1) {
    (function (row: ShoppingRow) {
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
  wireSend();
  loadCurrent();
})();
