import { formatMeasurement, type Measurement } from "./quantities.ts";

/**
 * Scaling a recipe to the number of portions a day is planned for.
 *
 * Two rules decide everything here:
 *
 *   - **A recipe with no yield cannot be scaled.** It never says what its own
 *     quantities make, so there is nothing to scale *from*. The screen says so
 *     rather than guessing.
 *   - **Amounts round to what a cook can measure.** 5 dl times 1⅓ is 6.666… dl,
 *     which nobody pours. It reads 6½ dl. The arithmetic stops being exact,
 *     which for cooking is the point rather than the cost.
 *
 * A part of a dish has no yield of its own — it is a piece of the dish — so it
 * scales by the dish's factor. See docs/adr/0002-a-part-is-a-recipe.md.
 */

/** Weights round to something a scale shows; everything else to spoons. */
const WEIGHT_UNITS = new Set(["g", "gr", "gramma", "grammaa"]);
const KILO_UNITS = new Set(["kg", "kilo", "kiloa"]);

/**
 * How much to multiply by, or null when the recipe cannot be scaled — no
 * stated yield, a nonsense portion count, or nothing to change.
 */
export function scaleFactor(
  yieldPortions: number | null,
  portions: number | null,
): number | null {
  if (yieldPortions === null || yieldPortions <= 0) return null;
  if (portions === null || !Number.isFinite(portions) || portions <= 0) {
    return null;
  }

  const factor = portions / yieldPortions;
  return factor === 1 ? null : factor;
}

/**
 * Round to an amount a kitchen can actually produce.
 *
 * Small amounts keep quarters, because the difference between ¼ and ½ a
 * teaspoon is real. Larger ones go to halves and then to whole numbers, where
 * that precision is noise. Weights go to the nearest 5 or 10 grams, which is
 * what a scale shows anyway.
 */
export function roundForKitchen(value: number, unit: string | null): number {
  if (!Number.isFinite(value) || value <= 0) return value;

  const name = (unit ?? "").trim().toLocaleLowerCase("fi");

  if (KILO_UNITS.has(name)) return snap(value, 0.1);
  if (WEIGHT_UNITS.has(name)) return snap(value, value >= 100 ? 10 : 5);

  if (value < 3) return snap(value, 0.25);
  if (value < 20) return snap(value, 0.5);
  return snap(value, 1);
}

/**
 * The measurement as it should be cooked at this factor. A line with no stated
 * amount comes back untouched — there is nothing to multiply, and inventing one
 * is the thing this app never does.
 */
export function scaleMeasurement(
  line: Measurement,
  factor: number | null,
): Measurement {
  if (factor === null || line.quantity === null) return line;

  return {
    quantity: roundForKitchen(line.quantity * factor, line.unit),
    // Both ends of a range are real amounts, so both move. The spec's rule that
    // scaling "uses quantity, the low end" is about picking a single number —
    // for reading, dropping the top of the range would lose what the page said.
    quantityMax:
      line.quantityMax === null
        ? null
        : roundForKitchen(line.quantityMax * factor, line.unit),
    unit: line.unit,
    // A second measurement of the same item scales with it, per ADR-0001:
    // neither of the two is the primary one.
    altQuantity:
      line.altQuantity === null
        ? null
        : roundForKitchen(line.altQuantity * factor, line.altUnit),
    altUnit: line.altUnit,
  };
}

/**
 * Whether this line's source wording earns a second line under it.
 *
 * Repeating every source line turns a screen into a comparison view, and while
 * cooking or shopping fast legibility is worth more than maximum evidence. So
 * the source appears in exactly the two cases where the structured line is not
 * the whole truth:
 *
 *   - **No stated amount.** The fields have nowhere to put "hieman", "maun
 *     mukaan" or "tarvittaessa", so the qualifier only exists in the source.
 *     About a fifth of lines are like this.
 *   - **A scaled amount.** The number on the screen is no longer the number on
 *     the page, and the source line is what says so.
 *
 * Everything else — ranges, second measurements, plain amounts — round-trips
 * through the fields intact, so a copy underneath adds nothing to read.
 *
 * It lives here rather than on the recipe screen because it is a question about
 * what scaling changed, and the shopping list has to ask it too.
 */
export function sourceWorthShowing(
  line: Measurement & { ingredient: string; sourceLine: string },
  factor: number | null,
): boolean {
  if (line.quantity === null) {
    // Nothing lost if the source line is just the ingredient again.
    return line.sourceLine.trim() !== "" &&
      line.sourceLine.trim().toLocaleLowerCase("fi") !==
        line.ingredient.trim().toLocaleLowerCase("fi");
  }

  return (
    formatMeasurement(scaleMeasurement(line, factor)) !==
    formatMeasurement(line)
  );
}

function snap(value: number, step: number): number {
  const rounded = Math.round(value / step) * step;
  // Never round an amount away to nothing.
  const result = rounded === 0 ? step : rounded;
  // Steps like 0.1 and 0.25 reintroduce float dust; two decimals is plenty.
  return Number(result.toFixed(2));
}
