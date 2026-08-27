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

  // Saved references identify the ingredient they were made against. Ask
  // whether that identity survives the submitted form, not what a removed row
  // was repointed to on the way out.
  const orphanedIds = new Set<number>();
  steps.forEach((step) => {
    decodeDraftRefs(step.refs)
      .filter((ref) => ref.expectedIngredientId !== null)
      .filter((ref) => mentionResolves(step.text, ref.matchedText))
      .forEach((ref) => {
        const id = ref.expectedIngredientId;
        if (id !== null && !staying.has(id)) orphanedIds.add(id);
      });
  });

  // Preserve the form's row order for ordinary removals. An identity that was
  // hidden by repointing the removed row follows those known row identities.
  const orderedIds: number[] = [];
  for (const row of going.values()) {
    const id = chosenIngredientId(row);
    if (id !== null && orphanedIds.delete(id)) orderedIds.push(id);
  }
  orderedIds.push(...orphanedIds);

  const conflicts = orderedIds.map((id) => ({
    name: nameOf(id, ingredients),
    steps: mentioningSteps(
      steps,
      (_lineIndex, expectedIngredientId) => expectedIngredientId === id,
    ),
  }));

  // Imports can make links before an ingredient id exists. Only those links
  // fall back to the removed row's index.
  for (const [index, row] of going) {
    const mentioning = mentioningSteps(
      steps,
      (lineIndex, expectedIngredientId) =>
        expectedIngredientId === null && lineIndex === index,
    );
    if (mentioning.length === 0) continue;
    conflicts.push({
      name: nameOf(chosenIngredientId(row), ingredients, row.newName),
      steps: mentioning,
    });
  }

  return conflicts;
}

function mentioningSteps(
  steps: readonly StepFormValues[],
  pointsAtIngredient: (
    lineIndex: number,
    expectedIngredientId: number | null,
  ) => boolean,
): MentioningStep[] {
  const mentioning: MentioningStep[] = [];

  steps.forEach((step, place) => {
    const words = decodeDraftRefs(step.refs)
      .filter((ref) => pointsAtIngredient(ref.lineIndex, ref.expectedIngredientId))
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

  return mentioning;
}

function chosenIngredientId(row: LineFormValues): number | null {
  const id = Number(row.ingredientChoice);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function nameOf(
  id: number | null,
  ingredients: readonly NamedIngredient[],
  proposed = "",
): string {
  if (id !== null) {
    const known = ingredients.find((ingredient) => ingredient.id === id);
    if (known !== undefined) return known.name;
  }
  const name = proposed.trim();
  return name === "" ? "Aines" : name;
}
