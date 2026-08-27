import type { DraftIngredientRef, StepIngredientRef } from "./ingredient-refs.ts";
import { serializeStepRefs } from "./ingredient-refs.ts";
import { ingredientsFor } from "./ingredients.ts";
import type { Member } from "./members.ts";
import type { RecipePhase } from "./recipe-phase.ts";

/**
 * Saving a corrected draft, and editing a saved recipe. One D1 batch either
 * way, so a half-written recipe cannot exist.
 *
 * The approval gate lives here as well as on the screen: a line must resolve to
 * an ingredient the household has, or to a name a human approved. That rule is
 * what keeps "purjo" and "purjosipuli" from both appearing, so it is enforced
 * where it counts rather than only where it is convenient.
 *
 * A dish written in named parts becomes several recipes: the dish, and one
 * child recipe per part. See docs/adr/0002-a-part-is-a-recipe.md.
 */

export type LineIngredient =
  | { kind: "existing"; id: number }
  | { kind: "new"; name: string }
  // What an unanswered line looks like. Refused, never guessed.
  | { kind: "unanswered" };

export interface LineToSave {
  quantity: number | null;
  quantityMax: number | null;
  unit: string | null;
  altQuantity: number | null;
  altUnit: string | null;
  ingredient: LineIngredient;
  sourceLine: string;
  /** The named part this belongs to, or null for the dish itself. */
  section: string | null;
  phase: RecipePhase;
}

export interface StepToSave {
  text: string;
  section: string | null;
  phase: RecipePhase;
  /**
   * Ingredient mentions in `text`, pointing at this recipe's lines by their
   * index in `lines` (issue #120). Ingredient ids do not exist yet on an
   * import, so the index is the only identity a draft or a form can carry;
   * `childrenOf` turns it into one at the moment the ids are known.
   */
  refs: DraftIngredientRef[];
}

export interface RecipeToSave {
  title: string;
  yieldPortions: number | null;
  sourceText: string;
  sourceRoute: "pasted" | "photographed";
  structuredBy: string | null;
  steps: StepToSave[];
  lines: LineToSave[];
}

export class SaveRefused extends Error {}
export class StaleRecipe extends SaveRefused {}

/** A line paired with the ingredient it finally resolved to. */
interface ResolvedLine {
  line: LineToSave;
  ingredientId: number;
}

interface NewIngredient {
  id: number;
  name: string;
}

interface RecipeGuard {
  recipeId: number;
  householdId: number;
  writeToken: string;
}

export async function saveRecipe(
  db: D1Database,
  member: Member,
  recipe: RecipeToSave,
): Promise<number> {
  validateRecipe(recipe);
  const { newIngredients, lines } = await resolveIngredients(db, member, recipe);

  const parts = partNames(recipe);
  const reserved = new Set<number>();
  const recipeId = await unusedId(db, "recipe", reserved);
  const statements: D1PreparedStatement[] = [
    ...ingredientStatements(db, member, newIngredients),
    recipeRow(db, member, recipeId, recipe, {
      title: recipe.title.trim(),
      yieldPortions: recipe.yieldPortions,
      parentId: null,
      position: null,
    }),
    ...childrenOf(db, recipeId, lines, recipe.steps, null),
  ];

  // Each named part becomes a recipe of its own, hanging off the dish.
  for (const [index, name] of parts.entries()) {
    const partId = await unusedId(db, "recipe", reserved);
    statements.push(
      recipeRow(db, member, partId, recipe, {
        title: name,
        // A page almost never states a yield per part.
        yieldPortions: null,
        parentId: recipeId,
        position: index + 1,
      }),
      ...childrenOf(db, partId, lines, recipe.steps, name),
    );
  }

  await db.batch(statements);
  return recipeId;
}

/**
 * Edit a saved recipe. Its children are replaced wholesale rather than diffed —
 * positions shift when a line moves, and one batch keeps the recipe from ever
 * being half-rewritten.
 *
 * The submitted revision is optimistic locking. The update must still own the
 * same household row at the revision the editor opened. Every statement after
 * it is guarded by a unique token written by that update, so a deleted or
 * concurrently edited recipe cannot have another recipe's children replaced.
 *
 * source_text and source_route are not editable and are not touched here. Parts
 * are recipes of their own and are edited on their own screens, so this leaves
 * them alone too.
 */
export async function replaceRecipe(
  db: D1Database,
  member: Member,
  recipeId: number,
  expectedRevision: number,
  recipe: RecipeToSave,
): Promise<void> {
  validateRecipe(recipe);
  if (!Number.isSafeInteger(recipeId) || recipeId <= 0) {
    throw new StaleRecipe("Reseptiä ei enää ole.");
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new StaleRecipe("Resepti on muuttunut. Lataa uusin versio.");
  }

  const { newIngredients, lines } = await resolveIngredients(db, member, recipe);
  const writeToken = crypto.randomUUID();
  const guard: RecipeGuard = {
    recipeId,
    householdId: member.householdId,
    writeToken,
  };

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE recipe
            SET title = ?, yield_portions = ?, revision = revision + 1,
                edit_token = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), updated_by = ?
          WHERE id = ? AND household_id = ? AND revision = ?`,
      )
      .bind(
        recipe.title.trim(),
        recipe.yieldPortions,
        writeToken,
        member.id,
        recipeId,
        member.householdId,
        expectedRevision,
      ),
    ...ingredientStatements(db, member, newIngredients, guard),
    guardedDelete(db, "recipe_step", recipeId, guard),
    guardedDelete(db, "ingredient_line", recipeId, guard),
    ...childrenOf(db, recipeId, lines, recipe.steps, null, guard),
  ];

  const results = await db.batch(statements);
  if ((results[0]?.meta.changes ?? 0) === 0) {
    throw new StaleRecipe(
      "Resepti on muuttunut tai poistettu. Tarkista uusin versio ennen tallennusta.",
    );
  }
}

/** The dish's parts, in the order they first appear on the page. */
function partNames(recipe: RecipeToSave): string[] {
  const names: string[] = [];

  for (const item of [...recipe.lines, ...recipe.steps]) {
    const name = item.section?.trim();
    if (!name) continue;
    if (!names.includes(name)) names.push(name);
  }

  return names;
}

function recipeRow(
  db: D1Database,
  member: Member,
  id: number,
  recipe: RecipeToSave,
  as: {
    title: string;
    yieldPortions: number | null;
    parentId: number | null;
    position: number | null;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO recipe
         (id, household_id, title, yield_portions, source_text, source_route,
          structured_by, structured_at, created_at, created_by,
          updated_at, updated_by, parent_id, part_position, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'),
               strftime('%Y-%m-%d %H:%M:%f', 'now'), ?,
               strftime('%Y-%m-%d %H:%M:%f', 'now'), ?, ?, ?, 0)`,
    )
    .bind(
      id,
      member.householdId,
      as.title,
      as.yieldPortions,
      // A part came from the same page, so it keeps the same record of arrival.
      recipe.sourceText,
      recipe.sourceRoute,
      recipe.structuredBy,
      member.id,
      member.id,
      as.parentId,
      as.position,
    );
}

/** The lines and steps belonging to one recipe — the dish, or one of its parts. */
function childrenOf(
  db: D1Database,
  recipeId: number,
  lines: ResolvedLine[],
  steps: StepToSave[],
  section: string | null,
  guard?: RecipeGuard,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  const belongs = (name: string | null) => (name?.trim() || null) === section;
  const phaseFor = (phase: RecipePhase) => section === null ? phase : null;

  // This recipe row's own lines, in the order they are about to be written, so
  // a line's position is its place in here plus one. A step's reference is
  // stored against that position, which is what tells two mentions of the same
  // ingredient apart later.
  const ownLines = lines.filter((entry) => belongs(entry.line.section));

  steps
    .filter((step) => belongs(step.section) && step.text.trim() !== "")
    .forEach((step, index) => {
      const refs = serializeStepRefs(resolveStepRefs(step, lines, ownLines));

      if (guard === undefined) {
        statements.push(
          db
            .prepare(
              `INSERT INTO recipe_step (recipe_id, position, text, phase, ingredient_refs)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .bind(
              recipeId,
              index + 1,
              step.text.trim(),
              phaseFor(step.phase),
              refs,
            ),
        );
      } else {
        statements.push(
          db
            .prepare(
              `INSERT INTO recipe_step (recipe_id, position, text, phase, ingredient_refs)
               SELECT ?, ?, ?, ?, ?
                WHERE EXISTS (
                  SELECT 1 FROM recipe
                   WHERE id = ? AND household_id = ? AND edit_token = ?
                )`,
            )
            .bind(
              recipeId,
              index + 1,
              step.text.trim(),
              phaseFor(step.phase),
              refs,
              guard.recipeId,
              guard.householdId,
              guard.writeToken,
            ),
        );
      }
    });

  ownLines
    .forEach((entry, index) => {
      const line = entry.line;
      if (guard === undefined) {
        statements.push(
          db
            .prepare(
              `INSERT INTO ingredient_line
                 (recipe_id, position, quantity, quantity_max, unit,
                  alt_quantity, alt_unit, ingredient_id, source_line, phase)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              recipeId,
              index + 1,
              line.quantity,
              line.quantityMax,
              line.unit,
              line.altQuantity,
              line.altUnit,
              entry.ingredientId,
              line.sourceLine,
              phaseFor(line.phase),
            ),
        );
      } else {
        statements.push(
          db
            .prepare(
              `INSERT INTO ingredient_line
                 (recipe_id, position, quantity, quantity_max, unit,
                  alt_quantity, alt_unit, ingredient_id, source_line, phase)
               SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                WHERE EXISTS (
                  SELECT 1 FROM recipe
                   WHERE id = ? AND household_id = ? AND edit_token = ?
                )`,
            )
            .bind(
              recipeId,
              index + 1,
              line.quantity,
              line.quantityMax,
              line.unit,
              line.altQuantity,
              line.altUnit,
              entry.ingredientId,
              line.sourceLine,
              phaseFor(line.phase),
              guard.recipeId,
              guard.householdId,
              guard.writeToken,
            ),
        );
      }
    });

  return statements;
}

/**
 * Turn a step's line-index references into ingredient-id ones, dropping any
 * that cannot mean anything here.
 *
 * A dish written in parts becomes several recipe rows, and a step is stored
 * with the row its own part became. A reference from that step to a line that
 * ended up in a *different* row would name an ingredient the reader cannot see
 * amounts for on this screen, so it is dropped rather than stored — the same
 * "leave it unlinked rather than link the wrong thing" rule the resolver
 * follows on the way out.
 *
 * A reference is also dropped when the row it points at no longer holds the
 * ingredient the reference was made against. An index says where a line sits on
 * the form, not which ingredient it is, and repointing a row pulls those two
 * apart: a member who changes a line from tomato to paprika and leaves the step
 * saying "tomaatit" must not end up with paprika's amount hiding behind that
 * word. Renaming an ingredient keeps its id and so keeps its mentions, which is
 * the right half of the same rule.
 *
 * `expectedIngredientId` is null on an import, where no id existed to expect,
 * and such a reference is never dropped on this account.
 *
 * What gets stored is the ingredient **and** the position the line will hold,
 * because a recipe may list one ingredient twice — salt at two stages, with two
 * amounts — and an ingredient id alone would let a mention of the second one
 * reveal the first one's figure.
 *
 * Two mentions of the same ingredient in one step are both kept: they are
 * different words in different places, and each toggles on its own.
 */
function resolveStepRefs(
  step: StepToSave,
  lines: ResolvedLine[],
  ownLines: ResolvedLine[],
): StepIngredientRef[] {
  const refs: StepIngredientRef[] = [];

  for (const ref of step.refs) {
    const target = lines[ref.lineIndex];
    if (target === undefined) continue;

    // Where this line will sit once written. Not being in `ownLines` at all is
    // the cross-part case: the line went to a different recipe row than the
    // step did.
    const position = ownLines.indexOf(target) + 1;
    if (position === 0) continue;

    if (
      ref.expectedIngredientId !== null &&
      ref.expectedIngredientId !== target.ingredientId
    ) {
      continue;
    }

    refs.push({
      ingredientId: target.ingredientId,
      linePosition: position,
      matchedText: ref.matchedText,
      approxPosition: ref.approxPosition,
    });
  }

  return refs;
}

function ingredientStatements(
  db: D1Database,
  member: Member,
  ingredients: NewIngredient[],
  guard?: RecipeGuard,
): D1PreparedStatement[] {
  return ingredients.map((ingredient) => {
    if (guard === undefined) {
      return db
        .prepare(
          `INSERT INTO ingredient (id, household_id, name, created_by)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(ingredient.id, member.householdId, ingredient.name, member.id);
    }

    return db
      .prepare(
        `INSERT INTO ingredient (id, household_id, name, created_by)
         SELECT ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM recipe
             WHERE id = ? AND household_id = ? AND edit_token = ?
          )`,
      )
      .bind(
        ingredient.id,
        member.householdId,
        ingredient.name,
        member.id,
        guard.recipeId,
        guard.householdId,
        guard.writeToken,
      );
  });
}

function guardedDelete(
  db: D1Database,
  table: "recipe_step" | "ingredient_line",
  recipeId: number,
  guard: RecipeGuard,
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM ${table}
        WHERE recipe_id = ?
          AND EXISTS (
            SELECT 1 FROM recipe
             WHERE id = ? AND household_id = ? AND edit_token = ?
          )`,
    )
    .bind(
      recipeId,
      guard.recipeId,
      guard.householdId,
      guard.writeToken,
    );
}

/**
 * Validate the lines and work out which ingredient each one means, allocating
 * collision-checked ids for genuinely new names. Shared by saving and editing,
 * so the approval gate cannot be enforced in one and skipped in the other.
 */
async function resolveIngredients(
  db: D1Database,
  member: Member,
  recipe: RecipeToSave,
): Promise<{ newIngredients: NewIngredient[]; lines: ResolvedLine[] }> {
  const existing = await ingredientsFor(db, member.householdId);
  const byName = new Map(
    existing.map((ingredient) => [
      ingredient.name.toLocaleLowerCase("fi"),
      ingredient.id,
    ]),
  );
  const knownIds = new Set(existing.map((ingredient) => ingredient.id));
  const reserved = new Set<number>();

  const newIngredients: NewIngredient[] = [];
  const lines: ResolvedLine[] = [];

  for (const line of recipe.lines) {
    const ingredient = line.ingredient;

    if (ingredient.kind === "existing") {
      if (!knownIds.has(ingredient.id)) throw new SaveRefused("Tuntematon aines.");
      lines.push({ line, ingredientId: ingredient.id });
      continue;
    }

    if (ingredient.kind === "new") {
      const name = ingredient.name.trim();
      if (name === "") throw new SaveRefused("Uudella aineksella pitää olla nimi.");

      // Approving a name the household already has is a match, not a duplicate.
      // This is the drift the gate exists to prevent, caught one step later.
      const key = name.toLocaleLowerCase("fi");
      const already = byName.get(key);
      if (already !== undefined) {
        lines.push({ line, ingredientId: already });
        continue;
      }

      const id = await unusedId(db, "ingredient", reserved);
      newIngredients.push({ id, name });
      byName.set(key, id);
      knownIds.add(id);
      lines.push({ line, ingredientId: id });
      continue;
    }

    throw new SaveRefused("Jokaiselle uudelle ainekselle pitää vastata.");
  }

  return { newIngredients, lines };
}

export function validateRecipe(recipe: RecipeToSave): void {
  if (recipe.title.trim() === "") {
    throw new SaveRefused("Reseptillä pitää olla nimi.");
  }
  if (
    recipe.yieldPortions !== null &&
    (!Number.isSafeInteger(recipe.yieldPortions) || recipe.yieldPortions <= 0)
  ) {
    throw new SaveRefused("Annosmäärän pitää olla positiivinen kokonaisluku.");
  }
  if (recipe.lines.length === 0) {
    throw new SaveRefused("Reseptissä pitää olla ainakin yksi aines.");
  }
  if (recipe.lines.some((line) => line.ingredient.kind === "unanswered")) {
    throw new SaveRefused("Jokaiselle uudelle ainekselle pitää vastata.");
  }

  for (const line of recipe.lines) {
    for (const amount of [line.quantity, line.quantityMax, line.altQuantity]) {
      if (amount !== null && (!Number.isFinite(amount) || amount <= 0)) {
        throw new SaveRefused("Ainesmäärien pitää olla suurempia kuin nolla.");
      }
    }
    if (line.quantityMax !== null && line.quantity === null) {
      throw new SaveRefused("Välin yläpää tarvitsee myös alarajan.");
    }
    if (
      line.quantity !== null &&
      line.quantityMax !== null &&
      line.quantityMax < line.quantity
    ) {
      throw new SaveRefused("Välin yläpää ei voi olla alarajaa pienempi.");
    }
    if ((line.altQuantity === null) !== (line.altUnit === null)) {
      throw new SaveRefused("Toinen mitta tarvitsee sekä määrän että yksikön.");
    }
    if (line.altQuantity !== null && line.quantity === null) {
      throw new SaveRefused("Toinen mitta tarvitsee myös ensimmäisen määrän.");
    }
  }
}

/**
 * A random, collision-checked 52-bit id. Unlike max(id)+1 it is not reused after
 * deleting the highest row, which is what makes stale form ids harmless.
 */
async function unusedId(
  db: D1Database,
  table: "recipe" | "ingredient",
  reserved: Set<number>,
): Promise<number> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const words = crypto.getRandomValues(new Uint32Array(2));
    const id = (words[0]! & 0x000fffff) * 0x100000000 + words[1]!;
    if (!Number.isSafeInteger(id) || id <= 0 || reserved.has(id)) continue;

    const row = await db
      .prepare(`SELECT 1 AS found FROM ${table} WHERE id = ?`)
      .bind(id)
      .first<{ found: number }>();
    if (row === null) {
      reserved.add(id);
      return id;
    }
  }

  throw new Error(`Could not allocate an id for ${table}.`);
}
