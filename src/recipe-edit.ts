import type { Member } from "./members.ts";
import { recipeSectionKey } from "./recipe-section.ts";
import {
  replaceRecipe,
  StaleRecipe,
  type ExpectedPart,
  type LineToSave,
  type StepToSave,
} from "./recipe-save.ts";
import { findRecipe, type Recipe } from "./recipes.ts";

/**
 * The state an edit was reviewed against.
 *
 * This is deliberately smaller than `Recipe`: it contains only the identities
 * whose movement can make an edit stale. Source text, source route and the
 * current part rows are not caller input to a write; `editRecipe` loads those
 * itself at the moment the mutation is attempted.
 */
export interface RecipeEditSnapshot {
  recipeId: number;
  revision: number;
  parts: ExpectedPart[];
  categories: string[];
}

/** The fields a recipe edit is actually allowed to change. */
export interface RecipeEditIntent {
  title: string;
  yieldPortions: number | null;
  steps: StepToSave[];
  lines: LineToSave[];
  categories: string[];
}

export interface RecipeEditOptions {
  /** Keep the quick-save/editor contract from issue #211. */
  allowEmpty?: boolean;
}

const CATEGORIES_MOVED =
  "Reseptin kategoriat ovat muuttuneet. Tarkista uusin versio ennen tallennusta.";

/** A stale edit whose conflicting state was specifically the category set. */
export class StaleRecipeCategories extends StaleRecipe {}

/** Capture the concurrency facts a form or durable edit job was written against. */
export function recipeEditSnapshot(recipe: Recipe): RecipeEditSnapshot {
  return {
    recipeId: recipe.id,
    revision: recipe.revision,
    parts: recipe.parts.map((part) => ({
      id: part.id,
      title: part.title,
      revision: part.revision,
    })),
    categories: [...recipe.categories],
  };
}

/**
 * Apply one edit against the snapshot it was reviewed from.
 *
 * This is the application-level mutation boundary. Callers say what the member
 * wants to change and what version they reviewed; they do not supply the
 * recipe's current parts, immutable source fields, or the validation flag that
 * says whether the resulting dish has parts. Those are facts about current
 * persisted state and belong here.
 *
 * `replaceRecipe` remains the lower-level atomic writer. Its category and part
 * predicates are still in the same D1 update as the recipe revision check; the
 * read here is for preparing that write and for explaining a refusal, never a
 * substitute for the mutation-time guards.
 */
export async function editRecipe(
  db: D1Database,
  member: Member,
  snapshot: RecipeEditSnapshot,
  intent: RecipeEditIntent,
  options: RecipeEditOptions = {},
): Promise<void> {
  if (!Number.isSafeInteger(snapshot.recipeId) || snapshot.recipeId <= 0) {
    throw new StaleRecipe("Reseptiä ei enää ole.");
  }

  const current = await findRecipe(db, member.householdId, snapshot.recipeId);
  if (current === null) throw new StaleRecipe("Reseptiä ei enää ole.");

  const hasParts =
    current.parts.length > 0 ||
    intent.lines.some((line) => recipeSectionKey(line.section) !== null) ||
    intent.steps.some((step) => recipeSectionKey(step.section) !== null);

  try {
    await replaceRecipe(
      db,
      member,
      current.id,
      snapshot.revision,
      {
        ...intent,
        // Source provenance is immutable through editing. A caller cannot
        // accidentally copy source fields from a model proposal or stale form,
        // because the edit interface does not accept them at all.
        sourceText: current.sourceText,
        sourceRoute: current.sourceRoute,
        sourceUrl: current.sourceUrl,
        structuredBy: null,
      },
      {
        hasParts,
        allowEmpty: options.allowEmpty,
        // Present state decides which rows may be written; the snapshot decides
        // which revisions the member actually reviewed. Keeping both halves in
        // this module is the concurrency seam issue #276 asks for.
        parts: current.parts.map((part) => ({ id: part.id, title: part.title })),
        expectedParts: snapshot.parts,
        expectedCategories: snapshot.categories,
      },
    );
  } catch (error) {
    if (error instanceof StaleRecipe) {
      // `replaceRecipe` can tell dish-vs-part movement from its write token, but
      // a category lock lives on the same parent UPDATE. Re-read only on this
      // refusal path so category movement gets its own useful explanation.
      const latest = await findRecipe(db, member.householdId, snapshot.recipeId);
      if (latest !== null && !sameCategories(latest.categories, snapshot.categories)) {
        throw new StaleRecipeCategories(CATEGORIES_MOVED);
      }
    }
    throw error;
  }
}

function sameCategories(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every((category) => expected.has(category));
}
