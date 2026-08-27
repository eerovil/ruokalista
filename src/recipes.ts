import { problem } from "./auth.ts";
import { html, page, type Raw } from "./html.ts";
import {
  parseStepRefs,
  resolveMentions,
  type StepIngredientRef,
} from "./ingredient-refs.ts";
import { keepAwake } from "./keep-awake.ts";
import type { Member } from "./members.ts";
import { formatMeasurement, type Measurement } from "./quantities.ts";
import type { RecipePhase } from "./recipe-phase.ts";
import {
  scaleFactor,
  scaleMeasurement,
  sourceWorthShowing,
} from "./scaling.ts";
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
  /** The `ingredient` row, so a step's mention of it can find its amount. */
  ingredientId: number;
  ingredient: string;
  sourceLine: string;
  phase: RecipePhase;
}

export interface RecipeStep {
  text: string;
  phase: RecipePhase;
  /** Ingredients this step names in its own wording. See `ingredient-refs.ts`. */
  refs: StepIngredientRef[];
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

interface StepRow {
  text: string;
  phase: RecipePhase;
  ingredient_refs: string | null;
}

interface LineRow {
  position: number;
  ingredient_id: number;
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
        `SELECT recipe_step.text,
                recipe_step.phase,
                recipe_step.ingredient_refs
           FROM recipe_step
           JOIN recipe ON recipe.id = recipe_step.recipe_id
          WHERE recipe_step.recipe_id = ? AND recipe.household_id = ?
          ORDER BY recipe_step.position`,
      )
      .bind(id, householdId),
    db
      .prepare(
        `SELECT ingredient_line.position,
                ingredient_line.ingredient_id,
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

  const steps = (batch[0]?.results ?? []) as StepRow[];
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
    steps: steps.map((step) => ({
      text: step.text,
      phase: step.phase,
      refs: parseStepRefs(step.ingredient_refs),
    })),
    lines: lines.map((line) => ({
      position: line.position,
      ingredientId: line.ingredient_id,
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

/**
 * Keep the existing JSON shape; phases and ingredient mentions are both
 * internal cooking-view concerns, and neither has ever been on the wire.
 */
function recipeForApi(recipe: Recipe): object {
  return {
    ...recipe,
    steps: recipe.steps.map((step) => step.text),
    lines: recipe.lines.map(
      ({ phase: _phase, ingredientId: _ingredientId, ...line }) => line,
    ),
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
 * A step, with the ingredients it names made tappable (issue #120).
 *
 * The reveal is a checkbox and its label, not a script. Every mention toggles
 * on its own, it survives a page the browser restored from its back-forward
 * cache, and it works on a browser that runs no JavaScript at all — which is
 * the standing rule for anything on the reading path. The amount sits in the
 * markup already scaled, so what appears is this meal's figure and not the
 * page's, and nothing has to be kept in step with a later edit: the next render
 * reads the ingredient line again.
 *
 * A mention whose ingredient states no amount ("hieman sitruunaruohoa") is left
 * as plain text. There is nothing to reveal, and a control that does nothing is
 * worse than no control.
 */
function stepText(
  step: RecipeStep,
  amounts: Map<number, string>,
  idPrefix: string,
): Raw {
  const segments = resolveMentions(step.text, step.refs);
  if (segments.every((segment) => segment.kind === "text")) {
    return html`${step.text}`;
  }

  return html`${segments.map((segment, index) => {
    if (segment.kind === "text") return html`${segment.text}`;

    const amount = amounts.get(segment.ingredientId) ?? "";
    if (amount === "") return html`${segment.text}`;

    const id = `${idPrefix}-${index}`;
    return html`<span class="mention"
      ><input type="checkbox" id="${id}" class="mention-toggle" /><label
        for="${id}"
        ><span class="mention-amount">${amount}</span
        ><span class="mention-word">${segment.text}</span></label
      ></span
    >`;
  })}`;
}

/**
 * Every amount this recipe's own lines can offer a mention, already scaled and
 * keyed by ingredient. A duplicated ingredient shows every distinct stated
 * amount in recipe order: seeing both is safer than trusting an unverified
 * model choice about which line a word meant. Blank amounts are omitted and
 * repeats collapse.
 */
export function amountsByIngredient(
  lines: readonly RecipeLine[],
  factor: number | null,
): Map<number, string> {
  const collected = new Map<number, Set<string>>();

  for (const line of lines) {
    const amount = formatMeasurement(scaleMeasurement(line, factor));
    if (amount === "") continue;
    const values = collected.get(line.ingredientId) ?? new Set<string>();
    values.add(amount);
    collected.set(line.ingredientId, values);
  }

  return new Map(
    [...collected].map(([ingredientId, values]) => [
      ingredientId,
      [...values].join(" / "),
    ]),
  );
}

/** The ingredients and method of one recipe — a dish, or one of its parts. */
function body(
  recipe: Recipe,
  factor: number | null,
  phases?: RecipePhase[],
  bucket = "a",
): Raw {
  const lines = phases === undefined
    ? recipe.lines
    : recipe.lines.filter((line) => phases.includes(line.phase));
  const steps = phases === undefined
    ? recipe.steps
    : recipe.steps.filter((step) => phases.includes(step.phase));

  // Every line of this recipe, not only the ones this phase renders: a step
  // done after the parts still mentions an ingredient listed before them.
  const amounts = amountsByIngredient(recipe.lines, factor);

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
          <ol class="steps">
            ${steps.map(
              (step, index) => html`<li>
                ${stepText(step, amounts, `m${recipe.id}${bucket}${index}`)}
              </li>`,
            )}
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
  const canRevealAmounts = hasRevealableMention(recipe, factor);

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

    ${canRevealAmounts
      ? html`<input
            type="checkbox"
            id="reveal-all-amounts"
            class="reveal-all"
          /><label for="reveal-all-amounts" class="reveal-all-label"
            ><span class="reveal-all-show">Näytä kaikki määrät</span
            ><span class="reveal-all-hide">Piilota määrät</span></label
          >`
      : ""}

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
    <!-- A different bucket letter, because this is the same recipe rendered a
         second time and two mentions may not share a checkbox id. -->
    ${recipe.parts.length === 0
      ? ""
      : body(recipe, factor, ["after_parts"], "b")}

    <!-- Still stored, still one tap away, but not competing with the cooking. -->
    <details class="source-original">
      <summary>Näytä alkuperäinen</summary>
      <p class="source-text">${recipe.sourceText}</p>
    </details>

    ${keepAwake()}
    ${MENTION_STYLE}

    <p class="recipe-edit">
      <a href="/recipes/${recipe.id}/edit">Muokkaa reseptiä</a>
    </p>`;
}

/** Whether this dish or any of its parts has an amount the toggle can reveal. */
function hasRevealableMention(recipe: Recipe, factor: number | null): boolean {
  const amounts = amountsByIngredient(recipe.lines, factor);
  const thisRecipeHasOne = recipe.steps.some((step) =>
    resolveMentions(step.text, step.refs).some(
      (segment) =>
        segment.kind === "mention" &&
        (amounts.get(segment.ingredientId) ?? "") !== "",
    )
  );

  return thisRecipeHasOne || recipe.parts.some(
    (part) => hasRevealableMention(part, factor),
  );
}

/**
 * A mention should read as the sentence it is part of, not as a button — the
 * instruction is the thing being read, and a row of chips through the middle of
 * it is harder to follow than the plain text was. So: the same font, the same
 * colour, and a faint dotted underline as the only hint that it does anything.
 *
 * Kept here rather than in the shell's stylesheet because it is one screen's
 * concern, and `src/html.ts` is the file every screen shares.
 */
const MENTION_STYLE = html`<style>
  .steps li { padding: .35rem 0; line-height: 1.55; }
  .mention { display: inline; }
  /* Off-screen rather than display:none — a hidden control cannot be focused,
     and this one is how a keyboard reaches the amount. */
  .mention-toggle, .reveal-all {
    position: absolute; width: 1px; height: 1px;
    margin: 0; padding: 0; opacity: 0; pointer-events: none;
  }
  .reveal-all-label {
    display: inline-flex; align-items: center; min-height: var(--tap-compact);
    padding: 0 .75rem; margin: 0 0 .65rem; cursor: pointer;
    border: 1px solid var(--edge); border-radius: var(--radius);
    background: var(--surface); font-weight: 600;
  }
  .reveal-all-hide { display: none; }
  .reveal-all:checked + .reveal-all-label .reveal-all-show { display: none; }
  .reveal-all:checked + .reveal-all-label .reveal-all-hide { display: inline; }
  .reveal-all:focus-visible + .reveal-all-label {
    outline: 2px solid var(--accent); outline-offset: 2px;
  }
  .mention > label {
    display: inline; cursor: pointer;
    text-decoration: underline dotted var(--muted);
    text-underline-offset: .2em;
  }
  .mention-amount {
    font-weight: 600; font-variant-numeric: tabular-nums;
    color: var(--accent); margin-right: .3em;
  }
  .mention-toggle:not(:checked) + label .mention-amount { display: none; }
  .reveal-all:checked ~ * .mention-toggle:not(:checked) + label .mention-amount {
    display: inline;
  }
  .mention-toggle:checked + label { text-decoration: none; }
  .mention-toggle:focus-visible + label {
    outline: 2px solid var(--accent); outline-offset: 2px; border-radius: .2rem;
  }
</style>`;

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
