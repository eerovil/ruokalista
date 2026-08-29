import { html, page, raw, streamingPage, type Raw } from "./html.ts";
import { ingredientsFor } from "./ingredients.ts";
import { collectValidatedDraft } from "./intake-jobs.ts";
import { draftFromJson, importFailureMessage, STRUCTURED_BY } from "./intake.ts";
import { MAX_LINES, MAX_STEPS } from "./line-form.ts";
import type { Member } from "./members.ts";
import { editorForm } from "./recipe-editor.ts";
import {
  MAX_INSTRUCTION,
  PromptRefused,
  proposalChanges,
  proposalForm,
  proposalForRecipe,
  readInstruction,
  sourceFor,
  streamRecipeEdit,
  type ProposalChange,
} from "./recipe-prompt-edit.ts";
import { findRecipe, type Recipe } from "./recipes.ts";
import type { RouteContext } from "./router.ts";

/**
 * *Muokkaa promptilla* (#208): the two screens around a prompt edit.
 *
 * `findRecipe` is the own-household lookup every write path uses, and both
 * routes go through it. Somebody else's published recipe is a 404 here for the
 * same reason it is a 404 in the editor — a prompt is a way of writing, and
 * nothing about it widens who may write.
 *
 * Neither screen saves anything. The proposal is rendered into the ordinary
 * recipe editor and it is that form's own `POST /recipes/:id` that writes,
 * through `validateRecipe` and `replaceRecipe` unchanged.
 */

const PROMPT_STYLE = raw(`<style>
.prompt-examples { margin: 0 0 1rem; padding-left: 1.1rem; }
.prompt-examples li { margin: 0.15rem 0; }
.prompt-changes { margin: 0 0 1rem; padding-left: 1.1rem; }
.prompt-proposal { margin-bottom: 1.25rem; }
</style>`);

/**
 * Hide the "working on it" block once the answer is under it.
 *
 * The page is streamed, so nothing can be taken back off it — but a later
 * `<style>` still applies to what came earlier, and that is enough. No script,
 * which is the standing rule on the editing path, and a browser that ignores it
 * simply shows one extra line of Finnish above the proposal.
 */
const HIDE_WORKING = raw(`<style>.prompt-working { display: none; }</style>`);

/** `GET /recipes/:id/prompt` */
export async function promptEditScreen(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipe = await load(env.DB, member, params["id"]);
  if (recipe === null) return notFound(member);

  return page(
    `Muokkaa promptilla: ${recipe.title}`,
    promptForm(recipe),
    "recipes",
    member,
  );
}

/**
 * `POST /recipes/:id/prompt` — ask the model, then show the proposal.
 *
 * The answer is streamed as a page rather than returned as one. A model call
 * with thinking on takes long enough that Cloudflare would close a silent
 * request before it finished, which is the same reason intake streams; sending
 * the shell first and the proposal when it arrives keeps the connection alive
 * with no script at all. Nothing is written here either way, so unlike an
 * import this does not need to survive the member navigating away.
 */
export function promptEditForm(
  { env, request, params }: RouteContext,
  member: Member,
): Response {
  return streamingPage(
    "Muokkaa promptilla",
    "recipes",
    member,
    async (emit) => {
      const recipe = await load(env.DB, member, params["id"]);
      if (recipe === null) return notFoundBody();

      let instruction: string;
      try {
        instruction = readInstruction((await request.formData()).get("instruction"));
      } catch (error) {
        if (!(error instanceof PromptRefused)) throw error;
        return html`<p class="refused">${error.message}</p>
          ${promptForm(recipe)}`;
      }

      emit(html`<div class="prompt-working">
        <h1>Muokkaa promptilla</h1>
        <p>${recipe.title}</p>
        <p class="empty">Luodaan ehdotusta… Pidä sivu auki.</p>
      </div>`);

      const ingredients = await ingredientsFor(env.DB, member.householdId);

      let text: string;
      try {
        text = await collectValidatedDraft(
          streamRecipeEdit(env, recipe, instruction, ingredients),
          // A byte per delta. Nothing shows it — it is a comment — but it is
          // what stops the proxy closing a request that is only thinking.
          () => emit(raw("<!-- . -->")),
        );
      } catch (error) {
        return html`${HIDE_WORKING}
          <p class="refused">${importFailureMessage(error)}</p>
          ${promptForm(recipe, instruction)}`;
      }

      try {
        return html`${HIDE_WORKING}
          ${reviewBody(recipe, ingredients, instruction, text)}`;
      } catch (error) {
        // The stream said the draft parsed, so this is rare — but a refusal
        // here still has to read as Finnish rather than as a broken page.
        return html`${HIDE_WORKING}
          <p class="refused">${importFailureMessage(error)}</p>
          ${promptForm(recipe, instruction)}`;
      }
    },
  );
}

/**
 * `POST /recipes/:id/prompt/review` — the same review, from a proposal handed
 * in rather than one just generated.
 *
 * This is the seam `/intake/correct` already is for an import: the model call
 * on one side, the review and the save on the other. It is what lets the whole
 * reviewing, correcting and saving half be exercised for nothing — the browser
 * suite posts a hand-built proposal here — and it costs no safety to have,
 * because the proposal is checked by `assertDraftWire` exactly as a model's
 * would be, the recipe is loaded own-household only, and nothing is written.
 */
export async function promptReviewScreen(
  { env, request, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipe = await load(env.DB, member, params["id"]);
  if (recipe === null) return notFound(member);

  const form = await request.formData();
  const instruction = String(form.get("instruction") ?? "").trim();
  const ingredients = await ingredientsFor(env.DB, member.householdId);

  let body: Raw;
  try {
    body = reviewBody(
      recipe,
      ingredients,
      instruction,
      String(form.get("draft") ?? ""),
    );
  } catch (error) {
    return page(
      "Muokkaa promptilla",
      html`<p class="refused">${importFailureMessage(error)}</p>
        ${promptForm(recipe, instruction)}`,
      "recipes",
      member,
      400,
    );
  }

  return page("Ehdotus tarkistettavaksi", body, "recipes", member);
}

/**
 * The proposal, checked and rendered as the recipe editor.
 *
 * Throws whatever `draftFromJson` throws, so a proposal that is not a valid
 * draft never reaches a form at all — which is the whole point of the model's
 * answer being untrusted: it is checked before it can be corrected, and
 * corrected before it can be saved.
 */
function reviewBody(
  recipe: Recipe,
  ingredients: Awaited<ReturnType<typeof ingredientsFor>>,
  instruction: string,
  text: string,
): Raw {
  const draft = proposalForRecipe(
    draftFromJson(text, sourceFor(recipe), STRUCTURED_BY),
    recipe,
  );

  if (draft.lines.length > MAX_LINES || draft.steps.length > MAX_STEPS) {
    return html`<p class="refused">
        Ehdotus oli liian iso: ainesrivejä saa olla enintään ${MAX_LINES} ja
        vaiheita ${MAX_STEPS}. Kokeile pienempää muutospyyntöä.
      </p>
      ${promptForm(recipe, instruction)}`;
  }

  return html`${proposal(recipe, instruction, proposalChanges(draft, recipe))}
    ${editorForm(recipe, ingredients, {
      form: proposalForm(draft, recipe),
      lineCount: draft.lines.length,
      revision: recipe.revision,
      withoutPicture: true,
    })}
    ${PROMPT_STYLE}`;
}

// ---------------------------------------------------------------- rendering

/** The change request box. Kept whole after a refusal, so nothing is retyped. */
function promptForm(recipe: Recipe, instruction = ""): Raw {
  return html`<h1>Muokkaa promptilla</h1>
    <p>${recipe.title}</p>

    <p class="empty">
      Kirjoita lyhyesti, mitä reseptiin pitäisi muuttaa. Saat ehdotuksen
      tarkistettavaksi — mitään ei tallenneta ennen kuin hyväksyt sen.
    </p>
    <ul class="prompt-examples empty">
      <li>Lisää puuttuva lisuke.</li>
      <li>Lisää kastikkeeseen puuttuvat ainekset.</li>
      <li>Täydennä ohje niin, että kaikki ainekset tulevat käytetyiksi.</li>
      <li>Lisää salaatti tämän ruoan lisukkeeksi.</li>
    </ul>

    <form method="post" action="/recipes/${recipe.id}/prompt" class="stacked">
      <label for="instruction">Muutospyyntö</label>
      <textarea
        id="instruction"
        name="instruction"
        rows="4"
        maxlength="${MAX_INSTRUCTION}"
        placeholder="Esimerkiksi: Lisää salaatti tämän ruoan lisukkeeksi."
        required
      >${instruction}</textarea>
      <button type="submit" class="primary">Luo ehdotus</button>
    </form>

    <p><a href="/recipes/${recipe.id}/edit">Takaisin muokkaukseen</a></p>
    ${PROMPT_STYLE}`;
}

/**
 * The proposal's own heading: what was asked for, and what the answer changed.
 *
 * The list is computed from the two recipes rather than taken from the model,
 * because the question it answers — did anything I did not ask about move? — is
 * exactly the question a model's own summary is worst at.
 */
function proposal(
  recipe: Recipe,
  instruction: string,
  changes: ProposalChange[],
): Raw {
  return html`<section class="prompt-proposal">
    <h1>Ehdotus tarkistettavaksi</h1>
    <p class="empty">Pyysit: ${instruction}</p>

    ${changes.length === 0
      ? html`<p class="empty">
          Ehdotus ei muuta reseptin aineksia, vaiheita eikä nimeä. Tarkista se
          alta ja tallenna, jos se on oikein.
        </p>`
      : html`<p>Ehdotus muuttaa seuraavaa:</p>
          <ul class="prompt-changes">
            ${changes.map(
              (change) => html`<li>
                ${change.kind === "added"
                  ? "Lisätty"
                  : change.kind === "removed"
                    ? "Poistettu"
                    : "Muutettu"}
                — ${change.what}
              </li>`,
            )}
          </ul>`}

    <p class="empty">
      Mitään ei ole vielä tallennettu. Korjaa ehdotusta alla olevalla lomakkeella
      ja tallenna se tavalliseen tapaan, tai
      <a href="/recipes/${recipe.id}">peruuta ja palaa reseptiin</a>.
    </p>
  </section>`;
}

function notFound(member: Member): Response {
  return page("Ei löytynyt", notFoundBody(), "recipes", member, 404);
}

function notFoundBody(): Raw {
  return html`<h1>Ei löytynyt</h1>
    <p class="empty">Tätä reseptiä ei ole.</p>`;
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
