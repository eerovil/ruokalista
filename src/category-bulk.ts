import { categoriesForRecipes, categoryLabel, isCategorySlug } from "./categories.ts";
import { page } from "./html.ts";
import type { Member } from "./members.ts";
import { ownedDishes } from "./recipe-publish.ts";
import { askedCategory, ownRecipeList, type ListNotice } from "./recipes.ts";
import type { RouteContext } from "./router.ts";

/**
 * Giving several recipes a category, or taking one off several at once (#199).
 *
 * A household that has just imported a dozen recipes wants to say "these four
 * are Keitto" once, not to open four editors. The action rides on the selection
 * the recipe list already has for publishing, and it changes exactly one
 * category on the ticked dishes: everything else they carry is left alone.
 * That is what makes it safe to run over a long selection — nothing a member
 * cannot see on the screen can be lost by pressing a button.
 *
 * Ownership is `recipe-publish.ts::ownedDishes`, the same query bulk publishing
 * uses: another household's recipe, a part of a dish and an id that never
 * existed are all simply absent, so this form cannot be used to find out which
 * recipes exist. A part carries no categories anywhere else either (ADR-0002),
 * and this is the same rule said once more rather than a new one.
 */

export class CategoryBulkRefused extends Error {}

export interface CategoryBulkOutcome {
  /** Recipes this actually changed. */
  changed: string[];
  /** Recipes that already were — or already were not — in the category. */
  unchanged: string[];
}

/** Add one category to every owned dish among the given ids. */
export async function addCategoryToRecipes(
  db: D1Database,
  member: Member,
  ids: number[],
  category: string,
): Promise<CategoryBulkOutcome> {
  return applyCategory(db, member, ids, category, "add");
}

/** Take one category off every owned dish among the given ids. */
export async function removeCategoryFromRecipes(
  db: D1Database,
  member: Member,
  ids: number[],
  category: string,
): Promise<CategoryBulkOutcome> {
  return applyCategory(db, member, ids, category, "remove");
}

async function applyCategory(
  db: D1Database,
  member: Member,
  ids: number[],
  category: string,
  action: "add" | "remove",
): Promise<CategoryBulkOutcome> {
  if (!isCategorySlug(category)) {
    throw new CategoryBulkRefused("Valitse kategoria.");
  }

  const dishes = await ownedDishes(db, member.householdId, ids);
  if (dishes.length === 0) {
    throw new CategoryBulkRefused("Valitse ainakin yksi resepti.");
  }

  // Read first, so the notice can tell a member how many recipes the press
  // actually moved rather than how many they had ticked. "Two of the six were
  // already Keitto" is the interesting half of the answer.
  const existing = await categoriesForRecipes(
    db,
    dishes.map((dish) => dish.id),
  );

  const outcome: CategoryBulkOutcome = { changed: [], unchanged: [] };
  const statements = [];

  for (const dish of dishes) {
    const has = (existing.get(dish.id) ?? []).includes(category);
    if (has === (action === "add")) {
      outcome.unchanged.push(dish.title);
      continue;
    }
    outcome.changed.push(dish.title);
    statements.push(
      action === "add"
        ? db
            .prepare(
              `INSERT INTO recipe_category (recipe_id, category)
               VALUES (?, ?)
               ON CONFLICT (recipe_id, category) DO NOTHING`,
            )
            .bind(dish.id, category)
        : db
            .prepare(
              `DELETE FROM recipe_category
                WHERE recipe_id = ? AND category = ?`,
            )
            .bind(dish.id, category),
    );
  }

  if (statements.length > 0) await db.batch(statements);
  return outcome;
}

/**
 * `POST /recipes/kategoriat` — the recipe list's bulk category buttons.
 *
 * It answers the way every other form on a screen does: the list comes back
 * with a word said about what happened, in the same search and category it was
 * filtered to, and a refusal re-renders that same list with the reason on it.
 * `problem()` would drop somebody who tapped a button into raw JSON.
 */
export async function categoryBulkForm(
  { env, request }: RouteContext,
  member: Member,
): Promise<Response> {
  const form = await request.formData();
  const action = String(form.get("action") ?? "");
  const query = String(form.get("q") ?? "");
  const filter = askedCategory(String(form.get("kategoria") ?? "") || null);
  const category = String(form.get("bulkCategory") ?? "");
  const ids = form.getAll("recipeId").map((value) => Number(String(value)));

  if (action !== "add" && action !== "remove") {
    return list(env, member, query, filter, category, {
      message: "Tuntematon toiminto.",
      refused: true,
    });
  }

  let outcome: CategoryBulkOutcome;
  try {
    outcome =
      action === "add"
        ? await addCategoryToRecipes(env.DB, member, ids, category)
        : await removeCategoryFromRecipes(env.DB, member, ids, category);
  } catch (error) {
    if (!(error instanceof CategoryBulkRefused)) throw error;
    return list(env, member, query, filter, category, {
      message: error.message,
      refused: true,
    });
  }

  return list(
    env,
    member,
    query,
    filter,
    category,
    doneNotice(action, category, outcome),
  );
}

/**
 * What to say when it worked, counting recipes rather than repeating the
 * selection back. A member who ticked six and moved two wants to read two.
 */
export function doneNotice(
  action: "add" | "remove",
  category: string,
  outcome: CategoryBulkOutcome,
): ListNotice {
  const label = categoryLabel(category);

  if (outcome.changed.length === 0) {
    return {
      message:
        action === "add"
          ? `Valituilla resepteillä oli jo kategoria ${label}.`
          : `Valituilla resepteillä ei ollut kategoriaa ${label}.`,
      refused: false,
    };
  }

  const many = outcome.changed.length !== 1;
  const changed = action === "add"
    ? `Kategoria ${label} lisättiin ${
      many ? `${outcome.changed.length} reseptille` : "yhdelle reseptille"
    }.`
    : `Kategoria ${label} poistettiin ${
      many ? `${outcome.changed.length} reseptiltä` : "yhdeltä reseptiltä"
    }.`;

  if (outcome.unchanged.length === 0) return { message: changed, refused: false };

  const rest = action === "add"
    ? `${outcome.unchanged.length} reseptillä se oli jo.`
    : `${outcome.unchanged.length} reseptillä sitä ei ollut.`;
  return { message: `${changed} ${rest}`, refused: false };
}

async function list(
  env: RouteContext["env"],
  member: Member,
  query: string,
  filter: string | null,
  chosen: string,
  notice: ListNotice,
): Promise<Response> {
  return page(
    "Reseptit",
    await ownRecipeList(
      env.DB,
      member,
      query,
      notice,
      filter,
      isCategorySlug(chosen) ? chosen : null,
    ),
    "recipes",
    member,
    notice.refused ? 400 : 200,
  );
}
