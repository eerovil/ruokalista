import type { Measurement } from "./quantities.ts";

/**
 * One deterministic fingerprint of the recipe content that decides what a
 * generated picture of the dish shows.
 *
 * It exists so an image can be compared against the recipe it was made from
 * without looking at the image: store the fingerprint next to the picture, hash
 * the recipe again later, and a difference means the dish changed.
 *
 * What is in it, and why only this:
 *
 *   - the title, because it names the dish
 *   - every ingredient line's amount, range, unit, second measurement and
 *     ingredient name — the food on the plate
 *   - the parts of a multipart dish, each grouped under its own name, because
 *     which ingredients belong to which part is part of what is cooked
 *
 * What is deliberately out: row ids, positions, the source text, the steps,
 * the stated yield, who wrote it and when, the image key itself, and anything
 * about menus. A picture does not change because somebody fixed a typo in step
 * three, and a recipe that is queued for a paid regeneration every time an
 * unrelated field moves is worse than no freshness check at all.
 *
 * Preparation text is the one judgement call. It is out: the card's requirement
 * is ingredient staleness, and step wording moves far more often than the dish
 * looks different. If a concrete visual reason ever turns up, it goes in behind
 * a new VERSION.
 *
 * Order cannot move the fingerprint. Lines are sorted by their own canonical
 * text and parts by their name, so reordering rows — which the editor does
 * whenever anything is inserted — is not a change to the dish. That is also
 * what makes the fingerprint independent of ids: nothing in it is an id.
 */

/** A line, as this module needs to see it. `RecipeLine` satisfies this. */
export interface FingerprintLine extends Measurement {
  ingredient: string;
}

/** A part of a dish: a name and its own lines. `Recipe` satisfies this. */
export interface FingerprintPart {
  title: string;
  lines: readonly FingerprintLine[];
}

/** A dish. `Recipe` from `recipes.ts` satisfies this structurally. */
export interface FingerprintRecipe extends FingerprintPart {
  parts: readonly FingerprintPart[];
}

/**
 * Bumped only when the canonical form changes shape. Every stored fingerprint
 * carries it, so an old one compares unequal on purpose: the rule that made it
 * is gone, and the honest answer is that we no longer know it matches.
 */
const VERSION = "v1";

/** SHA-256 of the canonical text, lower-case hex. */
export async function recipeFingerprint(
  recipe: FingerprintRecipe,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalRecipe(recipe));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The exact text that gets hashed. Exported because a failing fingerprint
 * comparison is unreadable — two hex strings say nothing about what moved —
 * and because it is what the unit checks assert on.
 */
export function canonicalRecipe(recipe: FingerprintRecipe): string {
  const rows = [VERSION, `dish ${name(recipe.title)}`, ...canonicalLines(recipe.lines)];

  const parts = [...recipe.parts].sort((a, b) =>
    compare(name(a.title), name(b.title)),
  );
  for (const part of parts) {
    rows.push(`part ${name(part.title)}`, ...canonicalLines(part.lines));
  }

  return rows.join("\n");
}

function canonicalLines(lines: readonly FingerprintLine[]): string[] {
  return lines
    .map((line) => `line ${canonicalLine(line)}`)
    .sort((a, b) => compare(a, b));
}

/**
 * One line as `quantity|max|unit|altQuantity|altUnit|ingredient`. Absent
 * fields are empty rather than missing, so a unit cannot be mistaken for an
 * ingredient by a line that has no unit.
 */
function canonicalLine(line: FingerprintLine): string {
  return [
    amount(line.quantity),
    amount(line.quantityMax),
    unit(line.unit),
    amount(line.altQuantity),
    unit(line.altUnit),
    name(line.ingredient),
  ].join("|");
}

/**
 * A stored amount as text. Rounded to six decimals first: quantities arrive
 * from SQLite as floats, and 1/3 written twice must not hash twice.
 */
function amount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  return String(Number(value.toFixed(6)));
}

/**
 * A unit, case-folded — "DL" and "dl" are the same decilitre, and which one
 * the model happened to write is not a change to the dish.
 */
function unit(value: string | null): string {
  return value === null ? "" : name(value).toLowerCase();
}

/**
 * A name as written, with only the differences that are not differences
 * removed: composed form, no surrounding space, one space between words.
 * Case is kept — an ingredient renamed is a rename, whatever the letters do.
 */
function name(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ");
}

/** Ordering that does not depend on the host's locale. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
