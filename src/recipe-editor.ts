import { problem } from "./auth.ts";
import {
  CATEGORY_STYLE,
  categoryChoices,
  loadVocabulary,
  type Vocabulary,
} from "./categories.ts";
import { html, page, raw, type Raw } from "./html.ts";
import { encodeDraftRefs } from "./ingredient-refs.ts";
import { ingredientsFor, type IngredientSummary } from "./ingredients.ts";
import type { DraftLine } from "./intake.ts";
import {
  FormRefused,
  lineCountForRendering,
  lineRows,
  lineValuesFromForm,
  MAX_LINES,
  phaseSelect,
  readLineCount,
  readLines,
  readSteps,
  readWhole,
  stepValuesForRendering,
  stepValuesFromForm,
  type LineFormValues,
  type StepFormValues,
} from "./line-form.ts";
import { removalConflicts, type RemovalConflict } from "./line-removal.ts";
import type { Member } from "./members.ts";
import {
  deleteImagesForRecipeTree,
  imageRow,
  removeRecipeImage,
  storeRecipeImage,
} from "./recipe-images.ts";
import { findRecipe, recipeImage, type Recipe } from "./recipes.ts";
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
  /** Put the cursor here, so `+ Lisää aines` lands on the row it just made. */
  autofocusRow?: number;
  /** Removals the steps still argue with (issue #128). */
  conflicts?: RemovalConflict[];
}

/**
 * A removal refused because a step still mentions the ingredient. It carries
 * what to show, because the answer is not a sentence — it is the sentences.
 */
class MentionedRemoval extends FormRefused {
  constructor(readonly conflicts: RemovalConflict[]) {
    super(
      conflicts.length === 1
        ? `${conflicts[0]?.name} esiintyy vielä valmistusohjeessa, joten sitä ei poistettu.`
        : "Osa poistettavista aineksista esiintyy vielä valmistusohjeessa, joten niitä ei poistettu.",
    );
  }
}

/**
 * Shrink the chosen picture in the browser before it is ever uploaded.
 *
 * This is where "not stored as-is" actually happens for a person: an image tool
 * hands you a 3000-pixel PNG, and what leaves the phone is a 1200-pixel JPEG a
 * few hundred kilobytes big. A Worker cannot re-encode an image without another
 * Cloudflare product, but a canvas can, which is the same reason the intake
 * camera route downscales here rather than on the server.
 *
 * Everything is feature-detected and every failure falls back to the plain form
 * post, so an old iPad still uploads — it just has to send a picture already
 * within the bounds the server states. No regular expressions and no
 * backslashes: this is a template literal, so a backslash never reaches the
 * browser.
 */
const SHRINK_ISLAND = `
(function () {
  var form = document.getElementById('recipe-image-form');
  if (!form || !window.fetch || !window.FormData || !window.createImageBitmap) return;

  var LONG_EDGE = 1200;
  var input = document.getElementById('recipe-image');
  var button = form.querySelector('button[type=submit]');
  var busy = false;

  function shrink(file) {
    return createImageBitmap(file).then(function (bitmap) {
      var scale = Math.min(1, LONG_EDGE / Math.max(bitmap.width, bitmap.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      if (!canvas.toBlob) return null;
      return new Promise(function (resolve) {
        canvas.toBlob(function (blob) { resolve(blob); }, 'image/jpeg', 0.85);
      });
    });
  }

  form.addEventListener('submit', function (event) {
    if (busy) return;
    var file = input && input.files && input.files[0];
    if (!file) return;

    event.preventDefault();
    busy = true;
    if (button) button.disabled = true;

    shrink(file).then(function (blob) {
      if (!blob) throw new Error('cannot re-encode');
      var body = new FormData();
      body.append('image', blob, 'kuva.jpg');
      return fetch(form.action, {
        method: 'POST',
        body: body,
        credentials: 'same-origin',
      });
    }).then(function (response) {
      if (response.ok || response.redirected) {
        window.location.href = form.getAttribute('data-editor');
        return null;
      }
      // The server refused the shrunk picture too. It answered with the editor
      // and the reason on it, so show exactly that.
      return response.text().then(function (body) {
        document.open();
        document.write(body);
        document.close();
      });
    }).catch(function () {
      // Canvas, network, anything: hand it back to the browser, which posts the
      // file as chosen and gets a plain server answer.
      busy = false;
      if (button) button.disabled = false;
      form.submit();
    });
  });
})();
`;

/** `GET /recipes/:id/edit` */
export async function editorScreen(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipe = await load(env.DB, member, params["id"]);
  if (recipe === null) return notFound(member);

  const [ingredients, vocabulary] = await Promise.all([
    ingredientsFor(env.DB, member.householdId),
    loadVocabulary(env.DB),
  ]);
  return page(
    `Muokkaa: ${recipe.title}`,
    editorForm(recipe, ingredients, vocabulary),
    "recipes",
    member,
  );
}

/** `POST /recipes/:id` — a form cannot send PUT. */
export async function saveEditForm(
  { env, request, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipe = await load(env.DB, member, params["id"]);
  if (recipe === null) return notFound(member);

  const form = await request.formData();

  // `+ Lisää aines` is a submit, not a script, so it arrives here. It is not a
  // save: nothing is validated, nothing is written, and the form comes back with
  // one more row and everything typed so far still in it.
  if (form.get("addLine") !== null) {
    return addedLine(env, member, recipe, form);
  }

  try {
    const expectedRevision = readRevision(form.get("revision"));
    const lineCount = readLineCount(form.get("lineCount"));
    await guardRemovals(env, member, form, lineCount);

    await replaceRecipe(env.DB, member, recipe.id, expectedRevision, {
      title: String(form.get("title") ?? ""),
      yieldPortions: readWhole(form.get("yield")),
      // Never taken from the form: it is the record of what arrived.
      sourceText: recipe.sourceText,
      sourceRoute: recipe.sourceRoute,
      structuredBy: null,
      steps: readSteps(form),
      lines: readLines(form, lineCount),
      // A part shows no category picker, so it submits none and keeps none —
      // the dish is what gets browsed for (#196).
      categories: (await loadVocabulary(env.DB)).read(form),
    },
    // A dish written entirely in named parts has no ingredient lines of its
    // own, and it is still a whole recipe (issue #184).
    { hasParts: recipe.parts.length > 0 });
  } catch (error) {
    if (!(error instanceof SaveRefused) && !(error instanceof FormRefused)) {
      throw error;
    }

    const latest = await load(env.DB, member, params["id"]);
    if (latest === null) return notFound(member);

    const stale = error instanceof StaleRecipe;
    const [ingredients, vocabulary] = await Promise.all([
      ingredientsFor(env.DB, member.householdId),
      loadVocabulary(env.DB),
    ]);
    return page(
      `Muokkaa: ${latest.title}`,
      html`<p class="refused">${error.message}</p>
        ${editorForm(latest, ingredients, vocabulary, {
          form,
          lineCount: lineCountForRendering(form),
          // A stale form must deliberately submit against the version now on
          // screen. Other validation failures keep their original revision, so
          // they cannot quietly overwrite an edit made in another tab.
          revision: stale
            ? latest.revision
            : revisionForRendering(form, recipe.revision),
          conflicts:
            error instanceof MentionedRemoval ? error.conflicts : undefined,
        })}`,
      "recipes",
      member,
      stale ? 409 : 400,
    );
  }

  return new Response(null, {
    status: 303,
    headers: { Location: `/recipes/${recipe.id}` },
  });
}

/**
 * One more ingredient row, and the cursor in it.
 *
 * The form is re-rendered from what was submitted rather than from the stored
 * recipe, so a member who has already retyped three amounts does not lose them
 * for wanting a fourth line.
 */
async function addedLine(
  env: RouteContext["env"],
  member: Member,
  recipe: Recipe,
  form: FormData,
): Promise<Response> {
  const [ingredients, vocabulary] = await Promise.all([
    ingredientsFor(env.DB, member.householdId),
    loadVocabulary(env.DB),
  ]);
  const lineCount = lineCountForRendering(form);
  const revision = revisionForRendering(form, recipe.revision);

  if (lineCount >= MAX_LINES) {
    return page(
      `Muokkaa: ${recipe.title}`,
      html`<p class="refused">Ainesrivejä voi olla enintään ${MAX_LINES}.</p>
        ${editorForm(recipe, ingredients, vocabulary, { form, lineCount, revision })}`,
      "recipes",
      member,
      400,
    );
  }

  return page(
    `Muokkaa: ${recipe.title}`,
    editorForm(recipe, ingredients, vocabulary, {
      form,
      lineCount: lineCount + 1,
      revision,
      autofocusRow: lineCount,
    }),
    "recipes",
    member,
  );
}

/**
 * Refuse a removal the preparation steps still contradict, unless the member
 * has deliberately said `Poista silti`.
 *
 * The ingredient list is only read when something is actually being removed, so
 * an ordinary save still costs one query fewer.
 */
async function guardRemovals(
  env: RouteContext["env"],
  member: Member,
  form: FormData,
  lineCount: number,
): Promise<void> {
  if (form.get("forceRemove") !== null) return;

  const rows = Array.from({ length: lineCount }, (_, index) =>
    lineValuesFromForm(form, index),
  );
  if (!rows.some((row) => row.remove)) return;

  const ingredients = await ingredientsFor(env.DB, member.householdId);
  const conflicts = removalConflicts(rows, stepValuesFromForm(form), ingredients);
  if (conflicts.length > 0) throw new MentionedRemoval(conflicts);
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
  if (recipe === null) return notFound(member);

  if (recipe.publishedAt !== null || recipe.shareCount > 0) {
    return stillShared(member, recipe);
  }

  const onMenu = await countOnMenu(env.DB, recipe.id);
  if (onMenu > 0) return stillPlanned(member, recipe, onMenu);

  await deleteImagesForRecipeTree(env, member.householdId, recipe.id);
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

  if (recipe.publishedAt !== null || recipe.shareCount > 0) {
    return problem(409, "That recipe is shared. Make it private first.");
  }

  const onMenu = await countOnMenu(env.DB, recipe.id);
  if (onMenu > 0) {
    return problem(409, "That recipe or one of its parts is on the menu.");
  }

  await deleteImagesForRecipeTree(env, member.householdId, recipe.id);
  await deleteRecipeTree(env.DB, member.householdId, recipe.id);
  return new Response(null, { status: 204 });
}

/**
 * `POST /recipes/:id/image` — the editor's own upload, which is the only
 * upload control anywhere in the app.
 *
 * A refusal re-renders the editor with the reason at the top, the same as every
 * other refusal here. The API's JSON answer belongs to the API; a browser that
 * posted a form gets a screen back.
 */
export async function uploadRecipeImageForm(
  { env, request, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipe = await load(env.DB, member, params["id"]);
  if (recipe === null) return notFound(member);

  const form = await request.formData();
  const entry = form.get("image");
  if (!(entry instanceof File) || entry.size === 0) {
    return imageRefused(env, member, recipe, "Valitse kuva.", 400);
  }

  const refusal = await storeRecipeImage(
    env,
    member.householdId,
    recipe.id,
    recipe.imageKey,
    await entry.arrayBuffer(),
  );
  if (refusal !== null) {
    return imageRefused(env, member, recipe, refusal.finnish, refusal.status);
  }

  return seeEditor(recipe.id);
}

/** `POST /recipes/:id/image/delete` — the editor's remove button. */
export async function deleteRecipeImageForm(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipe = await load(env.DB, member, params["id"]);
  if (recipe === null) return notFound(member);

  await removeRecipeImage(env, member.householdId, recipe.id, recipe.imageKey);
  return seeEditor(recipe.id);
}

/**
 * The editor again, with the reason the picture was not taken.
 *
 * The recipe is re-read rather than reused: the refusal may have arrived after
 * the row moved on, and the image the screen shows has to be the one actually
 * stored.
 */
async function imageRefused(
  env: RouteContext["env"],
  member: Member,
  recipe: Recipe,
  message: string,
  status: number,
): Promise<Response> {
  const [ingredients, row, vocabulary] = await Promise.all([
    ingredientsFor(env.DB, member.householdId),
    imageRow(env.DB, member.householdId, recipe.id),
    loadVocabulary(env.DB),
  ]);

  return page(
    `Muokkaa: ${recipe.title}`,
    html`<p class="refused">${message}</p>
      ${editorForm({ ...recipe, imageKey: row?.image_key ?? null }, ingredients, vocabulary)}`,
    "recipes",
    member,
    status,
  );
}

function seeEditor(recipeId: number): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: `/recipes/${recipeId}/edit` },
  });
}

// ---------------------------------------------------------------- rendering

function editorForm(
  recipe: Recipe,
  ingredients: IngredientSummary[],
  vocabulary: Vocabulary,
  attempted?: EditorAttempt,
): Raw {
  const rows: Array<DraftLine | LineFormValues> = attempted
    ? Array.from({ length: attempted.lineCount }, (_, index) =>
        lineValuesFromForm(attempted.form, index),
      )
    : // No blank spares: `+ Lisää aines` at the end of the list asks for one
      // row when one is wanted (issue #128).
      recipe.lines.map((line) => ({
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
          alternativeGroup: line.alternativeGroup,
          // A note is about an import, not about a saved recipe.
          note: null,
        } satisfies DraftLine));

  // A saved mention names an ingredient, but the form talks in row indexes.
  // Any row carrying that ingredient is enough: the screen reveals every
  // distinct amount from all of them, and `expectedIngredientId` still catches
  // a row that gets repointed while the form is open.
  const rowOfIngredient = new Map<number, number>();
  recipe.lines.forEach((line, index) => {
    if (!rowOfIngredient.has(line.ingredientId)) {
      rowOfIngredient.set(line.ingredientId, index);
    }
  });

  const steps: StepFormValues[] = attempted
    ? stepValuesForRendering(attempted.form)
    : [
        ...recipe.steps.map((step, index) => ({
          index,
          position: String(index + 1),
          text: step.text,
          section: "",
          phase: step.phase ?? "",
          refs: encodeDraftRefs(
            step.refs.flatMap((ref) => {
              const lineIndex = rowOfIngredient.get(ref.ingredientId);
              // An ingredient that is no longer on the recipe has no row to
              // point at, so the mention quietly stops being a link.
              return lineIndex === undefined
                ? []
                : [{
                    lineIndex,
                    matchedText: ref.matchedText,
                    approxPosition: ref.approxPosition,
                    // Which ingredient, as well as which row. The row can be
                    // repointed while this form is open, and then the index
                    // alone would hand the mention to whatever took its place.
                    expectedIngredientId: ref.ingredientId,
                  }];
            }),
          ),
        })),
        ...Array.from({ length: 2 }, (_, spare) => {
          const index = recipe.steps.length + spare;
          return {
            index,
            position: String(index + 1),
            text: "",
            section: "",
            phase: "",
            refs: "",
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
  const hasPicture = recipe.imageKey !== null;
  // A refused save re-renders what was ticked, not what is stored: the point of
  // the refusal is that the member's own edit is still in front of them.
  const categories = attempted
    ? vocabulary.read(attempted.form)
    : recipe.categories;

  return html`<h1>Muokkaa reseptiä</h1>
    <section class="recipe-image-editor">
      <h2>Kuva</h2>
      ${recipeImage(recipe)}
      <form
        method="post"
        action="/recipes/${recipe.id}/image"
        enctype="multipart/form-data"
        class="stacked"
        id="recipe-image-form"
        data-editor="/recipes/${recipe.id}/edit"
      >
        <label for="recipe-image">
          ${hasPicture ? "Valitse uusi kuva" : "Valitse kuva"}
        </label>
        <input
          id="recipe-image"
          name="image"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          required
        />
        <p class="empty">JPEG, PNG tai WebP. Iso kuva pienennetään ennen lähetystä.</p>
        <button type="submit">${hasPicture ? "Vaihda kuva" : "Lisää kuva"}</button>
      </form>
      ${hasPicture
        ? html`<form method="post" action="/recipes/${recipe.id}/image/delete">
            <button type="submit" class="danger">Poista kuva</button>
          </form>`
        : ""}
    </section>
    ${raw(`<script>${SHRINK_ISLAND}</script>`)}

    <form method="post" action="/recipes/${recipe.id}" class="stacked">
      <!-- The browser submits a form through its *first* submit button when
           somebody presses Enter in a text field, and the first one on this
           form is now the add-an-ingredient one. This copy of the save button
           is here so
           that Enter still saves. Hidden from the accessibility tree and out of
           the tab order, because it is the same button as the one at the end. -->
      <button
        type="submit"
        class="default-submit"
        tabindex="-1"
        aria-hidden="true"
      >
        Tallenna muutokset
      </button>
      <input type="hidden" name="lineCount" value="${rows.length}" />
      <input type="hidden" name="revision" value="${revision}" />

      <label for="title">Nimi</label>
      <input id="title" name="title" value="${title}" required />

      <!-- What the source said the recipe makes. Since #165 this is metadata
           and nothing scales by it, so the label says whose claim it is. -->
      <label for="yield">Annoksia lähteen mukaan</label>
      <input
        id="yield"
        name="yield"
        inputmode="numeric"
        value="${yieldValue}"
        placeholder="Tyhjä, jos teksti ei kerro"
      />

      <!-- Only a dish carries categories. A part is a recipe row (ADR-0002),
           but nobody browses the store for a juustokastike. -->
      ${recipe.parentId === null ? categoryChoices(vocabulary, categories) : ""}

      <h2>Ainekset</h2>
      ${lineRows(rows, ingredients, {
        compact: true,
        reorderable: true,
        phases: recipe.parts.length > 0,
        ...(attempted?.autofocusRow === undefined
          ? {}
          : { autofocusRow: attempted.autofocusRow }),
      })}
      ${mentionedRemovals(attempted?.conflicts ?? [])}

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
            <input type="hidden" name="step.${step.index}.refs" value="${step.refs}" />
            <textarea name="step.${step.index}" rows="2" placeholder="Uusi vaihe"
              >${step.text}</textarea
            >
            ${recipe.parts.length > 0
              ? phaseSelect(`step.${step.index}.phase`, step.phase)
              : ""}
          </li>`,
        )}
      </ol>

      <!-- Sticky rather than at the end of the form: the editor is long enough
           that on a phone the save button used to be several screens below
           whatever was being changed (issue #184). It rides just above the tab
           strip while the form scrolls and settles here at the end. -->
      <div class="editor-actions">
        <button type="submit" class="primary">Tallenna muutokset</button>
      </div>
    </form>

    <h2>Alkuperäinen teksti</h2>
    <p class="empty">Tätä ei muokata — se on tallenne siitä, mitä saapui.</p>
    <p class="source-text">${recipe.sourceText}</p>

    <!-- A link, not a submit: deleting a recipe is not something a mistyped tap
         should finish. The confirmation screen is where the button lives. -->
    <p class="recipe-delete">
      <a href="/recipes/${recipe.id}/delete">Poista resepti</a>
    </p>
    ${CATEGORY_STYLE}`;
}

/**
 * Why a removal did not happen, and where to go and fix it.
 *
 * It sits between the ingredients and the steps because that is the direction
 * it is pointing: the ingredient row is right, the sentence below is what has to
 * change. The forcing button is inside this block rather than beside the save
 * button, so it can never be the one somebody presses by habit.
 */
function mentionedRemovals(conflicts: RemovalConflict[]): Raw {
  if (conflicts.length === 0) return raw("");

  return html`<section class="line-conflicts">
    <h3>Aines on vielä valmistusohjeessa</h3>
    <p>
      Korjaa tai poista alla olevat kohdat valmistusohjeesta ja tallenna
      uudelleen — sen jälkeen poisto onnistuu tavalliseen tapaan.
    </p>
    <ul class="plain">
      ${conflicts.map(
        (conflict) => html`<li>
          <strong>${conflict.name}</strong>
          <ol class="mention-steps">
            ${conflict.steps.map(
              (step) => html`<li>
                <span class="step-number">Vaihe ${step.number}</span>
                <span class="step-text">${step.text}</span>
                <span class="empty">Linkitetty: ${step.mentions.join(", ")}</span>
              </li>`,
            )}
          </ol>
        </li>`,
      )}
    </ul>
    <p class="force-remove">
      <button type="submit" name="forceRemove" value="1" class="danger">
        Poista silti
      </button>
      <span class="empty">
        Viimeinen keino: valmistusohjeeseen jää tällöin aines, jota reseptissä ei
        enää ole.
      </span>
    </p>
  </section>`;
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
  if (recipe === null) return notFound(member);

  if (recipe.publishedAt !== null || recipe.shareCount > 0) {
    return stillShared(member, recipe);
  }

  const onMenu = await countOnMenu(env.DB, recipe.id);
  if (onMenu > 0) return stillPlanned(member, recipe, onMenu);

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
    member,
  );
}

function stillPlanned(member: Member, recipe: Recipe, onMenu: number): Response {
  return page(
    "Ei voi poistaa",
    html`<h1>Ei voi poistaa</h1>
      <p class="refused">
        ${recipe.title} tai sen osa on ruokalistalla ${onMenu} kertaa. Poista se
        ensin viikoilta.
      </p>
      <p><a href="/recipes/${recipe.id}">Takaisin reseptiin</a></p>`,
    "recipes",
    member,
    409,
  );
}

/**
 * Deleting a published recipe is refused outright, and the screen says which
 * step comes first rather than only that it cannot be done.
 *
 * The order is not arbitrary. Unpublishing is where the "somebody else is
 * cooking this on Thursday" check lives, so asking for it first means deletion
 * inherits that protection instead of carrying a second copy of it that could
 * drift.
 */
function stillShared(member: Member, recipe: Recipe): Response {
  return page(
    "Ei voi poistaa",
    html`<h1>Ei voi poistaa</h1>
      <p class="refused">
        ${recipe.title} on jaettu, joten sitä ei voi poistaa. Muuta se ensin
        omaksi — se onnistuu, kun resepti ei ole pääsyn menettävien talouksien
        tulevilla ruokalistoilla.
      </p>
      <p><a href="/recipes/${recipe.id}">Takaisin reseptiin</a></p>`,
    "recipes",
    member,
    409,
  );
}

function notFound(member: Member): Response {
  return page(
    "Ei löytynyt",
    html`<h1>Ei löytynyt</h1>
      <p class="empty">Tätä reseptiä ei ole.</p>`,
    "recipes",
    member,
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

/**
 * How many planned batches — anybody's — still name this recipe or one of its
 * parts.
 *
 * Deliberately not scoped to the owning household since #143. A recipe that was
 * published can be sitting on another household's *past* weeks, and a past week
 * does not block unpublishing (see `src/recipe-publish.ts`) — so by the time a
 * delete is attempted, the rows pointing at this recipe may well belong to
 * somebody else. Deleting it anyway would break their week, and the foreign key
 * with it. The reason this household cannot delete the recipe stays the same
 * either way: it is still on a menu.
 */
async function countOnMenu(db: D1Database, recipeId: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT count(*) AS n
         FROM planned_batch
        WHERE recipe_id IN (
            SELECT id FROM recipe WHERE id = ? OR parent_id = ?
          )`,
    )
    .bind(recipeId, recipeId)
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
