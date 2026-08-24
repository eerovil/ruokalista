export interface IntakeIngredient {
  id: number;
  name: string;
}

export interface IntakeLine {
  quantity: number | null;
  quantity_max: number | null;
  unit: string | null;
  alt_quantity: number | null;
  alt_unit: string | null;
  ingredient_id: number | null;
  ingredient_name: string;
  source_line: string;
}

export interface IntakeDraft {
  title: string;
  yield_portions: number | null;
  source_text: string;
  steps: string[];
  lines: IntakeLine[];
}

interface StructureEnv {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
}

export async function listIngredientChoices(db: D1Database, householdId: number): Promise<IntakeIngredient[]> {
  const result = await db.prepare(`
    SELECT id, name
    FROM ingredient
    WHERE household_id = ?
    ORDER BY name COLLATE NOCASE, id
  `).bind(householdId).all<IntakeIngredient>();
  return result.results;
}

function promptFor(sourceRoute: "pasted" | "photographed", ingredients: IntakeIngredient[]): string {
  return `You structure Finnish recipes for a household meal planner.
Return exactly one JSON object and no markdown.

Existing approved ingredients (match by id whenever one clearly fits):
${JSON.stringify(ingredients)}

Required shape:
{"title":"...","yield_portions":4,"source_text":"...","steps":["..."],"lines":[{"quantity":0.5,"quantity_max":null,"unit":"dl","alt_quantity":null,"alt_unit":null,"ingredient_id":42,"ingredient_name":"öljy","source_line":"½ dl öljyä"}]}

Rules:
- Never invent a quantity or unit.
- Keep units exactly as written.
- Copy every source_line verbatim from the source/transcription.
- quantity_max is only for a genuine range.
- alt_quantity and alt_unit are only for a second measurement of the same item in another unit; both or neither.
- yield_portions is null unless stated by the source.
- Match an existing ingredient id when one clearly fits. Otherwise ingredient_id is null and ingredient_name is a concise proposed shared ingredient name.
- source_text must preserve the pasted text exactly for pasted input. For photographed input it is the faithful transcription of the page.
- Keep steps in source order.
- Do not include commentary outside the JSON.

Source route: ${sourceRoute}.`;
}

function extractTextResponse(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const content = (payload as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    if (!item || typeof item !== "object") return "";
    const block = item as { type?: string; text?: string };
    return block.type === "text" && typeof block.text === "string" ? block.text : "";
  }).join("");
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "number" && Number.isFinite(value) ? value : NaN;
}

/** The model returned something we could not read as a draft. Retryable. */
class DraftShapeError extends Error {}

function validateDraft(value: unknown): IntakeDraft {
  if (!value || typeof value !== "object") throw new Error("Mallin vastaus ei ollut objekti.");
  const raw = value as Record<string, unknown>;
  if (typeof raw.title !== "string" || typeof raw.source_text !== "string" || !Array.isArray(raw.steps) || !Array.isArray(raw.lines)) {
    throw new Error("Mallin vastauksesta puuttui reseptikenttiä.");
  }
  const yieldPortions = asNullableNumber(raw.yield_portions);
  if (Number.isNaN(yieldPortions) || (yieldPortions !== null && (!Number.isInteger(yieldPortions) || yieldPortions <= 0))) {
    throw new Error("Mallin annosmäärä ei kelpaa.");
  }
  const steps = raw.steps.map((step) => {
    if (typeof step !== "string") throw new Error("Mallin työvaihe ei ollut tekstiä.");
    return step;
  });
  const lines = raw.lines.map((lineValue) => {
    if (!lineValue || typeof lineValue !== "object") throw new Error("Mallin ainesrivi ei ollut objekti.");
    const line = lineValue as Record<string, unknown>;
    const quantity = asNullableNumber(line.quantity);
    const quantityMax = asNullableNumber(line.quantity_max);
    const altQuantity = asNullableNumber(line.alt_quantity);
    if ([quantity, quantityMax, altQuantity].some(Number.isNaN)) throw new Error("Mallin määrä ei ollut numero.");
    if (typeof line.ingredient_name !== "string" || typeof line.source_line !== "string") throw new Error("Mallin ainesriviltä puuttui nimi tai lähderivi.");
    const ingredientId = line.ingredient_id === null || line.ingredient_id === undefined ? null : Number(line.ingredient_id);
    if (ingredientId !== null && (!Number.isInteger(ingredientId) || ingredientId <= 0)) throw new Error("Mallin aines-id ei kelpaa.");
    const unit = line.unit === null || line.unit === undefined ? null : String(line.unit);
    const altUnit = line.alt_unit === null || line.alt_unit === undefined ? null : String(line.alt_unit);
    if ((altQuantity === null) !== (altUnit === null)) throw new Error("Mallin toinen mitta oli vajaa.");
    return {
      quantity,
      quantity_max: quantityMax,
      unit,
      alt_quantity: altQuantity,
      alt_unit: altUnit,
      ingredient_id: ingredientId,
      ingredient_name: line.ingredient_name,
      source_line: line.source_line
    };
  });
  return { title: raw.title, yield_portions: yieldPortions, source_text: raw.source_text, steps, lines };
}

async function callAnthropic(env: StructureEnv, systemPrompt: string, sourceRoute: "pasted" | "photographed", sourceText: string | null, image: { mediaType: string; data: string } | null): Promise<IntakeDraft> {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY puuttuu.");
  const model = env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
  const content: Array<Record<string, unknown>> = [];
  if (image) {
    content.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } });
    content.push({ type: "text", text: "Transcribe and structure this printed recipe page." });
  } else {
    content.push({ type: "text", text: sourceText ?? "" });
  }
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({ model, max_tokens: 5000, system: systemPrompt, messages: [{ role: "user", content }] })
  });
  if (!response.ok) throw new Error(`Mallipalvelu palautti virheen ${response.status}.`);
  const payload = await response.json();
  const text = extractTextResponse(payload);
  if (!text) throw new Error("Mallipalvelu ei palauttanut tekstiä.");
  try {
    return validateDraft(JSON.parse(text));
  } catch (error) {
    throw new DraftShapeError(error instanceof Error ? error.message : "Mallin vastaus ei kelvannut.");
  }
}

export async function structureRecipe(
  env: StructureEnv,
  db: D1Database,
  householdId: number,
  sourceRoute: "pasted" | "photographed",
  sourceText: string | null,
  image: { mediaType: string; data: string } | null
): Promise<{ draft: IntakeDraft; model: string }> {
  const ingredients = await listIngredientChoices(db, householdId);
  const systemPrompt = promptFor(sourceRoute, ingredients);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const draft = await callAnthropic(env, systemPrompt, sourceRoute, sourceText, image);
      return { draft, model: env.ANTHROPIC_MODEL ?? "claude-sonnet-5" };
    } catch (error) {
      lastError = error;
      if (!(error instanceof DraftShapeError)) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Reseptin jäsentäminen epäonnistui.");
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} puuttuu.`);
  return value.trim();
}

function normalizeNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("Määrän pitää olla numero.");
  return number;
}

export interface CorrectedDraftPayload extends IntakeDraft {
  source_route: "pasted" | "photographed";
  structured_by: string;
}

export function validateCorrectedDraft(value: unknown): CorrectedDraftPayload {
  if (!value || typeof value !== "object") throw new Error("Reseptiluonnos puuttuu.");
  const raw = value as Record<string, unknown>;
  const sourceRoute = raw.source_route;
  if (sourceRoute !== "pasted" && sourceRoute !== "photographed") throw new Error("Lähdereitti ei kelpaa.");
  const yieldPortions = raw.yield_portions === null || raw.yield_portions === "" ? null : Number(raw.yield_portions);
  if (yieldPortions !== null && (!Number.isInteger(yieldPortions) || yieldPortions <= 0)) throw new Error("Annosmäärän pitää olla positiivinen kokonaisluku.");
  if (!Array.isArray(raw.steps) || !Array.isArray(raw.lines)) throw new Error("Työvaiheet tai ainesrivit puuttuvat.");
  const lines = raw.lines.map((lineValue) => {
    if (!lineValue || typeof lineValue !== "object") throw new Error("Ainesrivi ei kelpaa.");
    const line = lineValue as Record<string, unknown>;
    const ingredientId = line.ingredient_id === null || line.ingredient_id === "" ? null : Number(line.ingredient_id);
    const ingredientName = requiredString(line.ingredient_name, "Aineksen nimi");
    if (ingredientId !== null && (!Number.isInteger(ingredientId) || ingredientId <= 0)) throw new Error("Aines-id ei kelpaa.");
    const quantity = normalizeNullableNumber(line.quantity);
    const quantityMax = normalizeNullableNumber(line.quantity_max);
    const altQuantity = normalizeNullableNumber(line.alt_quantity);
    const unit = line.unit === null || line.unit === undefined || line.unit === "" ? null : String(line.unit);
    const altUnit = line.alt_unit === null || line.alt_unit === undefined || line.alt_unit === "" ? null : String(line.alt_unit);
    if ((altQuantity === null) !== (altUnit === null)) throw new Error("Toisesta mitasta puuttuu määrä tai yksikkö.");
    return {
      quantity,
      quantity_max: quantityMax,
      unit,
      alt_quantity: altQuantity,
      alt_unit: altUnit,
      ingredient_id: ingredientId,
      ingredient_name: ingredientName,
      source_line: requiredString(line.source_line, "Lähderivi")
    };
  });
  return {
    title: requiredString(raw.title, "Otsikko"),
    yield_portions: yieldPortions,
    source_text: requiredString(raw.source_text, "Lähdeteksti"),
    steps: raw.steps.map((step) => requiredString(step, "Työvaihe")),
    lines,
    source_route: sourceRoute,
    structured_by: requiredString(raw.structured_by, "Mallin tunniste")
  };
}

export async function saveCorrectedDraft(
  db: D1Database,
  householdId: number,
  memberId: number,
  payload: CorrectedDraftPayload
): Promise<number> {
  const ingredientIds: number[] = [];
  for (const line of payload.lines) {
    if (line.ingredient_id !== null) {
      const existing = await db.prepare(`SELECT id FROM ingredient WHERE id = ? AND household_id = ?`).bind(line.ingredient_id, householdId).first<{ id: number }>();
      if (!existing) throw new Error(`Ainesta ${line.ingredient_name} ei löytynyt.`);
      ingredientIds.push(existing.id);
      continue;
    }
    await db.prepare(`
      INSERT INTO ingredient (household_id, name, created_by)
      VALUES (?, ?, ?)
      ON CONFLICT(household_id, name) DO NOTHING
    `).bind(householdId, line.ingredient_name, memberId).run();
    const resolved = await db.prepare(`SELECT id FROM ingredient WHERE household_id = ? AND name = ?`).bind(householdId, line.ingredient_name).first<{ id: number }>();
    if (!resolved) throw new Error(`Uutta ainesta ${line.ingredient_name} ei voitu hyväksyä.`);
    ingredientIds.push(resolved.id);
  }

  const recipeInsert = await db.prepare(`
    INSERT INTO recipe (household_id, title, yield_portions, source_text, source_route, structured_by, structured_at, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
    RETURNING id
  `).bind(householdId, payload.title, payload.yield_portions, payload.source_text, payload.source_route, payload.structured_by, memberId, memberId).first<{ id: number }>();
  if (!recipeInsert) throw new Error("Reseptin tallennus epäonnistui.");

  const statements: D1PreparedStatement[] = [];
  payload.steps.forEach((step, index) => statements.push(db.prepare(`INSERT INTO recipe_step (recipe_id, position, text) VALUES (?, ?, ?)`).bind(recipeInsert.id, index + 1, step)));
  payload.lines.forEach((line, index) => statements.push(db.prepare(`
    INSERT INTO ingredient_line (recipe_id, position, quantity, quantity_max, unit, alt_quantity, alt_unit, ingredient_id, source_line)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(recipeInsert.id, index + 1, line.quantity, line.quantity_max, line.unit, line.alt_quantity, line.alt_unit, ingredientIds[index], line.source_line)));
  if (statements.length) {
    try {
      await db.batch(statements);
    } catch (error) {
      // The recipe row is already committed, so drop it rather than leave a
      // recipe with no steps and no ingredient lines.
      await db.prepare(`DELETE FROM recipe WHERE id = ? AND household_id = ?`).bind(recipeInsert.id, householdId).run();
      throw error;
    }
  }
  return recipeInsert.id;
}
