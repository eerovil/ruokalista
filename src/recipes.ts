import { problem } from "./auth.ts";
import { html, page, type Raw } from "./html.ts";
import { keepAwake } from "./keep-awake.ts";
import type { Member } from "./members.ts";
import { formatMeasurement, type Measurement } from "./quantities.ts";
import type { RecipePhase } from "./recipe-phase.ts";
import { scaleFactor, scaleMeasurement } from "./scaling.ts";
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
  /** The R2 object holding this recipe's picture, or null if it has none. */
  imageKey: string | null;
}

export interface RecipeLine extends Measurement {
  position: number;
  ingredient: string;
  sourceLine: string;
  phase: RecipePhase;
}

export interface RecipeStep {
  text: string;
  phase: RecipePhase;
}

export interface Recipe extends RecipeSummary {
  sourceText: string;
  sourceRoute: "pasted" | "photographed";
  /** Optimistic edit version. Incremented whenever this recipe is changed. */
  revision: number;
  steps: RecipeStep[];
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
  image_key: string | null;
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
              recipe.image_key,
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
    imageKey: row.image_key,
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
  source_text: string;
  source_route: "pasted" | "photographed";
  revision: number;
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
  phase: RecipePhase;
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
              recipe.revision,
              recipe.image_key,
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
        `SELECT recipe_step.text, recipe_step.phase
           FROM recipe_step
           JOIN recipe ON recipe.id = recipe_step.recipe_id
          WHERE recipe_step.recipe_id = ? AND recipe.household_id = ?
          ORDER BY recipe_step.position`,
      )
      .bind(id, householdId),
    db
      .prepare(
        `SELECT ingredient_line.position,
                ingredient_line.quantity,
                ingredient_line.quantity_max,
                ingredient_line.unit,
                ingredient_line.alt_quantity,
                ingredient_line.alt_unit,
                ingredient_line.source_line,
                ingredient_line.phase,
                ingredient.name AS ingredient
           FROM ingredient_line
           JOIN recipe ON recipe.id = ingredient_line.recipe_id
           JOIN ingredient ON ingredient.id = ingredient_line.ingredient_id
                          AND ingredient.household_id = recipe.household_id
          WHERE ingredient_line.recipe_id = ? AND recipe.household_id = ?
          ORDER BY ingredient_line.position`,
      )
      .bind(id, householdId),
  ]);

  const steps = (batch[0]?.results ?? []) as RecipeStep[];
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
    revision: row.revision,
    imageKey: row.image_key,
    createdAt: row.created_at,
    createdBy: row.created_by,
    parts,
    steps,
    lines: lines.map((line) => ({
      position: line.position,
      quantity: line.quantity,
      quantityMax: line.quantity_max,
      unit: line.unit,
      altQuantity: line.alt_quantity,
      altUnit: line.alt_unit,
      ingredient: line.ingredient,
      sourceLine: line.source_line,
      phase: line.phase,
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
  return Response.json({ recipe: recipeForApi(recipe) });
}

/** Keep the existing JSON shape; phases are an internal cooking-view concern. */
function recipeForApi(recipe: Recipe): object {
  return {
    ...recipe,
    steps: recipe.steps.map((step) => step.text),
    lines: recipe.lines.map(({ phase: _phase, ...line }) => line),
    parts: recipe.parts.map(recipeForApi),
  };
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
        ? // An empty state that only states the emptiness leaves the reader to
          // work out what to do about it. Both of these say the next move.
          html`<div class="nothing">
            <p class="empty">
              ${query.trim() === ""
                ? "Reseptejä ei ole vielä yhtään."
                : `Haku "${query.trim()}" ei löytänyt yhtään reseptiä.`}
            </p>
            ${query.trim() === ""
              ? html`<p><a class="button" href="/intake">Lisää ensimmäinen</a></p>`
              : html`<p><a href="/recipes">Näytä kaikki reseptit</a></p>`}
          </div>`
        : html`<ul class="recipes">
            ${recipes.map(
              (recipe) => html`<li>
                <a href="/recipes/${recipe.id}">
                  ${recipeImage(recipe, "thumb")}
                  <span class="recipes-text">
                    ${recipe.title}
                    <span class="meta"
                      >${finnishDate(recipe.createdAt)} · ${recipe.createdBy}</span
                    >
                  </span>
                </a>
              </li>`,
            )}
          </ul>`}`,
    "recipes",
    member,
  );
}

/** `GET /recipes/:id` — one recipe, as it gets read at the hob. */
export async function recipeScreen(
  { env, params, url }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipe = await loadRequested(env.DB, member, params["id"]);

  if (recipe === null) {
    return page(
      "Ei löytynyt",
      html`<h1>Ei löytynyt</h1>
        <p class="empty">Tätä reseptiä ei ole.</p>`,
      "recipes",
      member,
      404,
    );
  }

  // Arriving from a day on the week carries that day's portion count.
  const asked = Number(url.searchParams.get("portions"));
  const portions = Number.isSafeInteger(asked) && asked > 0 ? asked : null;

  return page(recipe.title, recipeBody(recipe, portions), "recipes", member);
}

/**
 * Whether this line's source wording earns a second line under it while
 * somebody is cooking.
 *
 * Repeating every source line turns the screen into a comparison view, and at
 * the hob fast legibility is worth more than maximum evidence. So the source
 * appears in exactly the two cases where the structured line is not the whole
 * truth:
 *
 *   - **No stated amount.** The fields have nowhere to put "hieman", "maun
 *     mukaan" or "tarvittaessa", so the qualifier only exists in the source.
 *     About a fifth of lines are like this.
 *   - **A scaled amount.** The number on the screen is no longer the number on
 *     the page, and the source line is what says so.
 *
 * Everything else — ranges, second measurements, plain amounts — round-trips
 * through the fields intact, so a copy underneath adds nothing to read.
 */
function sourceWorthShowing(line: RecipeLine, factor: number | null): boolean {
  if (line.quantity === null) {
    // Nothing lost if the source line is just the ingredient again.
    return line.sourceLine.trim() !== "" &&
      line.sourceLine.trim().toLocaleLowerCase("fi") !==
        line.ingredient.trim().toLocaleLowerCase("fi");
  }

  return (
    formatMeasurement(scaleMeasurement(line, factor)) !==
    formatMeasurement(line)
  );
}

/** The ingredients and method of one recipe — a dish, or one of its parts. */
function body(
  recipe: Recipe,
  factor: number | null,
  phases?: RecipePhase[],
): Raw {
  const lines = phases === undefined
    ? recipe.lines
    : recipe.lines.filter((line) => phases.includes(line.phase));
  const steps = phases === undefined
    ? recipe.steps
    : recipe.steps.filter((step) => phases.includes(step.phase));

  return html`${lines.length === 0
      ? ""
      : html`<h3>Ainekset</h3>
          <ul class="lines">
            ${lines.map((line) => {
              const amount = formatMeasurement(scaleMeasurement(line, factor));
              return html`<li>
                ${amount === ""
                  ? ""
                  : html`<span class="amount">${amount}</span> `}
                ${line.ingredient}
                ${sourceWorthShowing(line, factor)
                  ? html`<span class="source">${line.sourceLine}</span>`
                  : ""}
              </li>`;
            })}
          </ul>`}
    ${steps.length === 0
      ? ""
      : html`<h3>Valmistus</h3>
          <ol>
            ${steps.map((step) => html`<li>${step.text}</li>`)}
          </ol>`}`;
}

/** Everything rendering a picture needs to know. A `Recipe` is one of these. */
export interface Pictured {
  id: number;
  imageKey: string | null;
}

/**
 * A recipe's picture, or the same shape of space saying it has none.
 *
 * Always one or the other, never nothing: a row that changes height depending
 * on whether somebody got round to adding a photograph is a list that jumps
 * about while you scroll it. The picture is decorative — the title is always
 * right beside it — so it carries no alt text for a screen reader to read
 * twice, and the empty one is hidden from a screen reader entirely.
 *
 * Two sizes, because a list row and a recipe screen want very different
 * pictures out of the same object: `hero` is the band above a title, `thumb`
 * is the square that sits at the start of a row. They differ in what they do
 * with a picture that is not the band's shape. A `thumb` crops to fill its
 * square — a row of them has to line up, and a squashed dish is worse than a
 * cropped one. A `hero` is shown whole inside its band, because the screen is
 * about that one dish and the generator already framed it (issue #116); the
 * two carry different classes so a change to one cannot reach the other.
 *
 * Read-only on purpose. Uploading happens in the editor and nowhere else, so
 * no screen that calls this offers a control.
 */
export function recipeImage(
  recipe: Pictured,
  size: "hero" | "thumb" = "hero",
): Raw {
  const shape =
    size === "thumb" ? "recipe-image is-thumb" : "recipe-image is-hero";
  return recipe.imageKey === null
    ? html`<div class="${shape} is-empty" aria-hidden="true"></div>`
    : html`<div class="${shape}">
        <img src="/api/recipes/${recipe.id}/image" alt="" loading="lazy" />
      </div>`;
}

function recipeBody(recipe: Recipe, portions: number | null): Raw {
  const factor = scaleFactor(recipe.yieldPortions, portions);

  return html`${recipeImage(recipe)}
    <h1>${recipe.title}</h1>
    <!-- Whether the amounts below are the page's or this meal's is the first
         thing a cook needs to know, so it sits under the title and says which. -->
    <p class="${factor === null ? "yield" : "yield is-scaled"}">
      ${recipe.yieldPortions === null
        ? // A recipe with no yield says so where a scale control would be: you
          // cannot scale it, and hiding that would be worse than saying it.
          "Annosmäärää ei tiedetä, joten reseptiä ei voi skaalata."
        : factor === null
          ? `${recipe.yieldPortions} annosta`
          : `Määrät ${portions} annokselle — reseptissä ${recipe.yieldPortions}`}
    </p>

    ${recipe.parts.length === 0
      ? body(recipe, factor)
      : body(recipe, factor, [null, "before_parts"])}
    ${recipe.parts.map(
      (part) => html`<section class="part">
        <h2>${part.title}</h2>
        <!-- A part has no yield of its own, so it scales by the dish's factor. -->
        ${body(part, factor)}
      </section>`,
    )}
    ${recipe.parts.length === 0 ? "" : body(recipe, factor, ["after_parts"])}

    <!-- Still stored, still one tap away, but not competing with the cooking. -->
    <details class="source-original">
      <summary>Näytä alkuperäinen</summary>
      <p class="source-text">${recipe.sourceText}</p>
    </details>

    ${keepAwake()}

    <p class="recipe-edit">
      <a href="/recipes/${recipe.id}/edit">Muokkaa reseptiä</a>
    </p>`;
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
