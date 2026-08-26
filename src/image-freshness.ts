/**
 * Whether a recipe's picture still shows the recipe.
 *
 * One calculation, no queries, so every caller answers the same way: the
 * recipe screen, the JSON API, and — once they exist — the batch generator
 * (#96) and the admin list of what needs regenerating (#97).
 *
 * The fingerprint the picture was made from is stored; the recipe's current
 * fingerprint is computed by `recipe-fingerprint.ts`. Comparing those two is
 * the whole idea.
 */

/** Where a picture came from. */
export type ImageOrigin = "manual" | "generated";

/**
 * - `missing`: there is no picture.
 * - `fresh`: nothing to do. A generated picture whose fingerprint still
 *   matches, or any manually managed picture.
 * - `stale`: a generated picture made from a recipe that has since changed.
 */
export type ImageStatus = "missing" | "fresh" | "stale";

/** What the recipe row records about its picture. */
export interface StoredImage {
  imageKey: string | null;
  imageOrigin: ImageOrigin | null;
  imageFingerprint: string | null;
}

/**
 * A manual upload is *manually managed*, which here means current until
 * somebody replaces or removes it. It is not compared against anything, and
 * that is the point: a photograph a person chose is not this app's to spend
 * money replacing, and marking it stale forever would queue exactly that.
 *
 * A row with a key and no origin is one #89 wrote, before origins existed.
 * Every picture in the app at that point was uploaded by hand, so it reads as
 * a manual upload rather than as an unknown.
 */
export function imageStatus(
  image: StoredImage,
  currentFingerprint: string,
): ImageStatus {
  if (image.imageKey === null) return "missing";
  if (image.imageOrigin !== "generated") return "fresh";
  return image.imageFingerprint === currentFingerprint ? "fresh" : "stale";
}
