import { problem } from "./auth.ts";
import { html, page, type Raw } from "./html.ts";
import { ingredientsFor, type IngredientSummary } from "./ingredients.ts";
import type { DraftLine } from "./intake.ts";
import {
  emptyLine,
  lineRow,
  readLines,
  readSteps,
  readWhole,
  SPARE_LINES,
} from "./line-form.ts";
import type { Member } from "./members.ts";
import { findRecipe, type Recipe } from "./recipes.ts";
import { replaceRecipe, SaveRefused } from "./recipe-save.ts";
import type { RouteContext } from "./router.ts";

/**
 * Editing a saved recipe. The same fields as the correction screen, writable,
 * with the same approve-a-new-one step on the ingredient picker.
 *
 * Source text is shown read-only at the bottom and is never edited — it is the
 * record of what actually arrived, and a recipe re-imported on a future model
 * needs exactly that text.
 */

/** `GET /recipes/:id/edit` */
export async function editorScreen(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipe = await load(env.DB, member, params["id"]);
  if (recipe === null) return notFound();

  const ingredients = await ingredientsFor(env.DB, member.householdId);
  return page(`Muokkaa: ${recipe.title}`, editorForm(recipe, ingredients));
}

/** `POST /recipes/:id` — a form cannot send PUT. */
export async function saveEditForm(
  { env, request, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipe = await load(env.DB, member, params["id"]);
  if (recipe === null) return notFound();

  const form = await request.formData();

  try {
    await replaceRecipe(env.DB, member, recipe.id, {
      title: String(form.get("title") ?? ""),
      yieldPortions: readWhole(form.get("yield")),
      // Never taken from the form: it is the record of what arrived.
      sourceText: recipe.sourceText,
      sourceRoute: recipe.sourceRoute as "pasted" | "photographed",
      structuredBy: null,
      steps: readSteps(form),
      lines: readLines(form, Number(form.get("lineCount") ?? 0)),
    });
  } catch (error) {
    if (!(error instanceof SaveRefused)) throw error;

    const ingredients = await ingredientsFor(env.DB, member.householdId);
    const attempted = await load(env.DB, member, params["id"]);
    return page(
      `Muokkaa: ${recipe.title}`,
      html`<p class="refused">${error.message}</p>
        ${editorForm(attempted ?? recipe, ingredients)}`,
      400,
    );
  }

  return new Response(null, {
    status: 303,
    headers: { Location: `/recipes/${recipe.id}` },
  });
}

/**
 * `POST /recipes/:id/delete` — refused while the recipe is on a menu.
 *
 * The schema would refuse it too: foreign keys are on and meal_entry.recipe_id
 * has no cascade, so the delete fails loudly. This says why instead.
 */
export async function deleteRecipeForm(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipe = await load(env.DB, member, params["id"]);
  if (recipe === null) return notFound();

  const onMenu = await countOnMenu(env.DB, member.householdId, recipe.id);
  if (onMenu > 0) {
    return page(
      "Ei voi poistaa",
      html`<h1>Ei voi poistaa</h1>
        <p class="refused">
          ${recipe.title} on ruokalistalla ${onMenu} kertaa. Poista se ensin
          viikoilta.
        </p>
        <p><a href="/recipes/${recipe.id}">Takaisin reseptiin</a></p>`,
      409,
    );
  }

  await env.DB.prepare("DELETE FROM recipe WHERE id = ? AND household_id = ?")
    .bind(recipe.id, member.householdId)
    .run();

  return new Response(null, { status: 303, headers: { Location: "/recipes" } });
}

/** `DELETE /api/recipes/:id` */
export async function apiDeleteRecipe(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipe = await load(env.DB, member, params["id"]);
  if (recipe === null) return problem(404, "No such recipe.");

  const onMenu = await countOnMenu(env.DB, member.householdId, recipe.id);
  if (onMenu > 0) {
    return problem(409, "That recipe is on the menu.");
  }

  await env.DB.prepare("DELETE FROM recipe WHERE id = ? AND household_id = ?")
    .bind(recipe.id, member.householdId)
    .run();

  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------- rendering

function editorForm(recipe: Recipe, ingredients: IngredientSummary[]): Raw {
  const rows: DraftLine[] = [
    ...recipe.lines.map((line) => ({
      quantity: line.quantity,
      quantityMax: line.quantityMax,
      unit: line.unit,
      altQuantity: line.altQuantity,
      altUnit: line.altUnit,
      ingredientId: idOf(line.ingredient, ingredients),
      ingredientName: line.ingredient,
      sourceLine: line.sourceLine,
      // A saved part is a recipe of its own, so a recipe's own lines never
      // carry one.
      section: null,
    })),
    ...Array.from({ length: SPARE_LINES }, emptyLine),
  ];

  return html`<h1>Muokkaa reseptiä</h1>
    <form method="post" action="/recipes/${recipe.id}" class="stacked">
      <input type="hidden" name="lineCount" value="${rows.length}" />

      <label for="title">Nimi</label>
      <input id="title" name="title" value="${recipe.title}" required />

      <label for="yield">Annoksia</label>
      <input
        id="yield"
        name="yield"
        inputmode="numeric"
        value="${recipe.yieldPortions ?? ""}"
        placeholder="Tyhjä, jos teksti ei kerro"
      />

      <h2>Ainekset</h2>
      <ol class="edit-lines">
        ${rows.map((line, index) =>
          lineRow(line, index, ingredients, { reorderable: true }),
        )}
      </ol>

      <h2>Valmistus</h2>
      <ol class="edit-steps">
        ${recipe.steps.map(
          (step, index) => html`<li>
            <input
              name="step.${index}.position"
              inputmode="numeric"
              value="${index + 1}"
              aria-label="Järjestys"
              class="position"
            />
            <textarea name="step.${index}" rows="2">${step}</textarea>
          </li>`,
        )}
        ${Array.from(
          { length: 2 },
          (_, spare) => html`<li>
            <input
              name="step.${recipe.steps.length + spare}.position"
              inputmode="numeric"
              value="${recipe.steps.length + spare + 1}"
              aria-label="Järjestys"
              class="position"
            />
            <textarea
              name="step.${recipe.steps.length + spare}"
              rows="2"
              placeholder="Uusi vaihe"
            ></textarea>
          </li>`,
        )}
      </ol>

      <button type="submit">Tallenna muutokset</button>
    </form>

    <h2>Alkuperäinen teksti</h2>
    <p class="empty">Tätä ei muokata — se on tallenne siitä, mitä saapui.</p>
    <p class="source-text">${recipe.sourceText}</p>

    <form method="post" action="/recipes/${recipe.id}/delete" class="stacked">
      <button type="submit" class="quiet">Poista resepti</button>
    </form>`;
}

function notFound(): Response {
  return page(
    "Ei löytynyt",
    html`<h1>Ei löytynyt</h1>
      <p class="empty">Tätä reseptiä ei ole.</p>`,
    404,
  );
}

async function load(
  db: D1Database,
  member: Member,
  rawId: string | undefined,
): Promise<Recipe | null> {
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return findRecipe(db, member.householdId, id);
}

async function countOnMenu(
  db: D1Database,
  householdId: number,
  recipeId: number,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT count(*) AS n FROM meal_entry WHERE household_id = ? AND recipe_id = ?",
    )
    .bind(householdId, recipeId)
    .first<{ n: number }>();

  return row?.n ?? 0;
}

/** The stored line carries the ingredient's name; the picker needs its id. */
function idOf(name: string, ingredients: IngredientSummary[]): number | null {
  return ingredients.find((i) => i.name === name)?.id ?? null;
}
