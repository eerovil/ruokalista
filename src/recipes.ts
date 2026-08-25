import { problem } from "./auth.ts";
import { html, page, type Raw } from "./html.ts";
import type { Member } from "./members.ts";
import { formatMeasurement, type Measurement } from "./quantities.ts";
import type { RouteContext } from "./router.ts";

/**
 * Reading the recipe store: the list and one recipe. Both the screens and the
 * JSON come from the same queries, and every one of them is scoped by
 * household_id — a recipe belonging to another household is a 404, not a 403,
 * because whether it exists is not this household's business.
 */

export interface RecipeSummary {
  id: number;
  title: string;
  createdAt: string;
  createdBy: string;
  /** What the picker defaults portions to when the source stated one. */
  yieldPortions: number | null;
}

export interface RecipeLine extends Measurement {
  position: number;
  ingredient: string;
  sourceLine: string;
}

export interface Recipe extends RecipeSummary {
  sourceText: string;
  sourceRoute: string;
  steps: string[];
  lines: RecipeLine[];
  /** The dish's named parts, each a recipe of its own. Empty for a plain one. */
  parts: Recipe[];
}

// ---------------------------------------------------------------- queries

interface SummaryRow {
  id: number;
  title: string;
  created_at: string;
  created_by: string;
  yield_portions: number | null;
}

export async function recipeSummaries(
  db: D1Database,
  householdId: number,
  query: string,
): Promise<RecipeSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT recipe.id,
              recipe.title,
              recipe.created_at,
              recipe.yield_portions,
              member.display_name AS created_by
         FROM recipe
         JOIN member ON member.id = recipe.created_by
        WHERE recipe.household_id = ?
          AND recipe.parent_id IS NULL
        ORDER BY recipe.created_at DESC, recipe.id DESC`,
    )
    .bind(householdId)
    .all<SummaryRow>();

  const summaries = results.map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    createdBy: row.created_by,
    yieldPortions: row.yield_portions,
  }));

  // Matched here rather than with SQL LIKE: SQLite's case-insensitivity is
  // ASCII-only, so "Ö" would not find "ö". A household's whole list is a few
  // hundred titles, which is nothing to filter in memory.
  const needle = query.trim().toLocaleLowerCase("fi");
  if (needle === "") return summaries;

  return summaries.filter((recipe) =>
    recipe.title.toLocaleLowerCase("fi").includes(needle),
  );
}

interface RecipeRow extends SummaryRow {
  yield_portions: number | null;
  source_text: string;
  source_route: string;
}

interface LineRow {
  position: number;
  quantity: number | null;
  quantity_max: number | null;
  unit: string | null;
  alt_quantity: number | null;
  alt_unit: string | null;
  ingredient: string;
  source_line: string;
}

export async function findRecipe(
  db: D1Database,
  householdId: number,
  id: number,
  withParts = true,
): Promise<Recipe | null> {
  const row = await db
    .prepare(
      `SELECT recipe.id,
              recipe.title,
              recipe.yield_portions,
              recipe.source_text,
              recipe.source_route,
              recipe.created_at,
              member.display_name AS created_by
         FROM recipe
         JOIN member ON member.id = recipe.created_by
        WHERE recipe.id = ? AND recipe.household_id = ?`,
    )
    .bind(id, householdId)
    .first<RecipeRow>();

  if (row === null) return null;

  const batch = await db.batch<never>([
    db
      .prepare(
        "SELECT text FROM recipe_step WHERE recipe_id = ? ORDER BY position",
      )
      .bind(id),
    db
      .prepare(
        `SELECT ingredient_line.position,
                ingredient_line.quantity,
                ingredient_line.quantity_max,
                ingredient_line.unit,
                ingredient_line.alt_quantity,
                ingredient_line.alt_unit,
                ingredient_line.source_line,
                ingredient.name AS ingredient
           FROM ingredient_line
           JOIN ingredient ON ingredient.id = ingredient_line.ingredient_id
          WHERE ingredient_line.recipe_id = ?
          ORDER BY ingredient_line.position`,
      )
      .bind(id),
  ]);

  const steps = (batch[0]?.results ?? []) as { text: string }[];
  const lines = (batch[1]?.results ?? []) as LineRow[];

  // One level only: a part cannot itself have parts, so this never recurses
  // more than once. See docs/adr/0002-a-part-is-a-recipe.md.
  const parts = withParts ? await partsOf(db, householdId, id) : [];

  return {
    id: row.id,
    title: row.title,
    yieldPortions: row.yield_portions,
    sourceText: row.source_text,
    sourceRoute: row.source_route,
    createdAt: row.created_at,
    createdBy: row.created_by,
    parts,
    steps: steps.map((step) => step.text),
    lines: lines.map((line) => ({
      position: line.position,
      quantity: line.quantity,
      quantityMax: line.quantity_max,
      unit: line.unit,
      altQuantity: line.alt_quantity,
      altUnit: line.alt_unit,
      ingredient: line.ingredient,
      sourceLine: line.source_line,
    })),
  };
}

// ----------------------------------------------------------------- routes

async function partsOf(
  db: D1Database,
  householdId: number,
  parentId: number,
): Promise<Recipe[]> {
  const { results } = await db
    .prepare(
      `SELECT id FROM recipe
        WHERE household_id = ? AND parent_id = ?
        ORDER BY part_position, id`,
    )
    .bind(householdId, parentId)
    .all<{ id: number }>();

  const parts: Recipe[] = [];
  for (const row of results) {
    const part = await findRecipe(db, householdId, row.id, false);
    if (part !== null) parts.push(part);
  }

  return parts;
}

/** `GET /api/recipes?q=` */
export async function apiListRecipes(
  { env, url }: RouteContext,
  member: Member,
): Promise<Response> {
  return Response.json({
    recipes: await recipeSummaries(
      env.DB,
      member.householdId,
      url.searchParams.get("q") ?? "",
    ),
  });
}

/** `GET /api/recipes/:id` */
export async function apiShowRecipe(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipe = await loadRequested(env.DB, member, params["id"]);
  if (recipe === null) return problem(404, "No such recipe.");
  return Response.json({ recipe });
}

/** `GET /recipes` — the recipe list screen. */
export async function recipeListScreen(
  { env, url }: RouteContext,
  member: Member,
): Promise<Response> {
  const query = url.searchParams.get("q") ?? "";
  const recipes = await recipeSummaries(env.DB, member.householdId, query);

  return page(
    "Reseptit",
    html`<h1>Reseptit</h1>
      <form method="get" action="/recipes">
        <input
          type="search"
          name="q"
          value="${query}"
          placeholder="Hae nimellä"
          aria-label="Hae nimellä"
        />
        <button type="submit">Hae</button>
      </form>
      ${recipes.length === 0
        ? html`<p class="empty">
            ${query.trim() === ""
              ? "Reseptejä ei ole vielä yhtään."
              : "Haku ei löytänyt yhtään reseptiä."}
          </p>`
        : html`<ul class="recipes">
            ${recipes.map(
              (recipe) => html`<li>
                <a href="/recipes/${recipe.id}">
                  ${recipe.title}
                  <span class="meta"
                    >${finnishDate(recipe.createdAt)} · ${recipe.createdBy}</span
                  >
                </a>
              </li>`,
            )}
          </ul>`}`,
  );
}

/** `GET /recipes/:id` — one recipe, as it gets read at the hob. */
export async function recipeScreen(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipe = await loadRequested(env.DB, member, params["id"]);

  if (recipe === null) {
    return page(
      "Ei löytynyt",
      html`<h1>Ei löytynyt</h1>
        <p class="empty">Tätä reseptiä ei ole.</p>`,
      404,
    );
  }

  return page(recipe.title, recipeBody(recipe));
}

/** The ingredients and method of one recipe — a dish, or one of its parts. */
function body(recipe: Recipe): Raw {
  return html`${recipe.lines.length === 0
      ? ""
      : html`<h3>Ainekset</h3>
          <ul class="lines">
            ${recipe.lines.map((line) => {
              const amount = formatMeasurement(line);
              return html`<li>
                ${amount === ""
                  ? ""
                  : html`<span class="amount">${amount}</span> `}
                ${line.ingredient}
                <span class="source">${line.sourceLine}</span>
              </li>`;
            })}
          </ul>`}
    ${recipe.steps.length === 0
      ? ""
      : html`<h3>Valmistus</h3>
          <ol>
            ${recipe.steps.map((step) => html`<li>${step}</li>`)}
          </ol>`}`;
}

function recipeBody(recipe: Recipe): Raw {
  return html`<h1>${recipe.title}</h1>
    <p class="yield">
      ${recipe.yieldPortions === null
        ? // A recipe with no yield says so where a scale control would be: you
          // cannot scale it, and hiding that would be worse than saying it.
          "Annosmäärää ei tiedetä, joten reseptiä ei voi skaalata."
        : `${recipe.yieldPortions} annosta`}
    </p>

    ${body(recipe)}
    ${recipe.parts.map(
      (part) => html`<section class="part">
        <h2>${part.title}</h2>
        ${body(part)}
      </section>`,
    )}

    <h2>Alkuperäinen teksti</h2>
    <p class="source-text">${recipe.sourceText}</p>

    <p><a href="/recipes/${recipe.id}/edit">Muokkaa reseptiä</a></p>`;
}

async function loadRequested(
  db: D1Database,
  member: Member,
  rawId: string | undefined,
): Promise<Recipe | null> {
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return findRecipe(db, member.householdId, id);
}

/** `2026-08-25 06:12:00` as `25.8.2026`. */
function finnishDate(timestamp: string): string {
  const [date] = timestamp.split(" ");
  const parts = (date ?? "").split("-");
  if (parts.length !== 3) return timestamp;

  const [year, month, day] = parts as [string, string, string];
  return `${Number(day)}.${Number(month)}.${year}`;
}
