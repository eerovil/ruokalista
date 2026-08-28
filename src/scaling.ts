import { formatMeasurement, type Measurement } from "./quantities.ts";

/**
 * Scaling a recipe by a multiplier (#165).
 *
 * Three rules decide everything here:
 *
 *   - **The recipe as written is 1×.** Whatever the source page said it makes
 *     is source metadata, not the thing scaling starts from, so a recipe that
 *     never stated a yield scales exactly like one that did.
 *   - **A cook picks the multiplier.** 0,5×, 1,5×, 2× — or any other positive
 *     number. It comes from the planned batch, never from arithmetic on portion
 *     counts.
 *   - **Amounts round to what a cook can measure.** 5 dl times 1⅓ is 6.666… dl,
 *     which nobody pours. It reads 6½ dl. The arithmetic stops being exact,
 *     which for cooking is the point rather than the cost.
 *
 * A part of a dish is a piece of the dish, so it scales by the dish's
 * multiplier. See docs/adr/0002-a-part-is-a-recipe.md.
 */

/** Weights round to something a scale shows; everything else to spoons. */
const WEIGHT_UNITS = new Set(["g", "gr", "gramma", "grammaa"]);
const KILO_UNITS = new Set(["kg", "kilo", "kiloa"]);

/** The recipe as written. Nothing is scaled until somebody says otherwise. */
export const DEFAULT_MULTIPLIER = 1;

/**
 * The multipliers a screen offers with one tap.
 *
 * A convenience, not the domain: any positive number is a legal multiplier and
 * `parseMultiplier` will take one. These four are only what a picker shows
 * before anybody has to type.
 */
export const MULTIPLIER_CHOICES = [0.5, 1, 1.5, 2] as const;

/**
 * A typed multiplier, or null when it is not one.
 *
 * Takes the Finnish decimal comma the way every other number field in the app
 * does (`line-form.ts::readNumber`), and tolerates the `×` or `x` somebody
 * copies in with it, because the screens print it that way.
 */
export function parseMultiplier(value: string): number | null {
  const text = value
    .trim()
    .replace(/[×xX]\s*$/u, "")
    .trim()
    .replace(",", ".");
  if (text === "") return null;

  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

/** Whether a stored number is one this app would have accepted. */
export function isMultiplier(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * How a multiplier reads on a screen: `1×`, `1,5×`, `0,5×`.
 *
 * Finnish decimal comma, and no trailing zeros — `2×` rather than `2,00×`.
 */
export function formatMultiplier(multiplier: number): string {
  const text = String(multiplier).replace(".", ",");
  return `${text}×`;
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
 * The measurement as it should be cooked at this multiplier.
 *
 * 1× comes back byte for byte what was stored: the recipe as written is what
 * the source said, and pushing it through the kitchen rounding would quietly
 * edit a line nobody asked to change. A line with no stated amount comes back
 * untouched too — there is nothing to multiply, and inventing one is the thing
 * this app never does.
 */
export function scaleMeasurement(
  line: Measurement,
  multiplier: number,
): Measurement {
  const factor = isMultiplier(multiplier) ? multiplier : DEFAULT_MULTIPLIER;
  if (factor === 1 || line.quantity === null) return line;

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
  multiplier: number,
): boolean {
  if (line.quantity === null) {
    // Nothing lost if the source line is just the ingredient again.
    return line.sourceLine.trim() !== "" &&
      line.sourceLine.trim().toLocaleLowerCase("fi") !==
        line.ingredient.trim().toLocaleLowerCase("fi");
  }

  return (
    formatMeasurement(scaleMeasurement(line, multiplier)) !==
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
