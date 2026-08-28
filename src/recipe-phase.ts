/** Cooking-order meaning carried only by content on a multipart dish itself. */
export type RecipePhase = "before_parts" | "after_parts" | null;

/** Untrusted model and stored values stay explicitly unclassified when unknown. */
export function recipePhase(value: unknown): RecipePhase {
  return value === "before_parts" || value === "after_parts" ? value : null;
}

/**
 * The section of a cooking view a phase renders in — `"before"` or `"after"`.
 *
 * Unclassified content is bucketed with `before_parts`, which is what
 * `recipes.ts::recipeView` and `cast.ts::castRecipe` both pass: a phase the
 * intake model never set keeps its old parent-first position, so landing
 * ADR-0003 did not visibly reorder an existing recipe.
 *
 * This exists as a named function because it is now also the boundary an
 * alternative group may not cross (#183). Two options rendered in different
 * sections are two lines a cook reads apart, and the shopping list has to see
 * the same split — so both ends ask this one question rather than comparing
 * raw phases, which would call `null` and `before_parts` different when the
 * screen shows them together.
 */
export function phaseBucket(phase: RecipePhase): "before" | "after" {
  return phase === "after_parts" ? "after" : "before";
}
