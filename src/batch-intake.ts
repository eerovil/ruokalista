import { ingredientsFor, type IngredientSummary } from "./ingredients.ts";
import { draftFromJson, type Draft } from "./intake.ts";
import { MAX_LINES, MAX_STEPS } from "./line-form.ts";
import type { Member } from "./members.ts";
import {
  validateRecipe,
  SaveRefused,
  type LineIngredient,
  type RecipeToSave,
} from "./recipe-save.ts";
import { recipeSummaries } from "./recipes.ts";

export class BatchRefused extends Error {}

export interface ProposedIngredient {
  key: string;
  name: string;
}

export interface BatchAnalysis {
  json: string;
  provider: string;
  model: string | null;
  structuredBy: string;
  drafts: Draft[];
  ingredients: IngredientSummary[];
  proposedIngredients: ProposedIngredient[];
}

interface ParsedBundle {
  provider: string;
  model: string | null;
  structuredBy: string;
  drafts: Draft[];
}

const MAX_RECIPES = 100;
const MAX_TOTAL_LINES = 1_000;
const MAX_TOTAL_STEPS = 1_000;
const MAX_NEW_INGREDIENTS = 500;

/** Parse and compare the whole bundle before any save action is rendered. */
export async function analyseBatch(
  db: D1Database,
  member: Member,
  json: string,
): Promise<BatchAnalysis> {
  const parsed = parseBundle(json);
  const ingredients = await ingredientsFor(db, member.householdId);
  const proposedIngredients = proposedNames(parsed.drafts, ingredients);
  if (proposedIngredients.length > MAX_NEW_INGREDIENTS) {
    throw new BatchRefused(
      `Nipussa voi olla yhteensä enintään ${MAX_NEW_INGREDIENTS} uutta ainesta.`,
    );
  }
  const existingTitles = new Set(
    (await recipeSummaries(db, member.householdId, "")).map((recipe) =>
      keyOf(recipe.title),
    ),
  );
  const duplicate = parsed.drafts.find((draft) => existingTitles.has(keyOf(draft.title)));
  if (duplicate !== undefined) {
    throw new BatchRefused(`Resepti “${duplicate.title.trim()}” on jo olemassa.`);
  }

  // Run the storage gate now as well as at confirmation. New-name decisions use
  // their safe default here; repointing can only make them existing ingredients.
  const defaults = new Map(proposedIngredients.map((item) => [item.key, "new"]));
  try {
    for (const draft of parsed.drafts) {
      validateRecipe(recipeToSave(draft, ingredients, defaults, parsed.structuredBy));
    }
  } catch (error) {
    if (!(error instanceof SaveRefused)) throw error;
    throw new BatchRefused(error.message);
  }

  return { json, ingredients, proposedIngredients, ...parsed };
}

/** Apply the one batch-level decision for each proposed new ingredient. */
export function recipesToSave(
  analysis: BatchAnalysis,
  choices: Map<string, string>,
): RecipeToSave[] {
  return analysis.drafts.map((draft) =>
    recipeToSave(draft, analysis.ingredients, choices, analysis.structuredBy),
  );
}

function parseBundle(json: string): ParsedBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new BatchRefused("JSON-tiedostoa ei voitu lukea.");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BatchRefused("Nipun pitää olla JSON-olio.");
  }
  const bundle = raw as Record<string, unknown>;
  if (bundle["format_version"] !== 1) {
    throw new BatchRefused("Tuntematon nipun format_version; tuettu versio on 1.");
  }
  const generator = generatorFrom(bundle["generator"]);
  if (!Array.isArray(bundle["recipes"]) || bundle["recipes"].length === 0) {
    throw new BatchRefused("Nipussa pitää olla ainakin yksi resepti.");
  }
  if (bundle["recipes"].length > MAX_RECIPES) {
    throw new BatchRefused(`Nipussa voi olla enintään ${MAX_RECIPES} reseptiä.`);
  }
  const allowed = new Set(["format_version", "generator", "recipes"]);
  if (Object.keys(bundle).some((key) => !allowed.has(key))) {
    throw new BatchRefused("Nipussa on tuntemattomia kenttiä.");
  }

  const structuredBy = generator.model === null
    ? `agentdeck/${generator.provider}`
    : `agentdeck/${generator.provider}/${generator.model}`;
  const drafts = bundle["recipes"].map((recipe, index) => {
    if (typeof recipe !== "object" || recipe === null || Array.isArray(recipe)) {
      throw new BatchRefused(`Resepti ${index + 1} ei ole JSON-olio.`);
    }
    const wire = recipe as Record<string, unknown>;
    if (Array.isArray(wire["lines"]) && wire["lines"].length > MAX_LINES) {
      throw new BatchRefused(`Reseptissä ${index + 1} voi olla enintään ${MAX_LINES} ainesriviä.`);
    }
    if (Array.isArray(wire["steps"]) && wire["steps"].length > MAX_STEPS) {
      throw new BatchRefused(`Reseptissä ${index + 1} voi olla enintään ${MAX_STEPS} vaihetta.`);
    }
    const sourceText = wire["source_text"];
    if (typeof sourceText !== "string") {
      throw new BatchRefused(`Reseptin ${index + 1} source_text puuttuu.`);
    }

    let draft: Draft;
    try {
      draft = draftFromJson(
        JSON.stringify(recipe),
        { route: "pasted", text: sourceText },
        structuredBy,
      );
    } catch (error) {
      throw new BatchRefused(
        `Resepti ${index + 1} on virheellinen: ${String((error as Error).message ?? error)}`,
      );
    }
    validateGeneratedDraft(draft, index);
    return draft;
  });

  const seen = new Set<string>();
  for (const draft of drafts) {
    const key = keyOf(draft.title);
    if (seen.has(key)) {
      throw new BatchRefused(`Nipussa on sama reseptin nimi kahdesti: “${draft.title.trim()}”.`);
    }
    seen.add(key);
  }

  const totalLines = drafts.reduce((sum, draft) => sum + draft.lines.length, 0);
  if (totalLines > MAX_TOTAL_LINES) {
    throw new BatchRefused(
      `Nipussa voi olla yhteensä enintään ${MAX_TOTAL_LINES} ainesriviä.`,
    );
  }
  const totalSteps = drafts.reduce((sum, draft) => sum + draft.steps.length, 0);
  if (totalSteps > MAX_TOTAL_STEPS) {
    throw new BatchRefused(
      `Nipussa voi olla yhteensä enintään ${MAX_TOTAL_STEPS} valmistusvaihetta.`,
    );
  }

  return { ...generator, structuredBy, drafts };
}

function generatorFrom(raw: unknown): { provider: string; model: string | null } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BatchRefused("generator-metadata puuttuu.");
  }
  const generator = raw as Record<string, unknown>;
  const allowed = new Set(["via", "provider", "model"]);
  if (Object.keys(generator).some((key) => !allowed.has(key))) {
    throw new BatchRefused("generator-metadatassa on tuntemattomia kenttiä.");
  }
  if (generator["via"] !== "agentdeck") {
    throw new BatchRefused("generator.via-arvon pitää olla agentdeck.");
  }
  const provider = segment(generator["provider"], "generator.provider");
  const model = generator["model"] === undefined || generator["model"] === null
    ? null
    : segment(generator["model"], "generator.model");
  return { provider, model };
}

function segment(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new BatchRefused(`${label} saa sisältää vain kirjaimia, numeroita, pisteitä, viivoja ja alaviivoja.`);
  }
  return value;
}

function validateGeneratedDraft(draft: Draft, index: number): void {
  const label = draft.title.trim() || `resepti ${index + 1}`;
  if (draft.title.trim() === "") throw new BatchRefused(`Reseptiltä ${index + 1} puuttuu nimi.`);
  if (draft.lines.some((line) => line.ingredientId !== null)) {
    throw new BatchRefused(`Reseptissä “${label}” ingredient_id-arvojen pitää olla null.`);
  }
  if (draft.lines.some((line) => line.ingredientName.trim() === "")) {
    throw new BatchRefused(`Reseptissä “${label}” jokaisella rivillä pitää olla ingredient_name.`);
  }
  const sourceLines = new Set(draft.sourceText.split(/\r?\n/));
  const missing = draft.lines.find((line) => !sourceLines.has(line.sourceLine));
  if (missing !== undefined) {
    throw new BatchRefused(`Reseptin “${label}” source_line ei löydy sanatarkasti source_text-kentästä: “${missing.sourceLine}”.`);
  }

  const content = [...draft.lines, ...draft.steps];
  const multipart = content.some((item) => item.section !== null);
  const badPhase = content.find((item) =>
    multipart ? (item.section === null) === (item.phase === null) : item.phase !== null,
  );
  if (badPhase !== undefined) {
    throw new BatchRefused(`Reseptin “${label}” osat ja semantic phase -arvot eivät vastaa intake-sääntöä.`);
  }
}

function proposedNames(
  drafts: Draft[],
  ingredients: IngredientSummary[],
): ProposedIngredient[] {
  const existing = new Set(ingredients.map((ingredient) => keyOf(ingredient.name)));
  const proposed = new Map<string, string>();
  for (const draft of drafts) {
    for (const line of draft.lines) {
      const name = line.ingredientName.trim();
      const key = keyOf(name);
      if (!existing.has(key) && !proposed.has(key)) proposed.set(key, name);
    }
  }
  return [...proposed].map(([key, name]) => ({ key, name }));
}

function recipeToSave(
  draft: Draft,
  ingredients: IngredientSummary[],
  choices: Map<string, string>,
  structuredBy: string,
): RecipeToSave {
  const existingByName = new Map(
    ingredients.map((ingredient) => [keyOf(ingredient.name), ingredient.id]),
  );
  const existingIds = new Set(ingredients.map((ingredient) => ingredient.id));
  const lines = draft.lines.map((line, index) => {
    const key = keyOf(line.ingredientName);
    const exact = existingByName.get(key);
    let ingredient: LineIngredient;
    if (exact !== undefined) {
      ingredient = { kind: "existing", id: exact };
    } else {
      const choice = choices.get(key);
      if (choice === "new") {
        ingredient = { kind: "new", name: line.ingredientName.trim() };
      } else {
        const id = Number(choice);
        ingredient = Number.isSafeInteger(id) && existingIds.has(id)
          ? { kind: "existing", id }
          : { kind: "unanswered" };
      }
    }
    return {
      quantity: line.quantity,
      quantityMax: line.quantityMax,
      unit: line.unit,
      altQuantity: line.altQuantity,
      altUnit: line.altUnit,
      ingredient,
      sourceLine: line.sourceLine,
      section: line.section,
      phase: line.phase,
      // A bundle is taken in the order it was written, so the row a step's
      // mention points at is simply where the line sits in the draft.
      formIndex: index,
    };
  });
  const recipe: RecipeToSave = {
    title: draft.title,
    yieldPortions: draft.yieldPortions,
    sourceText: draft.sourceText,
    sourceRoute: "pasted",
    structuredBy,
    lines,
    steps: draft.steps,
  };
  validateRecipe(recipe);
  return recipe;
}

function keyOf(value: string): string {
  return value.trim().toLocaleLowerCase("fi");
}
