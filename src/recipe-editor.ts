import { problem } from "./auth.ts";
import { html, page, type Raw } from "./html.ts";
import { ingredientsFor, type IngredientSummary } from "./ingredients.ts";
import type { DraftLine } from "./intake.ts";
import {
  emptyLine,
  FormRefused,
  lineCountForRendering,
  lineRows,
  lineValuesFromForm,
  phaseSelect,
  readLineCount,
  readLines,
  readSteps,
  readWhole,
  SPARE_LINES,
  stepValuesForRendering,
  type LineFormValues,
  type StepFormValues,
} from "./line-form.ts";
import type { Member } from "./members.ts";
import { findRecipe, type Recipe } from "./recipes.ts";
import {
  replaceRecipe,
  SaveRefused,
  StaleRecipe,
} from "./recipe-save.ts";
import type { RouteContext } from "./router.ts";

/**
 * Editing a saved recipe. The same fields as the correction screen, writable,
 * with the same approve-a-new-one step on the ingredient picker.
 *
 * Source text is shown read-only at the bottom and is never edited — it is the
 * record of what actually arrived, and a recipe re-imported on a future model
 * needs exactly that text.
 */

interface EditorAttempt {
  form: FormData;
  lineCount: number;
  revision: number;
}

/** `GET /recipes/:id/edit` */
export async function editorScreen(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipe = await load(env.DB, member, params["id"]);
  if (recipe === null) return notFound();

  const ingredients = await ingredientsFor(env.DB, member.householdId);
  return page(
    `Muokkaa: ${recipe.title}`,
    editorForm(recipe, ingredients),
    "recipes",
  );
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
    const expectedRevision = readRevision(form.get("revision"));
    const lineCount = readLineCount(form.get("lineCount"));

    await replaceRecipe(env.DB, member, recipe.id, expectedRevision, {
      title: String(form.get("title") ?? ""),
      yieldPortions: readWhole(form.get("yield")),
      // Never taken from the form: it is the record of what arrived.
      sourceText: recipe.sourceText,
      sourceRoute: recipe.sourceRoute,
      structuredBy: null,
      steps: readSteps(form),
      lines: readLines(form, lineCount),
    });
  } catch (error) {
    if (!(error instanceof SaveRefused) && !(error instanceof FormRefused)) {
      throw error;
    }

    const latest = await load(env.DB, member, params["id"]);
    if (latest === null) return notFound();

    const stale = error instanceof StaleRecipe;
    const ingredients = await ingredientsFor(env.DB, member.householdId);
    return page(
      `Muokkaa: ${latest.title}`,
      html`<p class="refused">${error.message}</p>
        ${editorForm(latest, ingredients, {
          form,
          lineCount: lineCountForRendering(form),
          // A stale form must deliberately submit against the version now on
          // screen. Other validation failures keep their original revision, so
          // they cannot quietly overwrite an edit made in another tab.
          revision: stale
            ? latest.revision
            : revisionForRendering(form, recipe.revision),
        })}`,
      "recipes",
      stale ? 409 : 400,
    );
  }

  return new Response(null, {
    status: 303,
    headers: { Location: `/recipes/${recipe.id}` },
  });
}

/**
 * `POST /recipes/:id/delete` — refused while the recipe or one of its parts is
 * on a menu. Children are deleted before their parent in one D1 batch, because
 * the self-reference deliberately predates an ON DELETE action.
 */
export async function deleteRecipeForm(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipe = await load(env.DB, member, params["id"]);
  if (recipe === null) return notFound();

  const onMenu = await countOnMenu(env.DB, member.householdId, recipe.id);
  if (onMenu > 0) return stillPlanned(recipe, onMenu);

  await deleteRecipeTree(env.DB, member.householdId, recipe.id);
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
    return problem(409, "That recipe or one of its parts is on the menu.");
  }

  await deleteRecipeTree(env.DB, member.householdId, recipe.id);
  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------- rendering

function editorForm(
  recipe: Recipe,
  ingredients: IngredientSummary[],
  attempted?: EditorAttempt,
): Raw {
  const rows: Array<DraftLine | LineFormValues> = attempted
    ? Array.from({ length: attempted.lineCount }, (_, index) =>
        lineValuesFromForm(attempted.form, index),
      )
    : [
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
          phase: line.phase,
          // A note is about an import, not about a saved recipe.
          note: null,
        } satisfies DraftLine)),
        ...Array.from({ length: SPARE_LINES }, emptyLine),
      ];

  const steps: StepFormValues[] = attempted
    ? stepValuesForRendering(attempted.form)
    : [
        ...recipe.steps.map((step, index) => ({
          index,
          position: String(index + 1),
          text: step.text,
          section: "",
          phase: step.phase ?? "",
        })),
        ...Array.from({ length: 2 }, (_, spare) => {
          const index = recipe.steps.length + spare;
          return {
            index,
            position: String(index + 1),
            text: "",
            section: "",
            phase: "",
          };
        }),
      ];

  const title = attempted
    ? String(attempted.form.get("title") ?? "")
    : recipe.title;
  const yieldValue = attempted
    ? String(attempted.form.get("yield") ?? "")
    : String(recipe.yieldPortions ?? "");
  const revision = attempted?.revision ?? recipe.revision;

  return html`<h1>Muokkaa reseptiä</h1>
    <form method="post" action="/recipes/${recipe.id}" class="stacked">
      <input type="hidden" name="lineCount" value="${rows.length}" />
      <input type="hidden" name="revision" value="${revision}" />

      <label for="title">Nimi</label>
      <input id="title" name="title" value="${title}" required />

      <label for="yield">Annoksia</label>
      <input
        id="yield"
        name="yield"
        inputmode="numeric"
        value="${yieldValue}"
        placeholder="Tyhjä, jos teksti ei kerro"
      />

      <h2>Ainekset</h2>
      ${lineRows(rows, ingredients, {
        reorderable: true,
        phases: recipe.parts.length > 0,
      })}

      <h2>Valmistus</h2>
      <ol class="edit-steps">
        ${steps.map(
          (step) => html`<li class="${recipe.parts.length > 0 ? "has-phase" : ""}">
            <input
              name="step.${step.index}.position"
              inputmode="numeric"
              value="${step.position}"
              aria-label="Järjestys"
              class="position"
            />
            <textarea name="step.${step.index}" rows="2" placeholder="Uusi vaihe"
              >${step.text}</textarea
            >
            ${recipe.parts.length > 0
              ? phaseSelect(`step.${step.index}.phase`, step.phase)
              : ""}
          </li>`,
        )}
      </ol>

      <button type="submit">Tallenna muutokset</button>
    </form>

    <h2>Alkuperäinen teksti</h2>
    <p class="empty">Tätä ei muokata — se on tallenne siitä, mitä saapui.</p>
    <p class="source-text">${recipe.sourceText}</p>

    <!-- A link, not a submit: deleting a recipe is not something a mistyped tap
         should finish. The confirmation screen is where the button lives. -->
    <p class="recipe-delete">
      <a href="/recipes/${recipe.id}/delete">Poista resepti</a>
    </p>`;
}

/**
 * `GET /recipes/:id/delete` — the confirmation.
 *
 * Deleting takes the recipe's parts with it and nothing brings them back, so it
 * asks first, says what goes, and refuses early if the recipe is still planned.
 */
export async function confirmDeleteScreen(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipe = await load(env.DB, member, params["id"]);
  if (recipe === null) return notFound();

  const onMenu = await countOnMenu(env.DB, member.householdId, recipe.id);
  if (onMenu > 0) return stillPlanned(recipe, onMenu);

  return page(
    `Poista: ${recipe.title}`,
    html`<h1>Poistetaanko ${recipe.title}?</h1>
      <p>
        Resepti ja sen ${recipe.parts.length === 0
          ? "sisältö poistetaan"
          : `${recipe.parts.length} osaa poistetaan`}
        lopullisesti. Tätä ei voi peruuttaa.
      </p>
      ${recipe.parts.length === 0
        ? ""
        : html`<ul class="plain">
            ${recipe.parts.map((part) => html`<li>${part.title}</li>`)}
          </ul>`}

      <form method="post" action="/recipes/${recipe.id}/delete" class="confirm">
        <button type="submit" class="danger">Poista lopullisesti</button>
      </form>
      <p><a href="/recipes/${recipe.id}">Peruuta</a></p>`,
    "recipes",
  );
}

function stillPlanned(recipe: Recipe, onMenu: number): Response {
  return page(
    "Ei voi poistaa",
    html`<h1>Ei voi poistaa</h1>
      <p class="refused">
        ${recipe.title} tai sen osa on ruokalistalla ${onMenu} kertaa. Poista se
        ensin viikoilta.
      </p>
      <p><a href="/recipes/${recipe.id}">Takaisin reseptiin</a></p>`,
    "recipes",
    409,
  );
}

function notFound(): Response {
  return page(
    "Ei löytynyt",
    html`<h1>Ei löytynyt</h1>
      <p class="empty">Tätä reseptiä ei ole.</p>`,
    "recipes",
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
      `SELECT count(*) AS n
         FROM meal_entry
        WHERE household_id = ?
          AND recipe_id IN (
            SELECT id FROM recipe
             WHERE household_id = ? AND (id = ? OR parent_id = ?)
          )`,
    )
    .bind(householdId, householdId, recipeId, recipeId)
    .first<{ n: number }>();

  return row?.n ?? 0;
}

async function deleteRecipeTree(
  db: D1Database,
  householdId: number,
  recipeId: number,
): Promise<void> {
  await db.batch([
    db
      .prepare("DELETE FROM recipe WHERE parent_id = ? AND household_id = ?")
      .bind(recipeId, householdId),
    db
      .prepare("DELETE FROM recipe WHERE id = ? AND household_id = ?")
      .bind(recipeId, householdId),
  ]);
}

/** The stored line carries the ingredient's name; the picker needs its id. */
function idOf(name: string, ingredients: IngredientSummary[]): number | null {
  return ingredients.find((i) => i.name === name)?.id ?? null;
}

function readRevision(value: FormDataEntryValue | null): number {
  const revision = Number(String(value ?? "").trim());
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new FormRefused("Reseptin versio on virheellinen. Lataa sivu uudelleen.");
  }
  return revision;
}

function revisionForRendering(form: FormData, fallback: number): number {
  try {
    return readRevision(form.get("revision"));
  } catch {
    return fallback;
  }
}
