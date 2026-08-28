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
 *   - **A group belongs to one recipe row and one cooking-order section.** A
 *     part is a recipe of its own (ADR-0002), so its group 1 and its dish's
 *     group 1 are different groups. A multipart dish's own lines are split
 *     again by `recipe-phase.ts::phaseBucket`, because the cooking view draws
 *     the two sections apart and options a cook reads apart are not a choice.
 *     Every function here takes that boundary as a `scopeOf` callback rather
 *     than deriving it, so save, rendering, Cast and the shopping list are
 *     asking one question instead of four — which is the fault this shape was
 *     rewritten to remove.
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
 * Gather one scope's lines into what a screen renders, in list order.
 *
 * Call with the lines of exactly one recipe row *and* one cooking-order
 * section — which is what `recipes.ts::body` and `cast.ts::ingredientGroup`
 * already hold, since both filter by phase before they get here. Passing two
 * scopes' lines together would let their group numbers collide, and a save
 * refuses to write a group that spans two in the first place.
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
 * The one source line to print for a whole set, or "" when there is not one.
 *
 * Import gives every option of a group the *same* `source_line` on purpose:
 * `1 lihaliemikuutio tai 1 annos fondia` is one sentence the page wrote, and
 * each option is a reading of it. `scaling.ts::sourceWorthShowing` then turns
 * true for every option with a stated amount the moment a cooking is not 1x,
 * and printing that sentence under each of them repeated the whole choice once
 * per option — on the TV, inside a string that was about to be joined to the
 * next option by another `tai`.
 *
 * So the set states its evidence once. Where the options genuinely carry
 * different wording, there is no one line to state and this returns "", which
 * puts each option back on its own source — nothing is dropped either way.
 *
 * A set of one answers with that line's own source, so an ordinary line is
 * unaffected by any of this.
 */
export function sharedSource<Line extends { sourceLine: string }>(
  options: readonly Line[],
  worthShowing: (line: Line) => boolean,
): string {
  const distinct = new Set<string>();
  for (const option of options) {
    if (!worthShowing(option)) continue;
    if (option.sourceLine.trim() === "") continue;
    distinct.add(option.sourceLine);
  }

  return distinct.size === 1 ? [...distinct][0]! : "";
}

/**
 * The options a shopping list actually buys: every plain line, plus the first
 * option of each group and none of its others.
 *
 * `scopeOf` says what counts as one appearance of a group, and it has to,
 * because the list spans several cookings at once: the same recipe planned
 * twice is two batches that each need their choice bought. The caller keys on
 * the cooking, the recipe row *and* the cooking-order section — the same
 * boundary the save enforces and the cooking view draws by, so the list cannot
 * treat two lines as a pair that the screen showed apart.
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
    const key = groupKey(scopeOf(line), line.alternativeGroup);
    if (taken.has(key)) return false;
    taken.add(key);
    return true;
  });
}

/**
 * The groups a recipe row stores, renumbered 1, 2, 3… in the order they first
 * appear, with every group of one dissolved back to null.
 *
 * Grouping is per scope; the *numbers* run across the whole row. Both halves
 * matter. Numbering per scope would make a dish's before-parts group and its
 * after-parts group both `1`, which is precisely the row `groupsAcrossScopes`
 * refuses — a member could not open a legitimate recipe and save it again.
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
  scopeOf: (line: Line) => string,
): Line[] {
  const counts = new Map<string, number>();
  for (const line of lines) {
    if (line.alternativeGroup === null) continue;
    const key = groupKey(scopeOf(line), line.alternativeGroup);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const renumbered = new Map<string, number>();
  return lines.map((line) => {
    const group = line.alternativeGroup;
    if (group === null) return { ...line, alternativeGroup: null };

    const key = groupKey(scopeOf(line), group);
    if ((counts.get(key) ?? 0) < 2) {
      return { ...line, alternativeGroup: null };
    }

    let number = renumbered.get(key);
    if (number === undefined) {
      number = renumbered.size + 1;
      renumbered.set(key, number);
    }
    return { ...line, alternativeGroup: number };
  });
}

/**
 * The group numbers written under more than one scope — a save refuses these.
 *
 * This is the check `normalizeGroups` deliberately cannot make on its own.
 * Dissolving such a group would be silent: the member typed one number twice
 * and would get two ordinary lines back with nothing said. Worse, it is the
 * one input where the old code let rendering and the shopping list disagree —
 * the cooking view drew the options in two sections as two lone lines, while
 * the list still counted them a pair and bought only the first.
 */
export function groupsAcrossScopes<Line extends HasAlternativeGroup>(
  lines: readonly Line[],
  scopeOf: (line: Line) => string,
): number[] {
  const scopes = new Map<number, Set<string>>();
  for (const line of lines) {
    const group = line.alternativeGroup;
    if (group === null) continue;
    const seen = scopes.get(group) ?? new Set<string>();
    seen.add(scopeOf(line));
    scopes.set(group, seen);
  }

  return [...scopes.entries()]
    .filter(([, seen]) => seen.size > 1)
    .map(([group]) => group)
    .sort((a, b) => a - b);
}

/**
 * One grouping boundary, as a string.
 *
 * A separator that cannot appear in a scope would be better than trusting the
 * caller, and there is one: the scope is written first with its own length, so
 * `"a 1"`/`"1"` and `"a"`/`"1 1"` cannot collide however a caller spells a
 * scope.
 */
function groupKey(scope: string, group: number): string {
  return `${scope.length}:${scope}:${group}`;
}
