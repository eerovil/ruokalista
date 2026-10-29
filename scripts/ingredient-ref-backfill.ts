import {
  MAX_REFS_PER_STEP,
  mentionResolves,
  parseStepRefs,
  resolveMentions,
  serializeStepRefs,
  type StepIngredientRef,
} from "../src/ingredient-refs.ts";
import { canonicalJson } from "../src/backup.ts";

type Cell = string | number | boolean | null;
type Row = Record<string, Cell>;

export interface BackfillSnapshot {
  sha256: string;
  captured_at: string;
  tables: {
    recipe: Row[];
    recipe_step: Row[];
    ingredient: Row[];
    ingredient_line: Row[];
  };
}

/**
 * Two jobs share this file. Format 1 fills steps that have no references at
 * all (#120). Format 2 adds group phrases (#376) — "kuivat aineet", one
 * reference per line it covers — to every step, marked or not, so it carries
 * each step's stored references along to keep and to guard on.
 */
export type BackfillMode = "unmarked" | "groups";

export interface BackfillExport {
  formatVersion: 1 | 2;
  snapshotSha256: string;
  capturedAt: string;
  recipes: Array<{
    recipeId: number;
    ingredients: Array<{ position: number; ingredientId: number; name: string }>;
    steps: Array<{
      position: number;
      text: string;
      /** Format 2 only: the stored column exactly as the snapshot had it. */
      existingRefs?: string | null;
    }>;
  }>;
}

export interface BackfillResult {
  sql: string;
  acceptedMarks: number;
  droppedMarks: number;
  updatedSteps: number;
}

interface MarkedStep {
  position: number;
  ingredientRefs: unknown[];
}

interface MarkedRecipe {
  recipeId: number;
  steps: MarkedStep[];
}

/**
 * Verify the backup signature without requiring its unrelated tables to match
 * today's checkout. A nightly snapshot can legitimately trail a migration
 * merged later the same day; this job needs only the four tables below.
 */
export async function parseSignedBackfillSnapshot(text: string): Promise<BackfillSnapshot> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("snapshot is not valid JSON");
  }
  if (!isRecord(raw)) throw new Error("snapshot root must be an object");
  exactKeys(raw, [
    "format_version",
    "scheduled_at",
    "captured_at",
    "schema",
    "row_counts",
    "tables",
    "sha256",
  ], "snapshot");
  if (raw.format_version !== 1) throw new Error("unsupported snapshot format_version");
  const capturedAt = nonemptyString(raw.captured_at, "snapshot captured_at");
  if (!Number.isFinite(Date.parse(capturedAt))) throw new Error("snapshot captured_at is invalid");
  const scheduledAt = nonemptyString(raw.scheduled_at, "snapshot scheduled_at");
  if (!Number.isFinite(Date.parse(scheduledAt))) throw new Error("snapshot scheduled_at is invalid");
  const digest = sha256(raw.sha256, "snapshot sha256");
  if (!Array.isArray(raw.schema)) throw new Error("snapshot schema must be an array");
  if (!isRecord(raw.row_counts)) throw new Error("snapshot row_counts must be an object");
  if (!isRecord(raw.tables)) throw new Error("snapshot tables must be an object");

  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(raw.tables)) {
    if (!Array.isArray(rows)) throw new Error(`snapshot table ${name} must be an array`);
    tables[name] = rows.map((row, index) => validateSnapshotRow(name, row, index));
    if (raw.row_counts[name] !== rows.length) {
      throw new Error(`snapshot row count for ${name} does not match`);
    }
  }
  if (!hasExactKeys(raw.row_counts, Object.keys(tables))) {
    throw new Error("snapshot row_counts and tables differ");
  }

  const unsigned = {
    format_version: 1,
    scheduled_at: scheduledAt,
    captured_at: capturedAt,
    schema: raw.schema,
    row_counts: raw.row_counts,
    tables: raw.tables,
  };
  const actualDigest = await sha256Hex(canonicalJson(unsigned as never));
  if (actualDigest !== digest) throw new Error("snapshot SHA-256 does not match its contents");

  const required = ["recipe", "recipe_step", "ingredient", "ingredient_line"] as const;
  for (const name of required) {
    if (!tables[name]) throw new Error(`snapshot is missing table ${name}`);
  }
  const snapshot: BackfillSnapshot = {
    sha256: digest,
    captured_at: capturedAt,
    tables: {
      recipe: tables.recipe as Row[],
      recipe_step: tables.recipe_step as Row[],
      ingredient: tables.ingredient as Row[],
      ingredient_line: tables.ingredient_line as Row[],
    },
  };
  // Building the export performs the relationship and key validation needed
  // by this job without making the parser depend on unrelated current tables.
  buildBackfillExport(snapshot);
  return snapshot;
}

/** Build the private, minimal handoff file from an already validated backup. */
export function buildBackfillExport(
  snapshot: BackfillSnapshot,
  mode: BackfillMode = "unmarked",
): BackfillExport {
  const recipeIds = new Set<number>();
  snapshot.tables.recipe.forEach((row, index) => {
    const id = positiveInteger(row.id, `recipe row ${index} id`);
    if (recipeIds.has(id)) throw new Error(`recipe id ${id} is duplicated`);
    recipeIds.add(id);
  });
  const ingredientNames = new Map<number, string>();
  snapshot.tables.ingredient.forEach((row, index) => {
    const id = positiveInteger(row.id, `ingredient row ${index} id`);
    if (ingredientNames.has(id)) throw new Error(`ingredient id ${id} is duplicated`);
    const name = nonemptyString(row.name, `ingredient row ${index} name`);
    ingredientNames.set(id, name);
  });

  const ingredientsByRecipe = new Map<number, BackfillExport["recipes"][number]["ingredients"]>();
  const ingredientLinePositions = new Set<string>();
  snapshot.tables.ingredient_line.forEach((row, index) => {
    const recipeId = positiveInteger(row.recipe_id, `ingredient_line row ${index} recipe_id`);
    const ingredientId = positiveInteger(
      row.ingredient_id,
      `ingredient_line row ${index} ingredient_id`,
    );
    if (!recipeIds.has(recipeId)) throw new Error(`ingredient_line row ${index} has no recipe`);
    const position = positiveInteger(row.position, `ingredient_line row ${index} position`);
    const positionKey = `${recipeId}:${position}`;
    if (ingredientLinePositions.has(positionKey)) {
      throw new Error(`ingredient_line position ${positionKey} is duplicated`);
    }
    ingredientLinePositions.add(positionKey);
    const name = ingredientNames.get(ingredientId);
    if (!name) throw new Error(`ingredient_line row ${index} has no ingredient`);
    const lines = ingredientsByRecipe.get(recipeId) ?? [];
    lines.push({
      position,
      ingredientId,
      name,
    });
    ingredientsByRecipe.set(recipeId, lines);
  });

  const stepsByRecipe = new Map<number, BackfillExport["recipes"][number]["steps"]>();
  const stepPositions = new Set<string>();
  snapshot.tables.recipe_step.forEach((row, index) => {
    // Never offer an already-marked step to the external producer. Even a
    // malformed non-NULL value belongs to somebody to inspect, not overwrite.
    // A snapshot captured before #120 has no column at all; every one of its
    // steps is necessarily unmarked and is precisely what this job targets.
    //
    // The group job (#376) is the one exception: it only ever adds to what a
    // step holds, and its SQL refuses to run if the column has moved.
    const stored = "ingredient_refs" in row ? row.ingredient_refs : null;
    if (stored !== null && typeof stored !== "string") {
      throw new Error(`recipe_step row ${index} ingredient_refs is invalid`);
    }
    if (mode === "unmarked" && stored !== null) return;
    const recipeId = positiveInteger(row.recipe_id, `recipe_step row ${index} recipe_id`);
    if (!recipeIds.has(recipeId)) throw new Error(`recipe_step row ${index} has no recipe`);
    const position = positiveInteger(row.position, `recipe_step row ${index} position`);
    const positionKey = `${recipeId}:${position}`;
    if (stepPositions.has(positionKey)) throw new Error(`recipe_step position ${positionKey} is duplicated`);
    stepPositions.add(positionKey);
    const steps = stepsByRecipe.get(recipeId) ?? [];
    const text = nonemptyString(row.text, `recipe_step row ${index} text`);
    steps.push(mode === "groups" ? { position, text, existingRefs: stored } : { position, text });
    stepsByRecipe.set(recipeId, steps);
  });

  const recipes: BackfillExport["recipes"] = [];
  for (const [recipeId, steps] of [...stepsByRecipe].sort(([a], [b]) => a - b)) {
    const ingredients = ingredientsByRecipe.get(recipeId);
    if (!ingredients || ingredients.length === 0 || steps.length === 0) continue;
    ingredients.sort((a, b) => a.position - b.position);
    steps.sort((a, b) => a.position - b.position);
    recipes.push({ recipeId, ingredients, steps });
  }

  return {
    formatVersion: mode === "groups" ? 2 : 1,
    snapshotSha256: snapshot.sha256,
    capturedAt: snapshot.captured_at,
    recipes,
  };
}

/**
 * Validate untrusted marks and emit SQL that can only change a step whose text
 * and stored references are still what the snapshot said: a NULL row for
 * format 1, and for format 2 (#376) the exact stored value, with the new group
 * references added after the ones already there.
 */
export function generateBackfillSql(
  exported: BackfillExport,
  rawMarks: unknown,
): BackfillResult {
  const groups = exported.formatVersion === 2;
  const markedRecipes = parseMarksRoot(
    rawMarks,
    exported.snapshotSha256,
    exported.formatVersion,
  );
  const exportedByRecipe = new Map(exported.recipes.map((recipe) => [recipe.recipeId, recipe]));
  const seenRecipes = new Set<number>();
  let acceptedMarks = 0;
  let droppedMarks = 0;
  const updates: string[] = [];

  for (const markedRecipe of markedRecipes) {
    if (seenRecipes.has(markedRecipe.recipeId)) {
      droppedMarks += countMarks(markedRecipe);
      continue;
    }
    seenRecipes.add(markedRecipe.recipeId);
    const recipe = exportedByRecipe.get(markedRecipe.recipeId);
    if (!recipe) {
      droppedMarks += countMarks(markedRecipe);
      continue;
    }

    const ingredientIds = new Set(recipe.ingredients.map((line) => line.ingredientId));
    const steps = new Map(recipe.steps.map((step) => [step.position, step]));
    const seenSteps = new Set<number>();
    for (const markedStep of markedRecipe.steps) {
      if (seenSteps.has(markedStep.position)) {
        droppedMarks += markedStep.ingredientRefs.length;
        continue;
      }
      seenSteps.add(markedStep.position);
      const step = steps.get(markedStep.position);
      if (!step) {
        droppedMarks += markedStep.ingredientRefs.length;
        continue;
      }
      if (markedStep.ingredientRefs.length > MAX_REFS_PER_STEP) {
        droppedMarks += markedStep.ingredientRefs.length;
        continue;
      }

      const refs: StepIngredientRef[] = [];
      for (const rawRef of markedStep.ingredientRefs) {
        const ref = parseMark(rawRef);
        if (
          !ref ||
          !ingredientIds.has(ref.ingredientId) ||
          !mentionResolves(step.text, ref.matchedText)
        ) {
          droppedMarks += 1;
          continue;
        }
        refs.push(ref);
        acceptedMarks += 1;
      }

      let written = refs;
      if (groups) {
        // Only a group is this job's to add: a wording that, in this step,
        // stands for two or more ingredients. A lone mark is the #120 job's.
        const grouped = groupMembers(step.text, refs);
        droppedMarks += refs.length - grouped.length;
        acceptedMarks -= refs.length - grouped.length;
        const existing = parseStepRefs(step.existingRefs ?? null);
        // The decoder is lossy on purpose — a screen reads junk as "no
        // references" — but this job writes the column back. A stored value
        // that does not survive decoding and encoding unchanged holds
        // something the decoder would drop, so it is left for a person to
        // inspect rather than quietly rewritten.
        if (
          step.existingRefs !== null &&
          step.existingRefs !== undefined &&
          serializeStepRefs(existing) !== step.existingRefs
        ) {
          droppedMarks += grouped.length;
          acceptedMarks -= grouped.length;
          continue;
        }
        // Already there means the same ingredient on the same occurrence of
        // the same words: a phrase written twice in one step is two groups.
        const added = grouped.filter((ref) =>
          !existing.some((old) =>
            old.ingredientId === ref.ingredientId &&
            occurrenceKey(step.text, old) === occurrenceKey(step.text, ref)
          )
        );
        droppedMarks += grouped.length - added.length;
        acceptedMarks -= grouped.length - added.length;
        if (added.length === 0) continue;
        written = [...existing, ...added];
        if (written.length > MAX_REFS_PER_STEP) {
          droppedMarks += added.length;
          acceptedMarks -= added.length;
          continue;
        }
      }

      if (written.length === 0) continue;
      const stored = serializeStepRefs(written);
      if (stored === null) continue;
      const requiredIngredients = [...new Set(written.map((ref) => ref.ingredientId))].sort(
        (a, b) => a - b,
      );
      const guards = requiredIngredients.map(
        (ingredientId) =>
          `  AND EXISTS (SELECT 1 FROM ingredient_line WHERE recipe_id = ${recipe.recipeId} AND ingredient_id = ${ingredientId})`,
      );
      updates.push([
        "UPDATE recipe_step",
        `SET ingredient_refs = ${sqlString(stored)}`,
        `WHERE recipe_id = ${recipe.recipeId} AND position = ${step.position}`,
        `  AND text = ${sqlString(step.text)}`,
        groups && (step.existingRefs ?? null) !== null
          ? `  AND ingredient_refs = ${sqlString(step.existingRefs as string)}`
          : "  AND ingredient_refs IS NULL",
        ...guards,
        ";",
      ].join("\n"));
    }
  }

  const header = [
    "-- Ingredient-reference backfill generated from a validated nightly snapshot.",
    `-- Snapshot SHA-256: ${exported.snapshotSha256}`,
    groups
      ? "-- Safe to rerun: each statement only changes a step whose refs are unchanged."
      : "-- Safe to rerun: each statement only fills an unchanged NULL step.",
  ];
  return {
    sql: `${[...header, ...updates].join("\n\n")}\n`,
    acceptedMarks,
    droppedMarks,
    updatedSteps: updates.length,
  };
}

export function parseBackfillExport(value: unknown): BackfillExport {
  if (!isRecord(value)) throw new Error("export root must be an object");
  exactKeys(value, ["formatVersion", "snapshotSha256", "capturedAt", "recipes"], "export");
  if (value.formatVersion !== 1 && value.formatVersion !== 2) {
    throw new Error("unsupported export formatVersion");
  }
  const formatVersion = value.formatVersion;
  const snapshotSha256 = sha256(value.snapshotSha256, "export snapshotSha256");
  const capturedAt = nonemptyString(value.capturedAt, "export capturedAt");
  if (!Number.isFinite(Date.parse(capturedAt))) throw new Error("export capturedAt is invalid");
  if (!Array.isArray(value.recipes)) throw new Error("export recipes must be an array");

  const recipes = value.recipes.map((rawRecipe, recipeIndex) => {
    if (!isRecord(rawRecipe)) throw new Error(`export recipe ${recipeIndex} must be an object`);
    exactKeys(rawRecipe, ["recipeId", "ingredients", "steps"], `export recipe ${recipeIndex}`);
    const recipeId = positiveInteger(rawRecipe.recipeId, `export recipe ${recipeIndex} recipeId`);
    if (!Array.isArray(rawRecipe.ingredients) || !Array.isArray(rawRecipe.steps)) {
      throw new Error(`export recipe ${recipeIndex} arrays are invalid`);
    }
    const ingredients = rawRecipe.ingredients.map((rawLine, lineIndex) => {
      if (!isRecord(rawLine)) throw new Error(`export ingredient ${lineIndex} must be an object`);
      exactKeys(rawLine, ["position", "ingredientId", "name"], `export ingredient ${lineIndex}`);
      return {
        position: positiveInteger(rawLine.position, `export ingredient ${lineIndex} position`),
        ingredientId: positiveInteger(rawLine.ingredientId, `export ingredient ${lineIndex} id`),
        name: nonemptyString(rawLine.name, `export ingredient ${lineIndex} name`),
      };
    });
    const steps = rawRecipe.steps.map((rawStep, stepIndex) => {
      if (!isRecord(rawStep)) throw new Error(`export step ${stepIndex} must be an object`);
      const position = positiveInteger(rawStep.position, `export step ${stepIndex} position`);
      const text = nonemptyString(rawStep.text, `export step ${stepIndex} text`);
      if (formatVersion === 1) {
        exactKeys(rawStep, ["position", "text"], `export step ${stepIndex}`);
        return { position, text };
      }
      exactKeys(rawStep, ["position", "text", "existingRefs"], `export step ${stepIndex}`);
      const existingRefs = rawStep.existingRefs;
      if (existingRefs !== null && typeof existingRefs !== "string") {
        throw new Error(`export step ${stepIndex} existingRefs is invalid`);
      }
      return { position, text, existingRefs };
    });
    return { recipeId, ingredients, steps };
  });
  return { formatVersion, snapshotSha256, capturedAt, recipes };
}

/**
 * The marks that form a group: those whose occurrence — the same words at the
 * same place in the step, found as the screen's resolver finds them — is
 * shared by two or more distinct ingredients. A phrase written twice in one
 * step is two occurrences, so two groups.
 */
function groupMembers(
  text: string,
  refs: readonly StepIngredientRef[],
): StepIngredientRef[] {
  const ingredients = new Map<string, Set<number>>();
  for (const ref of refs) {
    const key = occurrenceKey(text, ref);
    const ids = ingredients.get(key) ?? new Set<number>();
    ids.add(ref.ingredientId);
    ingredients.set(key, ids);
  }
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = occurrenceKey(text, ref);
    if ((ingredients.get(key)?.size ?? 0) < 2) return false;
    const pair = `${key}\u0000${ref.ingredientId}`;
    if (seen.has(pair)) return false;
    seen.add(pair);
    return true;
  });
}

/**
 * Which occurrence of its words a reference lands on: the start index
 * `resolveMentions` would place it at, plus the folded wording. Approximate
 * positions differ between producers, so they are compared through this
 * rather than directly.
 */
function occurrenceKey(text: string, ref: StepIngredientRef): string {
  let start = -1;
  let cursor = 0;
  for (const segment of resolveMentions(text, [ref])) {
    if (segment.kind !== "text") {
      start = cursor;
      break;
    }
    cursor += segment.text.length;
  }
  return `${start}\u0000${ref.matchedText.toLocaleLowerCase("fi")}`;
}

function parseMarksRoot(
  value: unknown,
  expectedSha: string,
  expectedFormat: 1 | 2,
): MarkedRecipe[] {
  if (!isRecord(value)) throw new Error("marks root must be an object");
  exactKeys(value, ["formatVersion", "snapshotSha256", "recipes"], "marks");
  if (value.formatVersion !== expectedFormat) {
    throw new Error("marks formatVersion does not match the export");
  }
  if (sha256(value.snapshotSha256, "marks snapshotSha256") !== expectedSha) {
    throw new Error("marks were made from a different snapshot export");
  }
  if (!Array.isArray(value.recipes)) throw new Error("marks recipes must be an array");
  return value.recipes.map((rawRecipe, recipeIndex) => {
    if (!isRecord(rawRecipe)) throw new Error(`marks recipe ${recipeIndex} must be an object`);
    exactKeys(rawRecipe, ["recipeId", "steps"], `marks recipe ${recipeIndex}`);
    const recipeId = positiveInteger(rawRecipe.recipeId, `marks recipe ${recipeIndex} recipeId`);
    if (!Array.isArray(rawRecipe.steps)) throw new Error(`marks recipe ${recipeIndex} steps is invalid`);
    const steps = rawRecipe.steps.map((rawStep, stepIndex) => {
      if (!isRecord(rawStep)) throw new Error(`marks step ${stepIndex} must be an object`);
      exactKeys(rawStep, ["position", "ingredientRefs"], `marks step ${stepIndex}`);
      const position = positiveInteger(rawStep.position, `marks step ${stepIndex} position`);
      if (!Array.isArray(rawStep.ingredientRefs)) {
        throw new Error(`marks step ${stepIndex} ingredientRefs is invalid`);
      }
      return {
        position,
        ingredientRefs: rawStep.ingredientRefs,
      };
    });
    return { recipeId, steps };
  });
}

function parseMark(value: unknown): StepIngredientRef | null {
  if (!isRecord(value) || !hasExactKeys(value, ["ingredientId", "matchedText", "approxPosition"])) {
    return null;
  }
  if (!Number.isSafeInteger(value.ingredientId) || (value.ingredientId as number) <= 0) return null;
  if (typeof value.matchedText !== "string" || value.matchedText.trim() === "") return null;
  if (!Number.isSafeInteger(value.approxPosition) || (value.approxPosition as number) < 0) return null;
  return {
    ingredientId: value.ingredientId as number,
    matchedText: value.matchedText,
    approxPosition: value.approxPosition as number,
  };
}

function countMarks(recipe: MarkedRecipe): number {
  return recipe.steps.reduce((total, step) => total + step.ingredientRefs.length, 0);
}

function validateSnapshotRow(table: string, value: unknown, index: number): Row {
  if (!isRecord(value)) throw new Error(`snapshot ${table} row ${index} must be an object`);
  const row: Row = {};
  for (const [key, cell] of Object.entries(value)) {
    if (
      cell !== null &&
      typeof cell !== "string" &&
      typeof cell !== "number" &&
      typeof cell !== "boolean"
    ) {
      throw new Error(`snapshot ${table} row ${index} column ${key} is invalid`);
    }
    row[key] = cell;
  }
  return row;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} is invalid`);
  return value as number;
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is invalid`);
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  if (!hasExactKeys(value, expected)) throw new Error(`${label} has unexpected fields`);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && expected.slice().sort().every((key, index) => key === actual[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
