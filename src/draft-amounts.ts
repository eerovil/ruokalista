/**
 * Making a model's amounts savable before anybody is shown them (#233).
 *
 * A draft is the app's own output, so a member should never be handed one the
 * save then refuses. `recipe-save.ts::validateRecipe` insists every amount is
 * greater than zero, and it is right to: an ingredient line that says "0 kg
 * pippuria" is not a recipe. But nothing used to stand between the model's JSON
 * and the review screen, so a zero — or an amount so small the editor's own
 * rounding wrote it into the box as one — was drawn as an ordinary accepted
 * line and only refused several screens later, on a value the member never
 * typed.
 *
 * So the draft parser repairs the line instead, in the two ways a kitchen would:
 *
 *   - **a real but tiny amount gets a smaller unit.** `0,0005 kg` is half a
 *     gram, and the recipe means it; written in grams it is an ordinary number
 *     again. Only an amount too small to read is converted, so `0,5 kg` stays
 *     `0,5 kg` and the rule about keeping the source's unit still holds
 *     everywhere it matters.
 *   - **a zero, a negative, or an amount too small for even the smallest unit,
 *     is dropped.** The line keeps its ingredient and says no amount, which is
 *     a shape both the screen and the save already handle — about a fifth of
 *     imported lines have no amount at all — and it earns a note, so what was
 *     dropped is visible rather than silent.
 *
 * Nothing here invents a quantity, and no conversion changes what the line
 * measures: a factor is applied to the number and the matching unit name.
 */

export interface DraftAmounts {
  quantity: number | null;
  quantityMax: number | null;
  unit: string | null;
  altQuantity: number | null;
  altUnit: string | null;
  note: string | null;
}

/**
 * Below this an amount is not worth reading. `formatQuantity` rounds to two
 * decimals, so `0,004 dl` is already drawn as `0` on the recipe view, and
 * `formatDecimal` keeps three, so a smaller one still comes back out of the
 * editor's box as `0` and is refused on a value nobody typed. An amount under
 * this is offered a smaller unit, and dropped only when no unit rescues it.
 */
const LEGIBLE = 0.01;

/** The next smaller unit a Finnish recipe writes, and what to multiply by. */
const SMALLER: ReadonlyMap<string, readonly [string, number]> = new Map([
  ["kg", ["g", 1000]],
  ["l", ["dl", 10]],
  ["dl", ["ml", 100]],
  ["cl", ["ml", 10]],
]);

/** Said on a line whose amount the model made unusable and we had to drop. */
export const DROPPED_NOTE = "Määrä ei kelvannut, joten se jätettiin auki.";

/**
 * The line's amounts, made savable. The primary measurement and the second one
 * are repaired independently, because they are in different units — but a
 * second measurement never outlives the first, so dropping the primary amount
 * drops it too.
 */
export function usableAmounts<T extends DraftAmounts>(line: T): T {
  const primary = usableMeasure(line.quantity, line.quantityMax, line.unit);
  const alternate = primary.dropped
    ? { quantity: null, unit: null, dropped: line.altQuantity !== null }
    : usableMeasure(line.altQuantity, null, line.altUnit);

  const dropped = primary.dropped || alternate.dropped;

  return {
    ...line,
    quantity: primary.quantity,
    quantityMax: primary.quantityMax,
    unit: primary.unit,
    // A second measurement is both halves or neither, and never stands alone.
    altQuantity: alternate.unit === null ? null : alternate.quantity,
    altUnit: alternate.quantity === null ? null : alternate.unit,
    note: dropped ? (line.note ?? DROPPED_NOTE) : line.note,
  };
}

interface Measure {
  quantity: number | null;
  quantityMax: number | null;
  unit: string | null;
  /** True when an amount the model did state had to be thrown away. */
  dropped: boolean;
}

function usableMeasure(
  quantity: number | null,
  quantityMax: number | null,
  unit: string | null,
): Measure {
  // A range's upper end is only ever read next to its lower end, so a bad one
  // costs the range rather than the line.
  const max = usable(quantityMax) ? quantityMax : null;

  // An upper end with nothing under it is refused by the save as surely as a
  // zero is, and it reads as nothing at all on the screen, so it goes the same
  // way — the line keeps its ingredient and states no amount.
  if (quantity === null) {
    return {
      quantity: null,
      quantityMax: null,
      unit,
      dropped: quantityMax !== null,
    };
  }
  if (!usable(quantity)) {
    return { quantity: null, quantityMax: null, unit: null, dropped: true };
  }

  // One factor for the whole chain, applied once at the end: rounding at each
  // hop is what would turn a tenth of a millilitre into nothing on the way
  // down. The smallest amount on the line decides, because shrinking the unit
  // for a range has to keep both ends the same measurement.
  let smallerUnit = unit;
  let factor = 1;

  for (let step = 0; step < SMALLER.size; step++) {
    if (Math.min(quantity, max ?? quantity) * factor >= LEGIBLE) break;

    const next = SMALLER.get((smallerUnit ?? "").trim().toLowerCase());
    if (next === undefined) break;

    smallerUnit = next[0];
    factor *= next[1];
  }

  const scaled = {
    quantity: round(quantity * factor),
    quantityMax: max === null ? null : round(max * factor),
    unit: smallerUnit,
  };

  if (scaled.quantity < LEGIBLE) {
    return { quantity: null, quantityMax: null, unit: null, dropped: true };
  }

  return {
    quantity: scaled.quantity,
    quantityMax:
      scaled.quantityMax !== null && scaled.quantityMax >= LEGIBLE
        ? scaled.quantityMax
        : null,
    unit: scaled.unit,
    dropped: false,
  };
}

function usable(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

/** Multiplying by 1000 leaves float dust; three decimals is what a box holds. */
function round(value: number): number {
  return Number(value.toFixed(3));
}
