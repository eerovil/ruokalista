import { today } from "./dates.ts";
import type { Member } from "./members.ts";

/**
 * Publishing a recipe, and taking it back.
 *
 * Publication is a property of a dish: `recipe.published_at` set means every
 * signed-in household may read it and put it on their week. Nothing else moves.
 * The owning household keeps editing it, and an edit is immediately what
 * everyone else sees, because there is one recipe row and no copies — that is
 * the whole reason this is a flag rather than a share-a-duplicate feature.
 *
 * Two rules make it safe to take back, and they are the same rule seen twice:
 *
 * - **Unpublishing is refused while another household has a future plan on it.**
 *   Somebody has decided to cook this on Thursday; pulling the recipe out from
 *   under them on Wednesday is the failure this prevents. A plan already in the
 *   past does not block anything — the cooking happened, the week is a record
 *   now, and the batch keeps rendering its title either way.
 * - **A published recipe cannot be deleted at all.** Deleting is unpublishing
 *   plus more, so it asks for the unpublish first and inherits the check rather
 *   than repeating it.
 *
 * Parts are never published on their own. Publishing a dish is publishing the
 * dish, and its parts ride along inside it (ADR-0002: a part is a recipe row,
 * not a record another household addresses).
 */

export class PublishRefused extends Error {}

const MAX_SELECTED_RECIPIENTS = 50;

export type RecipeVisibility = "private" | "selected" | "public";

export interface RecipeRecipient {
  id: number;
  name: string;
  selected: boolean;
}

export interface RecipeSharingState {
  /** Form state, possibly a refused submission kept intact. */
  visibility: RecipeVisibility;
  recipients: RecipeRecipient[];
  /** Stored state, used by the summary above the form. */
  savedVisibility: RecipeVisibility;
  savedRecipientNames: string[];
}

export interface SharingDraft {
  visibility: RecipeVisibility;
  recipientIds: number[];
}

/** One recipe that could not be unpublished, and why a reader should care. */
export interface PublishBlock {
  id: number;
  title: string;
  /** How many *other* households have it on a week that has not happened yet. */
  households: number;
}

export interface PublishOutcome {
  /** Recipes whose publication state actually changed. */
  changed: string[];
  /** Recipes that were already in the asked-for state. Not an error. */
  unchanged: string[];
  /** Recipes a future plan elsewhere kept published. */
  blocked: PublishBlock[];
}

export interface DishRow {
  id: number;
  title: string;
  published_at: string | null;
  share_count: number;
}

/**
 * The SQL scope for a recipe this household may read or plan.
 *
 * It deliberately carries two placeholders for the same household id: one for
 * ownership and one for a selected-household grant. Callers bind both. Keeping
 * the clause here stops the screen, API, picker, image and preference paths
 * from growing subtly different definitions of "shared with us".
 */
export function readableRecipeCondition(alias = "recipe"): string {
  return `(${alias}.household_id = ?
           OR ${alias}.published_at IS NOT NULL
           OR EXISTS (
                SELECT 1 FROM recipe_share
                 WHERE recipe_share.recipe_id = ${alias}.id
                   AND recipe_share.household_id = ?
              ))`;
}

/**
 * The dishes this household owns, out of the ids a form asked about.
 *
 * Everything not owned simply is not here: an id from another household, an id
 * that names a part, and an id nobody ever created are all the same answer, so
 * a bulk form cannot be used to find out which recipes exist.
 *
 * Exported because the list's bulk category buttons (#199) have to answer the
 * same ownership question as its bulk publish buttons, and two definitions of
 * "a dish this household owns" is exactly one too many.
 */
export async function ownedDishes(
  db: D1Database,
  householdId: number,
  ids: number[],
): Promise<DishRow[]> {
  const wanted = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (wanted.length === 0) return [];

  const placeholders = wanted.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT id, title, published_at,
              (SELECT count(*) FROM recipe_share
                WHERE recipe_share.recipe_id = recipe.id) AS share_count
         FROM recipe
        WHERE household_id = ?
          AND parent_id IS NULL
          AND id IN (${placeholders})
        ORDER BY title`,
    )
    .bind(householdId, ...wanted)
    .all<DishRow>();

  return results;
}

export async function publishRecipes(
  db: D1Database,
  member: Member,
  ids: number[],
): Promise<PublishOutcome> {
  const dishes = await ownedDishes(db, member.householdId, ids);
  if (dishes.length === 0) throw new PublishRefused("Valitse ainakin yksi resepti.");

  const outcome: PublishOutcome = { changed: [], unchanged: [], blocked: [] };
  const statements = [];

  for (const dish of dishes) {
    if (dish.published_at !== null) {
      outcome.unchanged.push(dish.title);
      continue;
    }
    outcome.changed.push(dish.title);
    statements.push(
      db.prepare("DELETE FROM recipe_share WHERE recipe_id = ?").bind(dish.id),
      db
        .prepare(
          `UPDATE recipe
              SET published_at = datetime('now'), published_by = ?
            WHERE id = ? AND household_id = ? AND published_at IS NULL`,
        )
        .bind(member.id, dish.id, member.householdId),
    );
  }

  if (statements.length > 0) await db.batch(statements);
  return outcome;
}

export async function unpublishRecipes(
  db: D1Database,
  member: Member,
  ids: number[],
): Promise<PublishOutcome> {
  const dishes = await ownedDishes(db, member.householdId, ids);
  if (dishes.length === 0) throw new PublishRefused("Valitse ainakin yksi resepti.");

  const outcome: PublishOutcome = { changed: [], unchanged: [], blocked: [] };
  for (const dish of dishes) {
    if (dish.published_at === null && dish.share_count === 0) {
      outcome.unchanged.push(dish.title);
      continue;
    }

    const households = await futurePlansElsewhere(
      db,
      member.householdId,
      dish.id,
    );
    if (households > 0) {
      outcome.blocked.push({ id: dish.id, title: dish.title, households });
      continue;
    }

    try {
      await setRecipeSharing(db, member, dish.id, {
        visibility: "private",
        recipientIds: [],
      });
      outcome.changed.push(dish.title);
    } catch (error) {
      if (!(error instanceof PublishRefused)) throw error;
      const raced = await futurePlansElsewhere(db, member.householdId, dish.id);
      if (raced === 0) throw error;
      outcome.blocked.push({ id: dish.id, title: dish.title, households: raced });
    }
  }
  return outcome;
}

/** All household names are discoverable to signed-in members by issue #185. */
export async function recipeSharingState(
  db: D1Database,
  ownerHouseholdId: number,
  recipeId: number,
  draft?: SharingDraft,
): Promise<RecipeSharingState> {
  const recipe = await db
    .prepare(
      `SELECT published_at FROM recipe
        WHERE id = ? AND household_id = ? AND parent_id IS NULL`,
    )
    .bind(recipeId, ownerHouseholdId)
    .first<{ published_at: string | null }>();
  if (recipe === null) throw new PublishRefused("Tuntematon resepti.");

  const { results } = await db
    .prepare(
      `SELECT household.id, household.name,
              recipe_share.recipe_id IS NOT NULL AS selected
         FROM household
         LEFT JOIN recipe_share
           ON recipe_share.household_id = household.id
          AND recipe_share.recipe_id = ?
        WHERE household.id <> ?`,
    )
    .bind(recipeId, ownerHouseholdId)
    .all<{ id: number; name: string; selected: number }>();

  const savedSelected = new Set(
    results.filter((row) => row.selected !== 0).map((row) => row.id),
  );
  const selected = draft === undefined ? savedSelected : new Set(draft.recipientIds);
  const collator = new Intl.Collator("fi");
  const recipients = results
    .map((row) => ({ id: row.id, name: row.name, selected: selected.has(row.id) }))
    .sort((a, b) => collator.compare(a.name, b.name));
  const savedVisibility: RecipeVisibility = (
    recipe.published_at !== null
      ? "public"
      : savedSelected.size > 0
        ? "selected"
        : "private"
  );
  return {
    visibility: draft?.visibility ?? savedVisibility,
    recipients,
    savedVisibility,
    savedRecipientNames: results
      .filter((row) => savedSelected.has(row.id))
      .map((row) => row.name)
      .sort((a, b) => collator.compare(a, b)),
  };
}

/** Replace one owned dish's complete sharing state in one D1 batch. */
export async function setRecipeSharing(
  db: D1Database,
  member: Member,
  recipeId: number,
  draft: SharingDraft,
): Promise<void> {
  const [dish] = await ownedDishes(db, member.householdId, [recipeId]);
  if (dish === undefined) throw new PublishRefused("Tuntematon resepti.");

  // Checked boxes are irrelevant when the target is private or public. Ignoring
  // them also means a large selected audience can always be taken to either
  // state without turning stale form values into a D1 binding-limit failure.
  const recipientIds = draft.visibility === "selected"
    ? [...new Set(
      draft.recipientIds.filter((id) => Number.isSafeInteger(id) && id > 0),
    )]
    : [];
  if (draft.visibility === "selected" && recipientIds.length === 0) {
    throw new PublishRefused("Valitse ainakin yksi vastaanottava talous.");
  }
  if (recipientIds.length > MAX_SELECTED_RECIPIENTS) {
    throw new PublishRefused(
      `Valitse enintään ${MAX_SELECTED_RECIPIENTS} vastaanottavaa taloutta.`,
    );
  }

  if (recipientIds.length > 0) {
    const placeholders = recipientIds.map(() => "?").join(", ");
    const known = await db
      .prepare(
        `SELECT count(*) AS n FROM household
          WHERE id <> ? AND id IN (${placeholders})`,
      )
      .bind(member.householdId, ...recipientIds)
      .first<{ n: number }>();
    if ((known?.n ?? 0) !== recipientIds.length) {
      throw new PublishRefused("Tuntematon vastaanottava talous.");
    }
  }

  const retained = draft.visibility === "public"
    ? null
    : new Set(draft.visibility === "selected" ? recipientIds : []);
  const losing = retained === null
    ? 0
    : await futurePlansLosingAccess(db, member.householdId, recipeId, retained);
  if (losing > 0) {
    throw new PublishRefused(blockedMessage([
      { id: dish.id, title: dish.title, households: losing },
    ]));
  }

  const statements = [];
  if (draft.visibility === "public") {
    statements.push(
      db.prepare("DELETE FROM recipe_share WHERE recipe_id = ?").bind(recipeId),
      db.prepare(
        `UPDATE recipe
            SET published_at = COALESCE(published_at, datetime('now')),
                published_by = CASE WHEN published_at IS NULL THEN ? ELSE published_by END
          WHERE id = ? AND household_id = ?`,
      ).bind(member.id, recipeId, member.householdId),
    );
  } else {
    const guard = noLosingFuturePlans(
      member.householdId,
      recipeId,
      recipientIds,
    );
    statements.push(
      db.prepare(
        `UPDATE recipe SET published_at = NULL, published_by = NULL
          WHERE id = ? AND household_id = ? AND ${guard.sql}`,
      ).bind(recipeId, member.householdId, ...guard.bindings),
    );
    if (draft.visibility === "selected") {
      const retainedRows = recipientIds.map(() => "(?)").join(", ");
      statements.push(
        db.prepare(
          `WITH retained(household_id) AS (VALUES ${retainedRows})
           DELETE FROM recipe_share
            WHERE recipe_id = ?
              AND NOT EXISTS (
                    SELECT 1 FROM retained
                     WHERE retained.household_id = recipe_share.household_id
                  )
              AND NOT EXISTS (
                    SELECT 1
                      FROM planned_batch
                      JOIN batch_occurrence
                        ON batch_occurrence.batch_id = planned_batch.id
                     WHERE planned_batch.household_id <> ?
                       AND batch_occurrence.date >= ?
                       AND planned_batch.recipe_id IN (
                             SELECT id FROM recipe WHERE id = ? OR parent_id = ?
                           )
                       AND NOT EXISTS (
                             SELECT 1 FROM retained
                              WHERE retained.household_id = planned_batch.household_id
                           )
                  )`,
        ).bind(
          ...recipientIds,
          recipeId,
          member.householdId,
          today(),
          recipeId,
          recipeId,
        ),
      );
      for (const householdId of recipientIds) {
        statements.push(
          db.prepare(
            `INSERT INTO recipe_share
               (recipe_id, household_id, shared_at, shared_by)
             SELECT ?, ?, datetime('now'), ?
              WHERE ${guard.sql}
             ON CONFLICT (recipe_id, household_id) DO NOTHING`,
          ).bind(
            recipeId,
            householdId,
            member.id,
            ...guard.bindings,
          ),
        );
      }
    } else {
      statements.push(
        db.prepare(
          `DELETE FROM recipe_share
            WHERE recipe_id = ? AND ${guard.sql}`,
        ).bind(recipeId, ...guard.bindings),
      );
    }
  }
  await db.batch(statements);

  // The guard is repeated inside the mutation batch, not only in the friendly
  // pre-check above. If a planner won the race, no access was removed and the
  // stored state still differs from the request; report that as the same clear
  // refusal instead of claiming the save worked.
  const saved = await recipeSharingState(db, member.householdId, recipeId);
  const savedIds = saved.recipients
    .filter((recipient) => recipient.selected)
    .map((recipient) => recipient.id);
  if (
    saved.savedVisibility !== draft.visibility ||
    savedIds.length !== recipientIds.length ||
    savedIds.some((id) => !recipientIds.includes(id))
  ) {
    const raced = await futurePlansLosingAccess(
      db,
      member.householdId,
      recipeId,
      new Set(recipientIds),
    );
    throw new PublishRefused(blockedMessage([
      { id: dish.id, title: dish.title, households: Math.max(raced, 1) },
    ]));
  }
}

function noLosingFuturePlans(
  ownerHouseholdId: number,
  recipeId: number,
  retained: number[],
): { sql: string; bindings: Array<string | number> } {
  const retainedClause = retained.length === 0
    ? ""
    : `AND planned_batch.household_id NOT IN (${retained.map(() => "?").join(", ")})`;
  return {
    sql: `NOT EXISTS (
            SELECT 1
              FROM planned_batch
              JOIN batch_occurrence
                ON batch_occurrence.batch_id = planned_batch.id
             WHERE planned_batch.household_id <> ?
               AND batch_occurrence.date >= ?
               AND planned_batch.recipe_id IN (
                     SELECT id FROM recipe WHERE id = ? OR parent_id = ?
                   )
               ${retainedClause}
          )`,
    bindings: [ownerHouseholdId, today(), recipeId, recipeId, ...retained],
  };
}

async function futurePlansLosingAccess(
  db: D1Database,
  ownerHouseholdId: number,
  recipeId: number,
  retained: Set<number>,
): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT planned_batch.household_id
         FROM planned_batch
         JOIN batch_occurrence ON batch_occurrence.batch_id = planned_batch.id
        WHERE planned_batch.household_id <> ?
          AND batch_occurrence.date >= ?
          AND planned_batch.recipe_id IN (
                SELECT id FROM recipe WHERE id = ? OR parent_id = ?
              )`,
    )
    .bind(ownerHouseholdId, today(), recipeId, recipeId)
    .all<{ household_id: number }>();
  return results.filter((row) => !retained.has(row.household_id)).length;
}

/**
 * How many other households have this dish on a day that has not passed.
 *
 * Counted over occurrences rather than batches, and `>= today` rather than
 * `> today`: a batch being cooked this evening is still somebody's dinner
 * tonight. "Today" is today in the kitchen (`src/dates.ts`), not in UTC.
 *
 * A batch can only ever name a dish — `requireDish` refuses a part — but the
 * subquery includes parts anyway, so the answer does not quietly depend on that
 * rule staying true somewhere else.
 */
export async function futurePlansElsewhere(
  db: D1Database,
  ownerHouseholdId: number,
  recipeId: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT count(DISTINCT planned_batch.household_id) AS households
         FROM planned_batch
         JOIN batch_occurrence ON batch_occurrence.batch_id = planned_batch.id
        WHERE planned_batch.household_id <> ?
          AND batch_occurrence.date >= ?
          AND planned_batch.recipe_id IN (
                SELECT id FROM recipe WHERE id = ? OR parent_id = ?
              )`,
    )
    .bind(ownerHouseholdId, today(), recipeId, recipeId)
    .first<{ households: number }>();

  return row?.households ?? 0;
}

/**
 * Why an unpublish did not happen, in Finnish, as a sentence a person can act
 * on. It names the recipe and says what has to change, because "estetty" on its
 * own leaves the reader with nowhere to go.
 */
export function blockedMessage(blocked: PublishBlock[]): string {
  if (blocked.length === 1) {
    const only = blocked[0]!;
    return `${only.title} on ${
      only.households === 1 ? "toisen talouden" : `${only.households} talouden`
    } tulevalla ruokalistalla, joten julkaisua ei voi poistaa vielä. Se onnistuu, kun ne ateriat on syöty tai poistettu.`;
  }

  return `${blocked
    .map((block) => block.title)
    .join(", ")} ovat toisten talouksien tulevilla ruokalistoilla, joten niiden julkaisua ei voi poistaa vielä.`;
}
