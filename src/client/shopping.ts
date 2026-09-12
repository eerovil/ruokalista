/**
 * Optional browser enhancement for the server-rendered shopping list.
 *
 * Every underlying form remains usable without this file. What is left here is
 * what belongs to *this screen* and nowhere else: sending the list, the counts
 * line above it, and the panel saying what the S-ostoslista already holds.
 *
 * Choosing a product is not one of those. That is `product-picker.ts`, the one
 * component this screen and a recipe's ingredient row both drive (#302), so the
 * two cannot behave differently. This file only tells it the two things the
 * shopping list adds: a note that became a product changes the counts, and a
 * send has to wait for any selection still saving.
 */

import {
  busy,
  clear,
  el,
  fieldsOf,
  isRecord,
  request,
  startProductPicker,
  type PickerHandle,
} from "./product-picker.ts";

interface PendingSend {
  failed: boolean;
  done: (ready: boolean) => void;
}

interface CurrentListItem {
  name: string;
  ean: string | null;
}

(function () {
  var picker: PickerHandle | null = startProductPicker({
    onNoteBecameProduct: countProduct,
    onSaveSettled: saveSettled,
  });

  var sending = false;
  var sendAfterSaves: PendingSend | null = null;

  function savesPending(): boolean {
    return picker !== null && picker.savesPending();
  }

  function saveSettled(ok: boolean): void {
    if (!sendAfterSaves) return;
    if (!ok) sendAfterSaves.failed = true;
    if (savesPending()) return;
    var after = sendAfterSaves;
    sendAfterSaves = null;
    after.done(!after.failed);
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

  // The picker refuses on a browser that cannot run any of this, and the rest
  // of the screen has the same floor: without it there is nothing here to draw.
  if (picker === null) return;
  wireSend();
  loadCurrent();
})();
