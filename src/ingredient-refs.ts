/**
 * Linking a word in a preparation step to an ingredient of the same recipe.
 *
 * Issue #120: while cooking you read "lisää tomaatit ja crème fraîche" and have
 * to look back up the screen for how much. A reference lets the screen reveal
 * the amount where the word already is.
 *
 * A reference is deliberately thin. It carries **no amount** — the ingredient
 * line stays the only place a quantity lives, so scaling to a different portion
 * count and editing a line later are picked up for free, with nothing to keep
 * in step. And it carries **no character range**: a stored `start`/`end` would
 * be wrong the moment somebody fixed a typo earlier in the sentence. What is
 * stored is the wording that was matched and roughly where it was, and
 * `resolveMentions` finds it again in whatever the text says now.
 *
 * There are two wire shapes, both here so a change to one is next to the other:
 *
 *   - **Saved** (`StepIngredientRef`) — what the `recipe_step.ingredient_refs`
 *     column holds, keyed by ingredient id, as issue #120 describes it.
 *   - **Draft** (`DraftIngredientRef`) — what the model returns and what a form
 *     hands back, keyed by the *index of the ingredient line* in the same
 *     draft or form. An ingredient id does not exist yet at that point: half
 *     the point of an import is that some of its ingredients are about to be
 *     created.
 *
 * `saveRecipe` is where the second becomes the first.
 */

/** How many mentions one step may link. A sentence with more is not a sentence. */
export const MAX_REFS_PER_STEP = 12;

/** A saved reference: this step mentions that ingredient, in these words. */
export interface StepIngredientRef {
  /** The `ingredient` row this mention means. */
  ingredientId: number;
  /**
   * Which of the recipe's own lines it means, by that line's position.
   *
   * The ingredient id alone is not an answer. Nothing stops a recipe listing
   * the same ingredient twice — salt at two stages, oil for frying and oil for
   * the dressing — and the two lines carry different amounts. Resolving a
   * mention to "the first line with that ingredient" would put the frying oil's
   * figure behind a word about the dressing: not a link that failed, a link
   * that is confidently wrong, in a sentence somebody is cooking from.
   *
   * The position rather than `ingredient_line.id`, because the id is not stable
   * here: `replaceRecipe` deletes a recipe's lines and inserts them again on
   * every save, so every id changes each time anybody edits. `(recipe_id,
   * position)` is unique in the schema, is what the editor's position boxes
   * move, and survives that round-trip.
   */
  linePosition: number;
  /** The wording the step actually used — "tomaatit", not "tomaatti". */
  matchedText: string;
  /** Roughly where it sat, used only to choose between repeats. */
  approxPosition: number;
}

/** The little a line has to say about itself for a reference to find it. */
export interface RefLine {
  /** Its position in its own recipe, as `ingredient_line.position` holds it. */
  position: number;
  ingredientId: number;
}

/**
 * Which of a recipe's lines a reference means, or null when that cannot be
 * answered safely.
 *
 * Three steps, and the last one is the point:
 *
 * 1. **The line at that position, if it still holds that ingredient.** The
 *    ordinary case, and the one that keeps two mentions of the same ingredient
 *    apart.
 * 2. **Otherwise, the only line with that ingredient, if there is only one.**
 *    Reordering a recipe renumbers its lines, and a mention of an ingredient
 *    that appears once is not ambiguous however the list is shuffled. Breaking
 *    those on every reorder would make the feature feel unreliable for no gain.
 * 3. **Otherwise nothing.** Several lines carry the ingredient and the position
 *    no longer agrees with any of them, so which one was meant is genuinely
 *    unknown — and a guess here is the failure this whole design exists to
 *    avoid. The mention reads as plain text instead.
 */
export function lineForRef(
  ref: Pick<StepIngredientRef, "ingredientId" | "linePosition">,
  lines: readonly RefLine[],
): RefLine | null {
  const atPosition = lines.find((line) => line.position === ref.linePosition);
  if (atPosition !== undefined && atPosition.ingredientId === ref.ingredientId) {
    return atPosition;
  }

  const carrying = lines.filter((line) => line.ingredientId === ref.ingredientId);
  return carrying.length === 1 ? (carrying[0] as RefLine) : null;
}

/** A reference before the ingredients exist: the draft line's own index. */
export interface DraftIngredientRef {
  /** Index into the draft's (or the form's) `lines`, zero-based. */
  lineIndex: number;
  matchedText: string;
  approxPosition: number;
  /**
   * The ingredient this reference was made against, when there was one.
   *
   * A row index says *where* the ingredient is on the form, not *which* one it
   * is, and those come apart the moment somebody repoints a row: change row 3
   * from tomato to paprika and a step still saying "tomaatit" would quietly
   * start revealing paprika's amount. So the editor sends the id it started
   * with, and the save drops the reference if the row now resolves to a
   * different ingredient.
   *
   * Null on an import, where there is genuinely no id yet — half the point of
   * an import is that some of its ingredients are about to be created, so
   * there is nothing for the index to have come apart from.
   */
  expectedIngredientId: number | null;
}

// -------------------------------------------------------------- resolving

/** One piece of a step's text: plain wording, or a linked mention. */
export type StepSegment =
  | { kind: "text"; text: string }
  | {
      kind: "mention";
      text: string;
      ingredientId: number;
      /** The line whose amount this mention reveals, by its position. */
      linePosition: number;
    };

/**
 * Split a step's text into plain runs and linked mentions.
 *
 * The rule for a single reference is the issue's: find every occurrence of the
 * stored wording in the text as it is now, and take the one nearest to where it
 * used to be. That survives the ordinary edit — inserting a word earlier in the
 * sentence shifts every later position, but the nearest occurrence is still the
 * same occurrence.
 *
 * Anything that cannot be placed safely is simply not linked. A reference whose
 * wording has been edited away, an empty one, one that would overlap a mention
 * already placed, and one whose line `lineForRef` cannot pin down all fall back
 * to plain text, because linking the wrong word is worse than linking no word.
 *
 * `lines` is the recipe's own ingredient lines — the recipe the step belongs
 * to, so a part's step sees a part's lines. It is passed in rather than looked
 * up because this module knows nothing about D1 and is the better for it.
 */
export function resolveMentions(
  text: string,
  refs: readonly StepIngredientRef[],
  lines: readonly RefLine[],
): StepSegment[] {
  interface Placed {
    start: number;
    length: number;
    ingredientId: number;
    linePosition: number;
  }

  const placed: Placed[] = [];

  for (const ref of refs.slice(0, MAX_REFS_PER_STEP)) {
    const needle = ref.matchedText;
    if (needle === "") continue;

    const line = lineForRef(ref, lines);
    if (line === null) continue;

    const occurrences = occurrencesOf(text, needle);
    if (occurrences.length === 0) continue;

    // Nearest to where it was. A tie goes to the earlier one, which keeps the
    // result the same however the list happened to be ordered.
    let best = occurrences[0] as number;
    for (const start of occurrences) {
      if (
        Math.abs(start - ref.approxPosition) <
        Math.abs(best - ref.approxPosition)
      ) {
        best = start;
      }
    }

    const candidate = {
      start: best,
      length: needle.length,
      ingredientId: ref.ingredientId,
      linePosition: line.position,
    };

    // Two references landing on the same words means at least one of them is
    // stale. Keep the first and leave the other as plain text.
    const clashes = placed.some(
      (other) =>
        candidate.start < other.start + other.length &&
        other.start < candidate.start + candidate.length,
    );
    if (clashes) continue;

    placed.push(candidate);
  }

  placed.sort((a, b) => a.start - b.start);

  const segments: StepSegment[] = [];
  let cursor = 0;

  for (const mention of placed) {
    if (mention.start > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, mention.start) });
    }
    segments.push({
      kind: "mention",
      text: text.slice(mention.start, mention.start + mention.length),
      ingredientId: mention.ingredientId,
      linePosition: mention.linePosition,
    });
    cursor = mention.start + mention.length;
  }

  if (cursor < text.length) {
    segments.push({ kind: "text", text: text.slice(cursor) });
  }

  return segments;
}

/**
 * Whether this wording can still be found in this text at all — the cheapest
 * form of the same question `resolveMentions` asks, used to throw away a
 * reference to words a producer never actually wrote.
 */
export function mentionResolves(text: string, matchedText: string): boolean {
  if (matchedText.trim() === "") return false;
  return occurrencesOf(text, matchedText).length > 0;
}

/**
 * Every index where `needle` occurs in `haystack` **as a word of its own**,
 * matched without regard to case.
 *
 * Case is folded in Finnish, so "Tomaatit" at the start of a sentence still
 * matches a reference recorded as "tomaatit". Folding can in principle change a
 * string's length, which would make an index into the folded text mean nothing
 * in the original — when that happens this falls back to matching exactly,
 * which loses a match rather than mislabelling one.
 *
 * A plain substring search is not enough. A reference recorded for "suola"
 * would go on matching after the step was edited to "Lisää suolakurkut", and
 * the salt amount would appear inside a word about gherkins — the exact thing
 * a stale reference is supposed to stop doing. So a candidate has to sit on a
 * word boundary: no letter, digit or combining mark immediately either side.
 *
 * Finnish inflection is untouched by this, because the wording stored is the
 * wording the step used — "tomaatit" is matched as "tomaatit", not derived
 * from "tomaatti". A step later re-inflected to "tomaatteja" loses the link,
 * and losing it is the correct half of the trade.
 *
 * The boundary is only required on a side where the stored wording itself ends
 * in a word character. A reference that happens to carry its own punctuation
 * should not be refused for the company it keeps.
 */
function occurrencesOf(haystack: string, needle: string): number[] {
  const foldedHay = haystack.toLocaleLowerCase("fi");
  const foldedNeedle = needle.toLocaleLowerCase("fi");

  const usable =
    foldedHay.length === haystack.length && foldedNeedle.length === needle.length;
  const hay = usable ? foldedHay : haystack;
  const pin = usable ? foldedNeedle : needle;
  if (pin === "") return [];

  const checkBefore = startsWithWordChar(pin);
  const checkAfter = endsWithWordChar(pin);

  const found: number[] = [];
  let from = 0;

  for (;;) {
    const at = hay.indexOf(pin, from);
    if (at === -1) break;
    from = at + 1;

    if (checkBefore && isWordCharBefore(hay, at)) continue;
    if (checkAfter && isWordCharAt(hay, at + pin.length)) continue;
    found.push(at);
  }

  return found;
}

/**
 * A letter, a digit or a combining mark — Unicode-aware, because "ö" and "ä"
 * are ordinary letters here and an ASCII rule would call them boundaries and
 * happily match "suola" inside "suolaöljy".
 */
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

function isWordCharAt(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return false;
  const code = text.codePointAt(index);
  return code !== undefined && WORD_CHAR.test(String.fromCodePoint(code));
}

/** The character ending just before `index`, surrogate pair and all. */
function isWordCharBefore(text: string, index: number): boolean {
  if (index <= 0) return false;
  const previous = text.charCodeAt(index - 1);
  const isLowSurrogate = previous >= 0xdc00 && previous <= 0xdfff;
  return isWordCharAt(text, isLowSurrogate && index >= 2 ? index - 2 : index - 1);
}

function startsWithWordChar(text: string): boolean {
  return isWordCharAt(text, 0);
}

function endsWithWordChar(text: string): boolean {
  return isWordCharBefore(text, text.length);
}

// ----------------------------------------------------------------- codecs

/**
 * Read the saved column. Anything malformed reads as "no references": a step
 * whose links cannot be understood is still a step somebody has to cook from.
 */
export function parseStepRefs(raw: unknown): StepIngredientRef[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const refs: StepIngredientRef[] = [];
  for (const entry of parsed.slice(0, MAX_REFS_PER_STEP)) {
    if (typeof entry !== "object" || entry === null) continue;
    const ref = entry as Record<string, unknown>;
    const ingredientId = ref["ingredientId"];
    const linePosition = ref["linePosition"];
    const matchedText = ref["matchedText"];
    const approxPosition = ref["approxPosition"];

    if (!Number.isSafeInteger(ingredientId) || (ingredientId as number) <= 0) {
      continue;
    }
    // Required, not optional. The column ships with this change and nothing is
    // deployed, so there is no older shape to keep working — and a reference
    // that cannot say which line it means is exactly the one worth losing.
    if (!Number.isSafeInteger(linePosition) || (linePosition as number) <= 0) {
      continue;
    }
    if (typeof matchedText !== "string" || matchedText.trim() === "") continue;
    if (!Number.isSafeInteger(approxPosition) || (approxPosition as number) < 0) {
      continue;
    }

    refs.push({
      ingredientId: ingredientId as number,
      linePosition: linePosition as number,
      matchedText,
      approxPosition: approxPosition as number,
    });
  }

  return refs;
}

/** What goes in the column. An empty list is NULL, not `"[]"`. */
export function serializeStepRefs(
  refs: readonly StepIngredientRef[],
): string | null {
  if (refs.length === 0) return null;
  return JSON.stringify(
    refs.slice(0, MAX_REFS_PER_STEP).map((ref) => ({
      ingredientId: ref.ingredientId,
      linePosition: ref.linePosition,
      matchedText: ref.matchedText,
      approxPosition: ref.approxPosition,
    })),
  );
}

/**
 * The draft-shaped references as one form field, so the editor can carry a
 * step's links through an edit of its wording without asking anybody about
 * them. Short keys because this rides in a form body that is already capped.
 */
export function encodeDraftRefs(refs: readonly DraftIngredientRef[]): string {
  if (refs.length === 0) return "";
  return JSON.stringify(
    refs.slice(0, MAX_REFS_PER_STEP).map((ref) => [
      ref.lineIndex,
      ref.matchedText,
      ref.approxPosition,
      ref.expectedIngredientId,
    ]),
  );
}

/** The other half of `encodeDraftRefs`. Junk decodes to no references. */
export function decodeDraftRefs(raw: string): DraftIngredientRef[] {
  if (raw.trim() === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const refs: DraftIngredientRef[] = [];
  for (const entry of parsed.slice(0, MAX_REFS_PER_STEP)) {
    if (!Array.isArray(entry) || entry.length !== 4) continue;
    const [lineIndex, matchedText, approxPosition, expected] = entry as unknown[];
    if (!Number.isSafeInteger(lineIndex) || (lineIndex as number) < 0) continue;
    if (typeof matchedText !== "string" || matchedText.trim() === "") continue;
    if (!Number.isSafeInteger(approxPosition) || (approxPosition as number) < 0) {
      continue;
    }
    // Null is a real value here — it says "this came from an import, there was
    // no ingredient to expect" — so only a wrong *kind* of value is junk.
    if (expected !== null && (!Number.isSafeInteger(expected) || (expected as number) <= 0)) {
      continue;
    }
    refs.push({
      lineIndex: lineIndex as number,
      matchedText,
      approxPosition: approxPosition as number,
      expectedIngredientId: expected as number | null,
    });
  }

  return refs;
}
