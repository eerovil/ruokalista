/**
 * Turning stored amounts back into something a Finnish kitchen reads.
 *
 * Nothing here converts between units and nothing invents a number. The rules
 * are docs/spec.md's, under Screens:
 *
 *   - a range reads as one figure, "1–1½ l"
 *   - a second measurement is shown in full, in the order the source wrote it,
 *     "½ kpl (500 g)" — neither of the two is the primary one
 *   - a line with no stated amount shows no amount at all
 */

/** Halves, thirds and quarters, which is what recipes actually write. */
const FRACTIONS: ReadonlyArray<readonly [number, string]> = [
  [1 / 2, "½"],
  [1 / 3, "⅓"],
  [2 / 3, "⅔"],
  [1 / 4, "¼"],
  [3 / 4, "¾"],
];

const TOLERANCE = 0.001;

export interface Measurement {
  quantity: number | null;
  quantityMax: number | null;
  unit: string | null;
  altQuantity: number | null;
  altUnit: string | null;
}

export function formatQuantity(value: number): string {
  const whole = Math.trunc(value);
  const remainder = Math.abs(value - whole);

  for (const [amount, glyph] of FRACTIONS) {
    if (Math.abs(remainder - amount) < TOLERANCE) {
      return whole === 0 ? glyph : `${whole}${glyph}`;
    }
  }

  // Finnish writes the decimal separator as a comma.
  return String(Number(value.toFixed(2))).replace(".", ",");
}

/**
 * The amount as one string — "½ dl", "1–1½ l", "½ kpl (500 g)" — or empty when
 * the source stated no amount, as about a fifth of lines do.
 */
export function formatMeasurement(line: Measurement): string {
  if (line.quantity === null) return "";

  let amount = formatQuantity(line.quantity);

  if (line.quantityMax !== null) {
    // An en dash, as the sources write it.
    amount += `–${formatQuantity(line.quantityMax)}`;
  }

  if (line.unit !== null) amount += ` ${line.unit}`;

  if (line.altQuantity !== null && line.altUnit !== null) {
    amount += ` (${formatQuantity(line.altQuantity)} ${line.altUnit})`;
  }

  return amount;
}
