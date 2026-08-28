/**
 * Alternatives on an ingredient line: lihaliemikuutio **tai** fondiannos.
 *
 * A recipe often offers a choice — voi tai margariini, kerma tai kookosmaito,
 * tuore chili tai chilihiutaleet. That is a fact about *this recipe*, not a
 * standing claim that the two foodstuffs are interchangeable everywhere, so it
 * is stored on the recipe's own lines and nowhere else (#183).
 *
 * The whole shape is one nullable `ingredient_line.alternative_group`:
 *
 *   - **Each option is a whole line.** It keeps its own quantity, unit, second
 *     measurement, source wording and phase for free, and — the part that
 *     matters — it points at a real `ingredient` row. Before this, the only way
 *     to say it was to name an ingredient `hunaja tai sokeri`, and since #143
 *     made the dictionary global that phrase became everybody's, matched no
 *     cupboard entry and could never be bought as a product.
 *   - **A group is scoped to one recipe row.** A part is a recipe of its own
 *     (ADR-0002), so its group 1 and its dish's group 1 are different groups.
 *   - **NULL is not a group of one.** It means an ordinary line standing alone.
 *     A group needs at least two options or it is not a choice, which is why
 *     `normalizeGroups` dissolves a singleton rather than storing it.
 *   - **The first option is the default.** Lowest position in the group. The
 *     shopping list buys that one and nothing else, because buying both is
 *     buying one ingredient too many, and buying neither is worse.
 *
 * Nothing here reads or writes the database; `recipes.ts`, `recipe-save.ts` and
 * `shopping.ts` do that and ask this module what the numbers mean.
 */

/** A line's group, or null when it stands alone. Always a positive integer. */
export type AlternativeGroup = number | null;

/** How a screen joins two options. Finnish in the product, per CLAUDE.md. */
export const ALTERNATIVE_WORD = "tai";

/** Anything carrying a group — a stored line, a draft line, a line to save. */
export interface HasAlternativeGroup {
  alternativeGroup: AlternativeGroup;
}

/**
 * Narrow an untrusted value to a group number.
 *
 * Used on three untrusted edges — a column, a form box and a model's JSON — so
 * it is deliberately total: anything that is not a positive whole number is
 * "no group" rather than an error. A junk group number is a line that offers no
 * alternative, which is the recipe as it reads today; refusing the save would
 * lose an edit over a field nobody typed on purpose.
 */
export function alternativeGroup(value: unknown): AlternativeGroup {
  const number = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof number !== "number") return null;
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return number;
}

/**
 * One thing an ingredient list shows: a plain line, or a set of options.
 *
 * A set sits where its *first* option sits. Group numbers are a member's own
 * text box, so nothing stops them being written on lines 1 and 5 with unrelated
 * lines between; gathering them at the first keeps the list readable without
 * refusing input that says something perfectly clear.
 */
export interface AlternativeSet<Line> {
  /** The group these share, or null when `options` is one plain line. */
  group: AlternativeGroup;
  /** At least one line. The first is the default. */
  options: Line[];
}

/**
 * Gather a recipe row's lines into what a screen renders, in list order.
 *
 * Call with the lines of exactly one recipe row — a dish's own, or one part's.
 * Passing two rows' lines together would let their group numbers collide, which
 * is why no caller here ever concatenates first.
 */
export function alternativeSets<Line extends HasAlternativeGroup>(
  lines: readonly Line[],
): Array<AlternativeSet<Line>> {
  const sets: Array<AlternativeSet<Line>> = [];
  const byGroup = new Map<number, AlternativeSet<Line>>();

  for (const line of lines) {
    const group = line.alternativeGroup;
    if (group === null) {
      sets.push({ group: null, options: [line] });
      continue;
    }

    const existing = byGroup.get(group);
    if (existing === undefined) {
      const set = { group, options: [line] };
      byGroup.set(group, set);
      sets.push(set);
      continue;
    }
    existing.options.push(line);
  }

  return sets;
}

/**
 * The options a shopping list actually buys: every plain line, plus the first
 * option of each group and none of its others.
 *
 * `scopeOf` says what counts as one appearance of a group, and it has to,
 * because the list spans several cookings at once: the same recipe planned
 * twice is two batches that each need their choice bought. The caller keys on
 * whatever identifies one recipe row inside one batch.
 *
 * Order is preserved, so "first" means first in the order the caller supplied —
 * which for the list is `ingredient_line.position`.
 */
export function chosenAlternatives<Line extends HasAlternativeGroup>(
  lines: readonly Line[],
  scopeOf: (line: Line) => string,
): Line[] {
  const taken = new Set<string>();

  return lines.filter((line) => {
    if (line.alternativeGroup === null) return true;
    const key = `${scopeOf(line)} ${line.alternativeGroup}`;
    if (taken.has(key)) return false;
    taken.add(key);
    return true;
  });
}

/**
 * The groups a recipe row stores, renumbered 1, 2, 3… in the order they first
 * appear, with every group of one dissolved back to null.
 *
 * Two reasons this runs on every save rather than trusting what was submitted.
 * A member's group box takes any positive number, so a recipe edited a few
 * times drifts to `2, 7, 40` and the numbers stop meaning anything to the next
 * person reading the row. And removing one half of a pair leaves the other
 * claiming to be a choice with nothing to choose against — the same rule the
 * database `CHECK` cannot express, since it can only see one row at a time.
 *
 * Returns new objects; the input is left alone.
 */
export function normalizeGroups<Line extends HasAlternativeGroup>(
  lines: readonly Line[],
): Line[] {
  const counts = new Map<number, number>();
  for (const line of lines) {
    const group = line.alternativeGroup;
    if (group === null) continue;
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }

  const renumbered = new Map<number, number>();
  return lines.map((line) => {
    const group = line.alternativeGroup;
    if (group === null || (counts.get(group) ?? 0) < 2) {
      return { ...line, alternativeGroup: null };
    }

    let number = renumbered.get(group);
    if (number === undefined) {
      number = renumbered.size + 1;
      renumbered.set(group, number);
    }
    return { ...line, alternativeGroup: number };
  });
}
