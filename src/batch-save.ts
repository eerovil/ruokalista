import type { RecipeToSave } from "./recipe-save.ts";

export interface SavedRecipe {
  id: number;
  title: string;
}

export interface SequentialSaveResult {
  saved: SavedRecipe[];
  failed: { index: number; title: string; error: unknown } | null;
}

/** Keep successful saves and the exact first failure separate for honest UI. */
export async function saveRecipesSequentially(
  recipes: RecipeToSave[],
  save: (recipe: RecipeToSave) => Promise<number>,
): Promise<SequentialSaveResult> {
  const saved: SavedRecipe[] = [];
  for (const [index, recipe] of recipes.entries()) {
    try {
      saved.push({ id: await save(recipe), title: recipe.title.trim() });
    } catch (error) {
      return { saved, failed: { index, title: recipe.title.trim(), error } };
    }
  }
  return { saved, failed: null };
}

/** Remove already-saved recipes so a partial import can be resumed safely. */
export function remainingBundle(json: string, savedCount: number): string {
  const raw = JSON.parse(json) as { recipes: unknown[] };
  return JSON.stringify({ ...raw, recipes: raw.recipes.slice(savedCount) });
}
