/**
 * Choosing a shop product from a recipe's ingredient row (#302).
 *
 * There is deliberately almost nothing here. The panel, the search, the result
 * list, the optimistic selection and the spinner are `product-picker.ts` — the
 * same component the shopping list drives — and a recipe adds none of the two
 * things the shopping list does (a send to wait for, a counts line to keep).
 * So this entry exists only to start it on a screen that has picker rows, and
 * to remember the one thing the recipe screen has of its own: the tick.
 *
 * The server draws nothing for a household without the S-ostoslista
 * integration, so on every other household's recipe screen this script is not
 * embedded at all — and were it ever embedded by mistake, it would find no
 * settings element and stop.
 */

import { startProductPicker } from "./product-picker.ts";

/** Where this browser remembers the tick. */
var PICKS_KEY = "ruokalista.tuotevalinnat";

startProductPicker();
rememberProductPicks();

/**
 * Keep `Näytä tuotevalinnat` ticked between recipes (#305).
 *
 * Hiding and showing the buttons is the stylesheet's job, and the checkbox
 * works without any of this — what a browser adds is only that somebody doing
 * a round of product mapping does not re-tick it on every dish. It is kept in
 * `localStorage` rather than on the household, because it is one person's view
 * of the screen and not a decision about the kitchen.
 *
 * Every read and write is wrapped: a browser with storage turned off throws on
 * the property itself, and a recipe screen is not worth breaking over a tick it
 * cannot remember.
 */
function rememberProductPicks(): void {
  var toggle = document.getElementById("show-product-picks");
  if (toggle === null || toggle.tagName !== "INPUT") return;
  var tick = toggle as HTMLInputElement;

  if (read() === "1") tick.checked = true;
  tick.addEventListener("change", function () {
    write(tick.checked ? "1" : "0");
  });
}

function read(): string | null {
  try {
    return window.localStorage.getItem(PICKS_KEY);
  } catch (_error) {
    return null;
  }
}

function write(value: string): void {
  try {
    window.localStorage.setItem(PICKS_KEY, value);
  } catch (_error) {
    // A private window with storage denied. The tick still works; it is only
    // this page's tick then.
  }
}
