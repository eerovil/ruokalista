import {
  analyseBatch,
  BatchRefused,
  recipesToSave,
  type BatchAnalysis,
} from "./batch-intake.ts";
import { remainingBundle, saveRecipesSequentially } from "./batch-save.ts";
import { html, page, type Raw } from "./html.ts";
import type { Member } from "./members.ts";
import { formatMeasurement } from "./quantities.ts";
import { saveRecipe } from "./recipe-save.ts";
import type { RouteContext } from "./router.ts";

const MAX_BUNDLE_BYTES = 2_000_000;
const MAX_FORM_BYTES = 2_100_000;

class BundleTooLarge extends BatchRefused {}

/** `GET /intake/batch` — authenticated local-file handoff from AgentDeck. */
export function batchIntakeScreen(): Response {
  return uploadPage();
}

/** `POST /intake/batch/review` — refuse the whole bundle or show one review. */
export async function reviewBatchScreen(
  { env, request }: RouteContext,
  member: Member,
): Promise<Response> {
  if (requestTooLarge(request)) {
    return uploadPage("Nippu on liian suuri; jaa se pienempiin eriin.", "", 413);
  }
  const form = await request.formData();
  let json = "";
  try {
    json = await bundleText(form);
    const analysis = await analyseBatch(env.DB, member, json);
    return page("Tarkista reseptinippu", review(analysis), "intake");
  } catch (error) {
    if (!(error instanceof BatchRefused)) throw error;
    return uploadPage(error.message, json, error instanceof BundleTooLarge ? 413 : 400);
  }
}

/** `POST /intake/batch/import` — revalidate, then save through saveRecipe. */
export async function importBatchScreen(
  { env, request }: RouteContext,
  member: Member,
): Promise<Response> {
  if (requestTooLarge(request)) {
    return uploadPage("Nippu on liian suuri; jaa se pienempiin eriin.", "", 413);
  }
  const form = await request.formData();
  const json = String(form.get("bundle") ?? "");
  let analysis: BatchAnalysis;
  try {
    assertBundleSize(json);
    analysis = await analyseBatch(env.DB, member, json);
  } catch (error) {
    if (!(error instanceof BatchRefused)) throw error;
    return uploadPage(error.message, json, error instanceof BundleTooLarge ? 413 : 400);
  }

  const choices = new Map(
    analysis.proposedIngredients.map((item) => [
      item.key,
      String(form.get(choiceName(item.key)) ?? ""),
    ]),
  );
  let recipes;
  try {
    recipes = recipesToSave(analysis, choices);
  } catch (error) {
    return page(
      "Tuonti estettiin",
      html`<h1>Tuonti estettiin</h1>
        <p class="refused">${String((error as Error).message ?? error)}</p>
        ${review(analysis)}`,
      "intake",
      400,
    );
  }

  const result = await saveRecipesSequentially(recipes, (recipe) =>
    saveRecipe(env.DB, member, recipe),
  );
  if (result.failed !== null) {
    const remainingTitles = recipes
      .slice(result.failed.index)
      .map((recipe) => recipe.title.trim());
    return resultPage(
      result.saved,
      `Reseptiä “${result.failed.title}” ei voitu tallentaa: ${String((result.failed.error as Error).message ?? result.failed.error)}`,
      500,
      {
        titles: remainingTitles,
        json: remainingBundle(analysis.json, result.failed.index),
      },
    );
  }
  return resultPage(result.saved, null, 200, null);
}

function uploadPage(message = "", json = "", status = 200): Response {
  return page(
    "Tuo AgentDeck-reseptejä",
    html`<h1>Tuo AgentDeck-reseptejä</h1>
      <p>
        Valitse AgentDeckin tekemä JSON-nippu tai liitä sen sisältö. Nippu
        tarkistetaan kokonaan ennen kuin mitään voi tallentaa, eikä tämä kutsu
        reseptin jäsentävää mallia.
      </p>
      ${message === "" ? "" : html`<p class="refused">${message}</p>`}
      <form
        method="post"
        action="/intake/batch/review"
        enctype="multipart/form-data"
        class="stacked"
      >
        <label for="batch-file">JSON-tiedosto</label>
        <input id="batch-file" name="file" type="file" accept="application/json,.json" />
        <label for="bundle">…tai JSON tekstinä</label>
        <textarea id="bundle" name="bundle" rows="14">${json}</textarea>
        <button type="submit">Tarkista nippu</button>
      </form>`,
    "intake",
    status,
  );
}

function review(analysis: BatchAnalysis): Raw {
  return html`<h1>Tarkista reseptinippu</h1>
    <p class="meta">
      ${analysis.drafts.length} reseptiä · ${analysis.structuredBy}
    </p>

    <h2>Reseptit</h2>
    <ul class="plain batch-titles">
      ${analysis.drafts.map((draft) => html`<li>${draft.title}</li>`)}
    </ul>

    <form
      method="post"
      action="/intake/batch/import"
      enctype="multipart/form-data"
      class="stacked"
    >
      <textarea name="bundle" hidden>${analysis.json}</textarea>
      <h2>Uudet ainekset</h2>
      ${analysis.proposedIngredients.length === 0
        ? html`<p class="empty">Ei uusia aineksia.</p>`
        : html`<p>
              Sama valinta koskee kaikkia nipun rivejä, joilla on tämä nimi.
            </p>
            <div class="batch-ingredients">
              ${analysis.proposedIngredients.map(
                (item, index) => html`<label>
                  ${item.name}
                  <select
                    name="${choiceName(item.key)}"
                    data-proposed-index="${index}"
                  >
                    <option value="new">Luo uutena: ${item.name}</option>
                    ${analysis.ingredients.map(
                      (ingredient) => html`<option value="${ingredient.id}">
                        Käytä olemassa olevaa: ${ingredient.name}
                      </option>`,
                    )}
                  </select>
                </label>`,
              )}
            </div>`}

      <h2>Esikatselu</h2>
      <div class="batch-previews">
        ${analysis.drafts.map(recipePreview)}
      </div>
      <button type="submit">Tuo ${analysis.drafts.length} reseptiä</button>
    </form>`;
}

function recipePreview(draft: BatchAnalysis["drafts"][number]): Raw {
  const content = [...draft.lines, ...draft.steps];
  const sections = [
    ...new Set(
      content
        .map((item) => item.section?.trim() || null)
        .filter((section): section is string => section !== null),
    ),
  ];
  const noted = draft.lines.filter((line) => line.note !== null);

  return html`<details class="batch-preview">
    <summary>${draft.title}</summary>
    <p class="meta">
      ${draft.yieldPortions === null ? "Annosmäärää ei kerrottu" : `${draft.yieldPortions} annosta`}
    </p>
    ${noted.length === 0
      ? ""
      : html`<div class="needs-answer is-doubt">
          <div><strong>Tarkista nämä rivit:</strong>
            <ul class="plain">
              ${noted.map((line) => html`<li>${line.sourceLine} — ${line.note}</li>`)}
            </ul>
          </div>
        </div>`}
    ${previewSection(draft, null, "before_parts")}
    ${sections.map((section) => previewSection(draft, section, null))}
    ${previewSection(draft, null, "after_parts")}
  </details>`;
}

function previewSection(
  draft: BatchAnalysis["drafts"][number],
  section: string | null,
  phase: "before_parts" | "after_parts" | null,
): Raw {
  const matches = (item: { section: string | null; phase: string | null }) =>
    (item.section?.trim() || null) === section &&
    (section !== null || phase === "after_parts"
      ? item.phase === phase
      : item.phase !== "after_parts");
  const lines = draft.lines.filter(matches);
  const steps = draft.steps.filter(matches);
  if (lines.length === 0 && steps.length === 0) return html``;

  return html`<section class="${section === null ? "" : "part"}">
    ${section === null ? "" : html`<h3>${section}</h3>`}
    ${lines.length === 0
      ? ""
      : html`<h4>Ainekset</h4><ul class="lines">
          ${lines.map((line) => {
            const amount = formatMeasurement(line);
            return html`<li>
              ${amount === "" ? "" : html`<span class="amount">${amount}</span> `}
              ${line.ingredientName}
              ${line.note === null ? "" : html`<span class="line-note">${line.note}</span>`}
              <span class="source">${line.sourceLine}</span>
            </li>`;
          })}
        </ul>`}
    ${steps.length === 0
      ? ""
      : html`<h4>Valmistus</h4><ol>${steps.map((step) => html`<li>${step.text}</li>`)}</ol>`}
  </section>`;
}

function resultPage(
  saved: Array<{ id: number; title: string }>,
  error: string | null,
  status: number,
  remaining: { titles: string[]; json: string } | null,
): Response {
  return page(
    error === null ? "Reseptit tuotu" : "Tuonti jäi kesken",
    html`<h1>${error === null ? "Reseptit tuotu" : "Tuonti jäi kesken"}</h1>
      ${error === null ? "" : html`<p class="refused">${error}</p>`}
      <p>${saved.length === 0 ? "Yhtään reseptiä ei tallennettu." : "Tallennetut reseptit:"}</p>
      ${saved.length === 0
        ? ""
        : html`<ul>${saved.map((recipe) => html`<li><a href="/recipes/${recipe.id}">${recipe.title}</a></li>`)}</ul>`}
      ${remaining === null
        ? ""
        : html`<h2>Tallentamatta jääneet</h2>
            <ul>${remaining.titles.map((title) => html`<li>${title}</li>`)}</ul>
            <form
              method="post"
              action="/intake/batch/review"
              enctype="multipart/form-data"
            >
              <textarea name="bundle" hidden>${remaining.json}</textarea>
              <button type="submit">Tarkista tallentamatta jääneet</button>
            </form>`}
      <p><a href="/intake/batch">Tuo toinen nippu</a></p>`,
    "intake",
    status,
  );
}

async function bundleText(form: FormData): Promise<string> {
  const file = form.get("file");
  if (file instanceof File && file.size > MAX_BUNDLE_BYTES) {
    throw new BundleTooLarge("Nippu on liian suuri; jaa se pienempiin eriin.");
  }
  const json = file instanceof File && file.size > 0
    ? await file.text()
    : String(form.get("bundle") ?? "");
  if (json.trim() === "") throw new BatchRefused("Valitse tiedosto tai liitä JSON.");
  assertBundleSize(json);
  return json;
}

function assertBundleSize(json: string): void {
  if (new TextEncoder().encode(json).byteLength > MAX_BUNDLE_BYTES) {
    throw new BundleTooLarge("Nippu on liian suuri; jaa se pienempiin eriin.");
  }
}

function requestTooLarge(request: Request): boolean {
  const length = Number(request.headers.get("Content-Length"));
  return Number.isFinite(length) && length > MAX_FORM_BYTES;
}

/** Keep a decision attached to its name if the ingredient list changes. */
function choiceName(key: string): string {
  return `ingredient.${encodeURIComponent(key)}`;
}
