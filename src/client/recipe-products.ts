/**
 * Choosing a shop product from a recipe's ingredient row (#302).
 *
 * There is deliberately almost nothing here. The panel, the search, the result
 * list, the optimistic selection and the spinner are `product-picker.ts` — the
 * same component the shopping list drives — and a recipe adds none of the two
 * things the shopping list does (a send to wait for, a counts line to keep).
 * So this entry exists only to start it on a screen that has picker rows.
 *
 * The server draws nothing for a household without the S-ostoslista
 * integration, so on every other household's recipe screen this script is not
 * embedded at all — and were it ever embedded by mistake, it would find no
 * settings element and stop.
 */

import { startProductPicker } from "./product-picker.ts";

startProductPicker();
