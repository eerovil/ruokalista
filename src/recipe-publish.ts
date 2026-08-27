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

interface DishRow {
  id: number;
  title: string;
  published_at: string | null;
}

/**
 * The dishes this household owns, out of the ids a form asked about.
 *
 * Everything not owned simply is not here: an id from another household, an id
 * that names a part, and an id nobody ever created are all the same answer, so
 * a bulk form cannot be used to find out which recipes exist.
 */
async function ownedDishes(
  db: D1Database,
  householdId: number,
  ids: number[],
): Promise<DishRow[]> {
  const wanted = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (wanted.length === 0) return [];

  const placeholders = wanted.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT id, title, published_at
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
  const statements = [];

  for (const dish of dishes) {
    if (dish.published_at === null) {
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

    outcome.changed.push(dish.title);
    statements.push(
      db
        .prepare(
          `UPDATE recipe
              SET published_at = NULL, published_by = NULL
            WHERE id = ? AND household_id = ?`,
        )
        .bind(dish.id, member.householdId),
    );
  }

  if (statements.length > 0) await db.batch(statements);
  return outcome;
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
