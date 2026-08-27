import { decodeDraftRefs, mentionResolves } from "./ingredient-refs.ts";
import type { LineFormValues, StepFormValues } from "./line-form.ts";

/**
 * Removing an ingredient that the preparation steps still talk about.
 *
 * Issue #128 makes removal a one-tap action on the recipe editor's row, and a
 * one-tap action needs a guard: "poista tomaatti" while step 3 still says
 * *lisää tomaatit* leaves a recipe telling you to add something it does not
 * list. So a removal that would orphan a mention is refused, the steps at fault
 * are named, and the member fixes the sentence — or forces it through, which is
 * a separate button and says what it costs.
 *
 * The check is asked of the *links*, not of the text. A raw string search would
 * miss "tomaatteja", hit "tomaattipyree", and get louder every time somebody
 * inflected a word — the ingredient↔step anchors from issue #120 already know
 * which words in which sentence mean which ingredient, so this asks them.
 *
 * Two things follow from that, both deliberate:
 *
 *   - A mention whose wording is no longer in the step is not a mention. That is
 *     exactly how a member gets *out* of the refusal: delete the word, save
 *     again, and the removal goes through with nothing extra to press.
 *   - An ingredient still on another row is not orphaned. Removing one of two
 *     tomato lines leaves the mention something to point at, which is the same
 *     rule `recipe-save.ts::ingredientForRef` applies when it saves.
 */

/** One ingredient that cannot go yet, and the steps that are why. */
export interface RemovalConflict {
  /** What to call it on screen. */
  name: string;
  /** The steps still mentioning it, in the order they are on the form. */
  steps: MentioningStep[];
}

export interface MentioningStep {
  /** The step's place on the form, one-based — what the member sees. */
  number: number;
  text: string;
  /** The wording that is linked, so the member knows what to look for. */
  mentions: string[];
}

/** Enough of an ingredient to name it. `ingredientsFor` rows satisfy this. */
export interface NamedIngredient {
  id: number;
  name: string;
}

/**
 * The removals on this form that would orphan a mention, or an empty list when
 * every one of them is safe.
 */
export function removalConflicts(
  rows: readonly LineFormValues[],
  steps: readonly StepFormValues[],
  ingredients: readonly NamedIngredient[],
): RemovalConflict[] {
  const going = new Map<number, LineFormValues>();
  const staying = new Set<number>();

  rows.forEach((row, index) => {
    const id = chosenIngredientId(row);
    if (row.remove) {
      going.set(index, row);
    } else if (id !== null) {
      staying.add(id);
    }
  });

  if (going.size === 0) return [];

  const conflicts: RemovalConflict[] = [];

  for (const [index, row] of going) {
    const id = chosenIngredientId(row);
    // Still on another row, so the sentence keeps its meaning and its amount.
    if (id !== null && staying.has(id)) continue;

    const mentioning: MentioningStep[] = [];

    steps.forEach((step, place) => {
      const words = decodeDraftRefs(step.refs)
        .filter((ref) => pointsAtRow(ref.lineIndex, ref.expectedIngredientId, index, id))
        // A link to wording the step no longer uses is already dead, and
        // refusing over it would be a refusal nobody could clear.
        .filter((ref) => mentionResolves(step.text, ref.matchedText))
        .map((ref) => ref.matchedText);

      if (words.length === 0) return;
      mentioning.push({
        number: place + 1,
        text: step.text,
        mentions: [...new Set(words)],
      });
    });

    if (mentioning.length === 0) continue;
    conflicts.push({
      name: nameOf(row, id, ingredients),
      steps: mentioning,
    });
  }

  return conflicts;
}

/**
 * Whether a step's link is a link to the row being removed.
 *
 * The id is what actually identifies the ingredient; the row index is only the
 * fallback for an import's links, which were made before any id existed.
 */
function pointsAtRow(
  refLineIndex: number,
  refIngredientId: number | null,
  rowIndex: number,
  rowIngredientId: number | null,
): boolean {
  if (refIngredientId !== null) return refIngredientId === rowIngredientId;
  return refLineIndex === rowIndex;
}

function chosenIngredientId(row: LineFormValues): number | null {
  const id = Number(row.ingredientChoice);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function nameOf(
  row: LineFormValues,
  id: number | null,
  ingredients: readonly NamedIngredient[],
): string {
  if (id !== null) {
    const known = ingredients.find((ingredient) => ingredient.id === id);
    if (known !== undefined) return known.name;
  }
  const proposed = row.newName.trim();
  return proposed === "" ? "Aines" : proposed;
}
