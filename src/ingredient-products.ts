import {
  baseAmount,
  packageSizeFromName,
  type BaseAmount,
} from "./packaging.ts";

/**
 * Which shop products stand for which ingredient.
 *
 * Two questions, two tables (`migrations/0013_ingredient_products.sql`):
 *
 *   - **What does this household normally buy for jauheliha?** Several answers
 *     are allowed, one per package size, and the shopping list picks between
 *     them by how much the week needs.
 *   - **Does one recipe insist on something else?** One answer at most, per
 *     household, per recipe, per ingredient — and it wins.
 *
 * Nothing here is household-scoped on the ingredient side, because the
 * ingredient dictionary itself is global since #143 and the integration is used
 * by one configured household (#147). The override side *is* household-scoped,
 * so choosing a product for a recipe another household published stays this
 * household's business.
 */

export interface ProductChoice {
  ean: string;
  name: string;
  imageUrl: string | null;
  /** Null together when the package size is not known — never half-known. */
  packageQuantity: number | null;
  packageUnit: string | null;
}

/** The chosen product's package size as an amount the solver can use. */
export function productSize(product: ProductChoice): BaseAmount | null {
  return baseAmount(product.packageQuantity, product.packageUnit);
}

interface ProductRow {
  ingredient_id: number;
  ean: string;
  name: string;
  image_url: string | null;
  package_quantity: number | null;
  package_unit: string | null;
}

interface OverrideRow extends ProductRow {
  recipe_id: number;
}

/** Every product each of these ingredients knows, in the order they were added. */
export async function productsForIngredients(
  db: D1Database,
  ingredientIds: number[],
): Promise<Map<number, ProductChoice[]>> {
  const found = new Map<number, ProductChoice[]>();
  if (ingredientIds.length === 0) return found;

  const placeholders = ingredientIds.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT ingredient_id, ean, name, image_url, package_quantity, package_unit
         FROM ingredient_product
        WHERE ingredient_id IN (${placeholders})
        ORDER BY ingredient_id, position, id`,
    )
    .bind(...ingredientIds)
    .all<ProductRow>();

  for (const row of results) {
    const list = found.get(row.ingredient_id) ?? [];
    list.push(readChoice(row));
    found.set(row.ingredient_id, list);
  }
  return found;
}

/** `recipeId:ingredientId -> the product that recipe insists on`. */
export async function overridesForRecipes(
  db: D1Database,
  householdId: number,
  recipeIds: number[],
): Promise<Map<string, ProductChoice>> {
  const found = new Map<string, ProductChoice>();
  if (recipeIds.length === 0) return found;

  const placeholders = recipeIds.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT recipe_id, ingredient_id, ean, name, image_url,
              package_quantity, package_unit
         FROM recipe_ingredient_product
        WHERE household_id = ?
          AND recipe_id IN (${placeholders})`,
    )
    .bind(householdId, ...recipeIds)
    .all<OverrideRow>();

  for (const row of results) {
    found.set(overrideKey(row.recipe_id, row.ingredient_id), readChoice(row));
  }
  return found;
}

export function overrideKey(recipeId: number, ingredientId: number): string {
  return `${recipeId}:${ingredientId}`;
}

function readChoice(row: ProductRow): ProductChoice {
  // A half-filled size would be a number without a unit, which is worse than
  // none: it would quietly compare grams against millilitres.
  const sized = row.package_quantity !== null && row.package_unit !== null;
  return {
    ean: row.ean,
    name: row.name,
    imageUrl: row.image_url,
    packageQuantity: sized ? row.package_quantity : null,
    packageUnit: sized ? row.package_unit : null,
  };
}

// ------------------------------------------------------------------- writing

export interface ProductToSave {
  ean: string;
  name: string;
  imageUrl: string;
  packageQuantity: number | null;
  packageUnit: string | null;
}

/**
 * Add one product to an ingredient, or make it the only one.
 *
 * `replace` is what "Vaihda tuote" means: the household changed its mind about
 * what this ingredient is, and the sizes it used to know are no longer it.
 * `add` is "Lisää toinen pakkauskoko" — the same foodstuff in another packet,
 * which is the whole point of #161.
 */
export async function saveIngredientProduct(
  db: D1Database,
  ingredientId: number,
  product: ProductToSave,
  mode: "replace" | "add",
): Promise<void> {
  const statements = [];
  if (mode === "replace") {
    statements.push(
      db
        .prepare(`DELETE FROM ingredient_product WHERE ingredient_id = ?`)
        .bind(ingredientId),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO ingredient_product
           (ingredient_id, ean, name, image_url,
            package_quantity, package_unit, position)
         VALUES (?, ?, ?, ?, ?, ?,
                 (SELECT COALESCE(max(position), 0) + 1
                    FROM ingredient_product WHERE ingredient_id = ?))
         ON CONFLICT (ingredient_id, ean) DO UPDATE
            SET name = excluded.name,
                image_url = excluded.image_url,
                package_quantity = excluded.package_quantity,
                package_unit = excluded.package_unit`,
      )
      .bind(
        ingredientId,
        product.ean,
        product.name,
        product.imageUrl,
        product.packageQuantity,
        product.packageUnit,
        ingredientId,
      ),
  );
  await db.batch(statements);
}

export async function removeIngredientProduct(
  db: D1Database,
  ingredientId: number,
  ean: string,
): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM ingredient_product WHERE ingredient_id = ? AND ean = ?`)
    .bind(ingredientId, ean)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Pin one recipe's use of one ingredient to one product, for this household. */
export async function saveRecipeProduct(
  db: D1Database,
  householdId: number,
  recipeId: number,
  ingredientId: number,
  product: ProductToSave,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO recipe_ingredient_product
         (household_id, recipe_id, ingredient_id, ean, name, image_url,
          package_quantity, package_unit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (household_id, recipe_id, ingredient_id) DO UPDATE
          SET ean = excluded.ean,
              name = excluded.name,
              image_url = excluded.image_url,
              package_quantity = excluded.package_quantity,
              package_unit = excluded.package_unit`,
    )
    .bind(
      householdId,
      recipeId,
      ingredientId,
      product.ean,
      product.name,
      product.imageUrl,
      product.packageQuantity,
      product.packageUnit,
    )
    .run();
}

export async function removeRecipeProduct(
  db: D1Database,
  householdId: number,
  recipeId: number,
  ingredientId: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM recipe_ingredient_product
        WHERE household_id = ? AND recipe_id = ? AND ingredient_id = ?`,
    )
    .bind(householdId, recipeId, ingredientId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Fill in a package size for products stored before there was anywhere to put
 * one — every mapping #147 made, migrated across with an empty size.
 *
 * It runs at most once per product: the name is read, and whatever it says is
 * written down as data. A name that cannot be read is left alone and stays
 * unsized, so this never turns into "parse the name every time", which is the
 * thing #161 explicitly does not want.
 */
export async function backfillPackageSizes(
  db: D1Database,
  products: Iterable<ProductChoice>,
): Promise<void> {
  const statements = [];
  const done = new Set<string>();

  for (const product of products) {
    if (product.packageQuantity !== null || done.has(product.ean)) continue;
    const size = packageSizeFromName(product.name);
    if (size === null) continue;
    done.add(product.ean);
    product.packageQuantity = size.quantity;
    product.packageUnit = size.unit;
    statements.push(
      db
        .prepare(
          `UPDATE ingredient_product
              SET package_quantity = ?, package_unit = ?
            WHERE ean = ? AND package_quantity IS NULL`,
        )
        .bind(size.quantity, size.unit, product.ean),
    );
    statements.push(
      db
        .prepare(
          `UPDATE recipe_ingredient_product
              SET package_quantity = ?, package_unit = ?
            WHERE ean = ? AND package_quantity IS NULL`,
        )
        .bind(size.quantity, size.unit, product.ean),
    );
  }

  if (statements.length > 0) await db.batch(statements);
}
