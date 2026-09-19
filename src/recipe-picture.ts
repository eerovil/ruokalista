import { html, type Raw } from "./html.ts";

/**
 * A recipe's picture, wherever one is drawn.
 *
 * It lives in its own module rather than in `recipes.ts` because the shared
 * recipe browser (#307) draws it too, and `recipes.ts` uses the browser — a
 * thumbnail is not worth an import cycle. `recipes.ts` re-exports both names,
 * so every existing caller keeps importing them from where it always did.
 */

/** Everything rendering a picture needs to know. A `Recipe` is one of these. */
export interface Pictured {
  id: number;
  imageKey: string | null;
}

/** A recipe picture, or a same-size empty placeholder. */
export function recipeImage(
  recipe: Pictured,
  size: "hero" | "thumb" = "hero",
): Raw {
  const shape =
    size === "thumb" ? "recipe-image is-thumb" : "recipe-image is-hero";
  return recipe.imageKey === null
    ? html`<div class="${shape} is-empty" aria-hidden="true"></div>`
    : html`<div class="${shape}">
        <img src="/api/recipes/${recipe.id}/image" alt="" loading="lazy" />
      </div>`;
}
