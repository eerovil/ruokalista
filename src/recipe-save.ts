import type { DraftIngredientRef, StepIngredientRef } from "./ingredient-refs.ts";
import { serializeStepRefs } from "./ingredient-refs.ts";
import { ingredientsFor } from "./ingredients.ts";
import type { Member } from "./members.ts";
import {
  groupsAcrossScopes,
  normalizeGroups,
  type AlternativeGroup,
} from "./alternatives.ts";
import { loadVocabulary } from "./categories.ts";
import { phaseBucket, type RecipePhase } from "./recipe-phase.ts";

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
  /**
   * The alternative group this line is an option in, or null (#183).
   *
   * Submitted as written and renumbered on the way in — `childrenOf` runs the
   * group numbers through `normalizeGroups` per recipe row, so a group of one
   * dissolves and the rest come out 1, 2, 3 whatever a member typed.
   */
  alternativeGroup: AlternativeGroup;
  /**
   * Which row of the draft or form this line came from.
   *
   * A step's mention points at a line by this number, and it has to be the
   * row's own identity rather than a place in the array: `readLines` drops
   * removed rows and sorts what is left by the position boxes, so a member who
   * reorders or removes one line on the review screen moves every later line's
   * array index out from under the mentions pointing at them.
   */
  formIndex: number;
}

export interface StepToSave {
  text: string;
  section: string | null;
  phase: RecipePhase;
  /**
   * Ingredient mentions in `text`, pointing at this recipe's lines by their
   * `formIndex` (issue #120). Ingredient ids do not exist yet on an import, so
   * the row is the only identity a draft can carry; `childrenOf` turns it into
   * one at the moment the ids are known.
   */
  refs: DraftIngredientRef[];
}

export interface RecipeToSave {
  title: string;
  yieldPortions: number | null;
  sourceText: string;
  sourceRoute: "pasted" | "photographed" | "linked";
  /**
   * The web address this was read from, for a linked import (#192). Absent on
   * every other route, and on a recipe saved before that route existed.
   */
  sourceUrl?: string | null;
  structuredBy: string | null;
  steps: StepToSave[];
  lines: LineToSave[];
  /**
   * What kind of food this is (#196), as slugs from `src/categories.ts`.
   *
   * The dish's own, and only the dish's: a part is a recipe row (ADR-0002) but
   * it is not a thing anybody browses for, so `saveRecipe` writes these on the
   * parent and gives each part none.
   */
  categories: string[];
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
  await assertKnownCategories(db, recipe.categories);
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
    ...categoryStatements(db, recipeId, recipe.categories),
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
 * them alone too — but whether there are any is still this call's business,
 * because a dish whose ingredients all live on its parts has none of its own
 * and must still be saveable (issue #184). The caller says so rather than this
 * function counting them: the editor has already loaded the recipe's parts, and
 * a second query would only ask the same question again.
 */
export async function replaceRecipe(
  db: D1Database,
  member: Member,
  recipeId: number,
  expectedRevision: number,
  recipe: RecipeToSave,
  options: ValidateOptions = {},
): Promise<void> {
  validateRecipe(recipe, options);
  await assertKnownCategories(db, recipe.categories);
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
    guardedDelete(db, "recipe_category", recipeId, guard),
    ...childrenOf(db, recipeId, lines, recipe.steps, null, guard),
    ...categoryStatements(db, recipeId, recipe.categories, guard),
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
          source_url, structured_by, structured_at, created_at, created_by,
          updated_at, updated_by, parent_id, part_position, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'),
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
      recipe.sourceUrl ?? null,
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

  // Keep references inside this recipe row. A step names an ingredient, so
  // duplicate lines for that ingredient deliberately share the same reference.
  // Group numbers mean something only inside one recipe row and one
  // cooking-order section: a part is a recipe of its own (ADR-0002), and a
  // multipart dish's before-parts and after-parts content is drawn apart. So
  // options are renumbered per bucket here, by the same question the cooking
  // view and the shopping list ask (#183). `validateRecipe` has already
  // refused a group that spans two, so nothing reaching this line is dissolved
  // without the member being told.
  const ownLines = normalizeGroups(
    lines.filter((entry) => belongs(entry.line.section)).map((entry) => ({
      ...entry,
      alternativeGroup: entry.line.alternativeGroup,
    })),
    (entry) => phaseBucket(phaseFor(entry.line.phase)),
  );

  steps
    .filter((step) => belongs(step.section) && step.text.trim() !== "")
    .forEach((step, index) => {
      const refs = serializeStepRefs(resolveStepRefs(step, ownLines));

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
                  alt_quantity, alt_unit, ingredient_id, source_line, phase,
                  alternative_group)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
              entry.alternativeGroup,
            ),
        );
      } else {
        statements.push(
          db
            .prepare(
              `INSERT INTO ingredient_line
                 (recipe_id, position, quantity, quantity_max, unit,
                  alt_quantity, alt_unit, ingredient_id, source_line, phase,
                  alternative_group)
               SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
              entry.alternativeGroup,
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
 * A mention names an **ingredient**, so a reference the editor rebuilt is asked
 * about the ingredient and not about the row it happened to be anchored to.
 * The editor has to hang a saved mention on some row to put it in the form, and
 * with a duplicated ingredient it picks the first one — but that row is only a
 * handle. If a member repoints it and another row still carries the ingredient,
 * the mention is still true and the screen still has an amount to reveal, so it
 * survives. It goes only when this step's own recipe row has no line with that
 * ingredient left at all.
 *
 * That covers the repointing case the guard was added for: change the only
 * tomato line to paprika and a step saying "tomaatit" has nothing to name, so
 * it goes back to being plain text rather than revealing paprika's amount.
 * Renaming an ingredient keeps its id and so keeps its mentions, which is the
 * right half of the same rule.
 *
 * A reference from an import has no `expectedIngredientId` — no id existed yet
 * — so it is resolved through the row it points at, matched by `formIndex`
 * rather than by array position, since `readLines` has already dropped removed
 * rows and re-sorted the rest by their position boxes.
 *
 * Two mentions of the same ingredient in one step are both kept: they are
 * different words in different places, and each toggles on its own.
 */
function resolveStepRefs(
  step: StepToSave,
  ownLines: ResolvedLine[],
): StepIngredientRef[] {
  const refs: StepIngredientRef[] = [];

  for (const ref of step.refs) {
    const ingredientId = ingredientForRef(ref, ownLines);
    if (ingredientId === null) continue;

    refs.push({
      ingredientId,
      matchedText: ref.matchedText,
      approxPosition: ref.approxPosition,
    });
  }

  return refs;
}

/**
 * The ingredient a reference names once the form has been read, or null when it
 * no longer names one this step can show.
 *
 * `ownLines` is this step's own recipe row, which is what makes the cross-part
 * rule fall out rather than needing its own check: a line that went to a
 * different part of the dish is not in here, so a reference to it resolves to
 * nothing.
 */
function ingredientForRef(
  ref: DraftIngredientRef,
  ownLines: ResolvedLine[],
): number | null {
  if (ref.expectedIngredientId !== null) {
    const stillHere = ownLines.some(
      (entry) => entry.ingredientId === ref.expectedIngredientId,
    );
    return stillHere ? ref.expectedIngredientId : null;
  }

  const target = ownLines.find(
    (entry) => entry.line.formIndex === ref.lineIndex,
  );
  return target?.ingredientId ?? null;
}

function ingredientStatements(
  db: D1Database,
  member: Member,
  ingredients: NewIngredient[],
  guard?: RecipeGuard,
): D1PreparedStatement[] {
  return ingredients.map((ingredient) => {
    // No household_id since #143: the dictionary is global. Coining a name is
    // still an ordinary member's job — it is renaming and merging an existing
    // one that became an admin operation, because those reach every household.
    if (guard === undefined) {
      return db
        .prepare(
          `INSERT INTO ingredient (id, name, created_by) VALUES (?, ?, ?)`,
        )
        .bind(ingredient.id, ingredient.name, member.id);
    }

    return db
      .prepare(
        `INSERT INTO ingredient (id, name, created_by)
         SELECT ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM recipe
             WHERE id = ? AND household_id = ? AND edit_token = ?
          )`,
      )
      .bind(
        ingredient.id,
        ingredient.name,
        member.id,
        guard.recipeId,
        guard.householdId,
        guard.writeToken,
      );
  });
}

/**
 * A recipe's categories (#196), replaced wholesale like its other children.
 *
 * `readCategories` has already dropped anything outside the vocabulary and
 * collapsed duplicates, so nothing here can collide on the table's
 * `(recipe_id, category)` key.
 */
function categoryStatements(
  db: D1Database,
  recipeId: number,
  categories: readonly string[],
  guard?: RecipeGuard,
): D1PreparedStatement[] {
  return categories.map((category) => {
    if (guard === undefined) {
      return db
        .prepare(`INSERT INTO recipe_category (recipe_id, category) VALUES (?, ?)`)
        .bind(recipeId, category);
    }

    return db
      .prepare(
        `INSERT INTO recipe_category (recipe_id, category)
         SELECT ?, ?
          WHERE EXISTS (
            SELECT 1 FROM recipe
             WHERE id = ? AND household_id = ? AND edit_token = ?
          )`,
      )
      .bind(
        recipeId,
        category,
        guard.recipeId,
        guard.householdId,
        guard.writeToken,
      );
  });
}

function guardedDelete(
  db: D1Database,
  table: "recipe_step" | "ingredient_line" | "recipe_category",
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

export interface ValidateOptions {
  /**
   * Whether this recipe already has parts of its own (issue #184).
   *
   * A dish written entirely in named parts keeps nothing but a title, its
   * method and its parts — every ingredient sits on a part, which is a recipe
   * row of its own (ADR-0002). Such a dish is not empty, so the one-ingredient
   * rule below does not apply to it.
   *
   * False on an import, and rightly so: there the parts do not exist yet and a
   * draft's `lines` carries every part's lines along with the dish's, so an
   * empty array there really is an empty recipe.
   */
  hasParts?: boolean;
}

/**
 * Where a line will end up once saved: which recipe row, and which section of
 * the cooking view. This is the boundary an alternative group may not cross.
 *
 * A named section becomes a recipe row of its own and its content carries no
 * phase, which is why the phase is only part of the answer for the dish's own
 * lines — exactly what `childrenOf`'s `phaseFor` does when it writes them.
 */
function savedScope(line: LineToSave): string {
  const section = line.section?.trim() ?? "";
  return section === ""
    ? `dish ${phaseBucket(line.phase)}`
    : `part ${section}`;
}

/**
 * Every category has to be one the vocabulary still has (#196, #199).
 *
 * Enforced here as well as on the form, for the same reason the ingredient gate
 * is: an AgentDeck bundle (#82) reaches these functions without passing a
 * screen, and a category nobody can filter by is not worth storing. It is a
 * query rather than a constant since #199, so it sits beside the write instead
 * of inside the synchronous `validateRecipe` — and it costs nothing at all for
 * the recipes that carry no category, which is most of them.
 */
async function assertKnownCategories(
  db: D1Database,
  categories: readonly string[],
): Promise<void> {
  if (categories.length === 0) return;
  const vocabulary = await loadVocabulary(db);
  if (categories.some((slug) => !vocabulary.has(slug))) {
    throw new SaveRefused("Tuntematon kategoria.");
  }
}

export function validateRecipe(
  recipe: RecipeToSave,
  options: ValidateOptions = {},
): void {
  if (recipe.title.trim() === "") {
    throw new SaveRefused("Reseptillä pitää olla nimi.");
  }
  if (
    recipe.yieldPortions !== null &&
    (!Number.isSafeInteger(recipe.yieldPortions) || recipe.yieldPortions <= 0)
  ) {
    throw new SaveRefused("Annosmäärän pitää olla positiivinen kokonaisluku.");
  }
  if (recipe.lines.length === 0 && options.hasParts !== true) {
    throw new SaveRefused("Reseptissä pitää olla ainakin yksi aines tai osa.");
  }
  if (recipe.lines.some((line) => line.ingredient.kind === "unanswered")) {
    throw new SaveRefused("Jokaiselle uudelle ainekselle pitää vastata.");
  }
  // Both halves of a choice are used at the same moment, so they belong to the
  // same part and the same cooking-order section (#183). Letting one span two
  // is the input that made the cooking view and the shopping list disagree:
  // the screen drew two lone lines and the list still bought only one of them.
  if (groupsAcrossScopes(recipe.lines, savedScope).length > 0) {
    throw new SaveRefused(
      "Saman vaihtoehtoryhmän rivien pitää olla samassa osassa ja vaiheessa.",
    );
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
