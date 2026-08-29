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
  options: ValidateOptions = {},
): Promise<number> {
  validateRecipe(recipe, options);
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

  await batchWithCategories(db, statements, recipe.categories);
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
 * source_text and source_route are not editable and are not touched here.
 *
 * **A part is written only when the submitted recipe names one.** The ordinary
 * editor renders no part field, so every line it submits carries a null
 * section, no part is named, and the dish's parts are left exactly as they were
 * — which is the behaviour this function has always had. A prompt edit (#208)
 * does render the field, because the whole dish is what the model was shown and
 * "lisää kastikkeeseen puuttuvat ainekset" is a change to a part; a section it
 * names is matched to one of `options.parts` by title and that part's contents
 * are replaced under the same lock, and a name that matches nothing becomes a
 * new part of this dish. A part the submission stops naming is **left alone**
 * rather than deleted: it is a recipe row somebody may have on a menu, and
 * silently taking it away is not something a proposal gets to do.
 *
 * Whether there are parts at all is the caller's to say rather than this
 * function's to count, because a dish whose ingredients all live on its parts
 * has none of its own and must still be saveable (issue #184) — and the caller
 * has already loaded them.
 *
 * **Every part this save rewrites is locked too.** The dish's own revision does
 * not move when one of its parts is edited — a part is a recipe row with its
 * own editor screen (ADR-0002) — so locking only the dish would let a proposal
 * read before somebody fixed the juustokastike overwrite that fix on the way
 * in. Each part the submission names is therefore checked against the revision
 * the form saw, in the very statement that mints the write token every other
 * statement here is guarded by. One part having moved thus refuses the whole
 * batch, dish included: there is no half-saved outcome to explain.
 */
export async function replaceRecipe(
  db: D1Database,
  member: Member,
  recipeId: number,
  expectedRevision: number,
  recipe: RecipeToSave,
  options: ReplaceOptions = {},
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

  // Built first, because what it decides to rewrite is what the dish's own
  // update below has to hold still.
  const parts = await partStatements(
    db,
    member,
    recipeId,
    recipe,
    lines,
    options,
    guard,
  );

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE recipe
            SET title = ?, yield_portions = ?, revision = revision + 1,
                edit_token = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), updated_by = ?
          WHERE id = ? AND household_id = ? AND revision = ?
            ${categoryLock(options.expectedCategories)}${partLock(parts.locked)}`,
      )
      .bind(
        recipe.title.trim(),
        recipe.yieldPortions,
        writeToken,
        member.id,
        recipeId,
        member.householdId,
        expectedRevision,
        ...categoryLockValues(options.expectedCategories),
        ...partLockValues(recipeId, member.householdId, parts.locked),
      ),
    ...ingredientStatements(db, member, newIngredients, guard),
    guardedDelete(db, "recipe_step", recipeId, guard),
    guardedDelete(db, "ingredient_line", recipeId, guard),
    guardedDelete(db, "recipe_category", recipeId, guard),
    ...childrenOf(db, recipeId, lines, recipe.steps, null, guard),
    ...categoryStatements(db, recipeId, recipe.categories, guard),
    ...parts.statements,
  ];

  const results = await batchWithCategories(db, statements, recipe.categories);
  if ((results[0]?.meta.changes ?? 0) === 0) {
    throw new StaleRecipe(
      await staleMessage(db, member, recipeId, expectedRevision, parts.locked),
    );
  }
}

/** What the dish's own update says when it turns out not to have happened. */
const DISH_MOVED =
  "Resepti on muuttunut tai poistettu. Tarkista uusin versio ennen tallennusta.";
const PART_MOVED =
  "Reseptin osa on muuttunut tai poistettu sen jälkeen kun avasit tämän. Tarkista uusin versio ennen tallennusta.";

/**
 * Which half of the lock refused, so the member is told the true thing.
 *
 * "The recipe changed" is a confusing thing to read when the recipe on screen
 * is exactly as you left it and what actually moved is its sauce. One extra
 * query, only ever on the refusal path, buys the sentence that sends somebody
 * to the right screen.
 */
async function staleMessage(
  db: D1Database,
  member: Member,
  recipeId: number,
  expectedRevision: number,
  locked: readonly ExpectedPart[],
): Promise<string> {
  if (locked.length === 0) return DISH_MOVED;

  // Nothing was written, so the dish still reads as it did a moment ago.
  const dish = await db
    .prepare(
      `SELECT 1 FROM recipe WHERE id = ? AND household_id = ? AND revision = ?`,
    )
    .bind(recipeId, member.householdId, expectedRevision)
    .first();

  return dish === null ? DISH_MOVED : PART_MOVED;
}

/**
 * The extra condition that makes the dish's update stand for the whole tree:
 * every part being rewritten is still a child of this dish, in this household,
 * at exactly the revision the form saw.
 *
 * It hangs off the dish's own `UPDATE` rather than off each part's, because
 * that update is what writes the token the rest of the batch is guarded by. A
 * per-part check would leave the dish rewritten and one part not.
 */
function partLock(locked: readonly ExpectedPart[]): string {
  if (locked.length === 0) return "";

  const matches = locked
    .map(() => "(part.id = ? AND part.revision = ?)")
    .join(" OR ");

  return ` AND (
              SELECT count(*) FROM recipe AS part
               WHERE part.parent_id = ? AND part.household_id = ?
                 AND (${matches})
            ) = ${locked.length}`;
}

function partLockValues(
  recipeId: number,
  householdId: number,
  locked: readonly ExpectedPart[],
): unknown[] {
  if (locked.length === 0) return [];
  return [
    recipeId,
    householdId,
    ...locked.flatMap((part) => [part.id, part.revision]),
  ];
}

/** Hold the category set still in the same write that locks the recipe row. */
function categoryLock(expected: readonly string[] | undefined): string {
  if (expected === undefined) return "";
  const present = expected
    .map(() => `AND EXISTS (
              SELECT 1 FROM recipe_category AS expected_category
               WHERE expected_category.recipe_id = recipe.id
                 AND expected_category.category = ?
            )`)
    .join("\n");
  return `AND (
              SELECT count(*) FROM recipe_category AS current_category
               WHERE current_category.recipe_id = recipe.id
            ) = ?
            ${present}`;
}

function categoryLockValues(expected: readonly string[] | undefined): unknown[] {
  return expected === undefined ? [] : [expected.length, ...expected];
}

/** What one submitted edit does to the dish's parts. */
interface PartPlan {
  statements: D1PreparedStatement[];
  /**
   * The existing parts being rewritten, at the revision the form saw them. The
   * dish's own update holds all of these still, or nothing is written at all.
   */
  locked: ExpectedPart[];
}

/** The same case-insensitive Finnish comparison the ingredient gate uses. */
function fold(title: string): string {
  return title.trim().toLocaleLowerCase("fi");
}

/**
 * The statements that write the parts a submitted edit names, and nothing else.
 *
 * A named section is matched by title against the parts the **form** saw, not
 * against the parts loaded a moment ago, because the proposal the member
 * reviewed was written against the former. That distinction is the whole point:
 * matching against what is there now would happily pour a proposal read ten
 * minutes ago over a part somebody has edited since, and would just as happily
 * fork a second `Juustokastike` when the first one has been deleted.
 *
 * So each name is one of three things:
 *
 * - the form expected a part by that name and it is still here → its contents
 *   are replaced, and its revision goes into `locked`;
 * - the form expected one and it has gone → refused, because the content being
 *   saved is about a row that no longer exists;
 * - the form expected none → a new part, unless the dish has since grown one
 *   under that name, which is refused rather than silently merged into.
 *
 * Everything here hangs off the *parent's* write token, so the whole tree is
 * written only if the lock on the dish — and, through it, on every part in
 * `locked` — held. A concurrently edited dish leaves its parts untouched rather
 * than half-rewritten.
 */
async function partStatements(
  db: D1Database,
  member: Member,
  recipeId: number,
  recipe: RecipeToSave,
  lines: ResolvedLine[],
  options: ReplaceOptions,
  guard: RecipeGuard,
): Promise<PartPlan> {
  const names = partNames(recipe);
  if (names.length === 0) return { statements: [], locked: [] };

  const expected = new Map(
    (options.expectedParts ?? []).map((part) => [fold(part.title), part]),
  );
  const present = options.parts ?? [];
  const byTitle = new Map(present.map((part) => [fold(part.title), part]));
  const byId = new Map(present.map((part) => [part.id, part]));

  const reserved = new Set<number>();
  const statements: D1PreparedStatement[] = [];
  const locked: ExpectedPart[] = [];

  for (const [index, name] of names.entries()) {
    const want = expected.get(fold(name));

    if (want === undefined) {
      // Nothing was expected here, so this is a new part — unless the dish has
      // grown one under that name in the meantime, which is somebody else's
      // work and not ours to write over.
      if (byTitle.has(fold(name))) throw new StaleRecipe(PART_MOVED);

      const partId = await unusedId(db, "recipe", reserved);
      statements.push(
        recipeRow(
          db,
          member,
          partId,
          recipe,
          { title: name, yieldPortions: null, parentId: recipeId, position: index + 1 },
          guard,
        ),
        ...childrenOf(db, partId, lines, recipe.steps, name, guard),
      );
      continue;
    }

    // Matched by id rather than by title: a part renamed since the form was
    // rendered is the same row, and the revision check below is what decides
    // whether writing to it is still honest.
    const part = byId.get(want.id);
    if (part === undefined) throw new StaleRecipe(PART_MOVED);

    // Two sections differing only in case fold to the same part, so the same
    // row can be named twice. It is one lock either way — counting it twice
    // would refuse a save that is perfectly current.
    if (!locked.some((already) => already.id === want.id)) locked.push(want);

    statements.push(
      // The title is rewritten from the section as submitted, so a part whose
      // name only differs in case settles on what is on the screen. `parent_id`
      // in the WHERE is what stops an id from another dish being touched at all.
      db
        .prepare(
          `UPDATE recipe
              SET title = ?, part_position = ?, revision = revision + 1,
                  updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), updated_by = ?
            WHERE id = ? AND household_id = ? AND parent_id = ?
              AND EXISTS (
                SELECT 1 FROM recipe AS dish
                 WHERE dish.id = ? AND dish.household_id = ? AND dish.edit_token = ?
              )`,
        )
        .bind(
          name,
          index + 1,
          member.id,
          part.id,
          member.householdId,
          recipeId,
          guard.recipeId,
          guard.householdId,
          guard.writeToken,
        ),
      guardedDelete(db, "recipe_step", part.id, guard),
      guardedDelete(db, "ingredient_line", part.id, guard),
      ...childrenOf(db, part.id, lines, recipe.steps, name, guard),
    );
  }

  return { statements, locked };
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
  guard?: RecipeGuard,
): D1PreparedStatement {
  const columns = `(id, household_id, title, yield_portions, source_text, source_route,
          source_url, structured_by, structured_at, created_at, created_by,
          updated_at, updated_by, parent_id, part_position, revision)`;
  const values = `?, ?, ?, ?, ?, ?, ?, ?, datetime('now'),
               strftime('%Y-%m-%d %H:%M:%f', 'now'), ?,
               strftime('%Y-%m-%d %H:%M:%f', 'now'), ?, ?, ?, 0`;

  const statement =
    guard === undefined
      ? db.prepare(`INSERT INTO recipe ${columns} VALUES (${values})`)
      : db.prepare(
          `INSERT INTO recipe ${columns}
           SELECT ${values}
            WHERE EXISTS (
              SELECT 1 FROM recipe AS dish
               WHERE dish.id = ? AND dish.household_id = ? AND dish.edit_token = ?
            )`,
        );

  const bound = statement
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
      ...(guard === undefined
        ? []
        : [guard.recipeId, guard.householdId, guard.writeToken]),
    );

  return bound;
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
 * `Vocabulary.read` has already dropped anything outside the vocabulary and
 * collapsed duplicates, so nothing here can collide on the table's
 * `(recipe_id, category)` key.
 *
 * The slug is not checked again in the statement, because the column carries a
 * foreign key onto `category` since #210: the database is the check, and a
 * category removed under a request in flight fails this whole batch rather than
 * writing an orphan. `batchWithCategories` is what turns that into a sentence.
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

  /**
   * Whether a recipe with nothing in it at all is a legitimate thing to write
   * (issue #211).
   *
   * A member who remembers only the name of a dish can save it now and write it
   * down later, and that recipe stays editable while it is still empty — so the
   * quick save on `/intake` and the editor both pass this.
   *
   * The import path does not, and must not: there an empty `lines` means the
   * model gave back nothing usable, and saving that silently would turn a
   * failed import into a recipe nobody asked for.
   */
  allowEmpty?: boolean;
}

/** One of a dish's existing parts, as the caller already has it loaded. */
export interface ExistingPart {
  id: number;
  title: string;
}

/**
 * One of a dish's parts as the *form* last saw it, with the version it was at.
 *
 * A part is a recipe row of its own (ADR-0002) with its own editor screen, so
 * the dish's revision says nothing at all about whether the juustokastike moved
 * while a proposal was being read. This is what carries that missing half of
 * the optimistic lock from the screen back to the save.
 */
export interface ExpectedPart extends ExistingPart {
  revision: number;
}

export interface ReplaceOptions extends ValidateOptions {
  /**
   * The dish's existing parts (#208), freshly loaded.
   *
   * Only consulted when the submitted recipe actually names a section, which
   * the ordinary editor never does. It is what lets a proposal say "these are
   * the juustokastike's ingredients now" and have that land on the part's own
   * recipe row rather than being dropped for belonging to no row here.
   */
  parts?: readonly ExistingPart[];
  /**
   * The same parts as the submitted form saw them, each at its own revision.
   *
   * A named section is matched against **these** rather than against `parts`,
   * because what the member reviewed is what the proposal was built from. A
   * part that has since been edited, renamed or deleted therefore refuses the
   * whole save rather than being quietly overwritten with older content, and a
   * part that somebody else created under that name meanwhile refuses too
   * rather than being merged into by accident.
   */
  expectedParts?: readonly ExpectedPart[];
  /** Categories present in the server snapshot this edit was generated from. */
  expectedCategories?: readonly string[];
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

/**
 * The save batch, with the database's own category check read back as Finnish.
 *
 * `assertKnownCategories` runs before any of this, and it is a separate read:
 * an admin who removes a category in the moment between that read and this
 * batch would, without the key `0019_category_vocabulary.sql` puts on
 * `recipe_category.category`, have let a stale request write a slug the
 * vocabulary no longer has. With the key the batch fails instead, and because a
 * D1 batch is one transaction, nothing at all is written — not the recipe, not
 * its lines, not its steps. The recipe is exactly as it was.
 *
 * All this adds is the sentence. The vocabulary is read again on the way out,
 * so a failure that really was the missing category refuses the way every other
 * refusal on these screens does; anything else is re-thrown untouched, which is
 * what keeps this from quietly swallowing an unrelated database error.
 */
async function batchWithCategories(
  db: D1Database,
  statements: D1PreparedStatement[],
  categories: readonly string[],
): Promise<D1Result[]> {
  try {
    return await db.batch(statements);
  } catch (error) {
    await assertKnownCategories(db, categories);
    throw error;
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
  if (
    recipe.lines.length === 0 &&
    options.hasParts !== true &&
    options.allowEmpty !== true
  ) {
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
