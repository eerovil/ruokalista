/** Cooking-order meaning carried only by content on a multipart dish itself. */
export type RecipePhase = "before_parts" | "after_parts" | null;

/** Untrusted model and stored values stay explicitly unclassified when unknown. */
export function recipePhase(value: unknown): RecipePhase {
  return value === "before_parts" || value === "after_parts" ? value : null;
}
