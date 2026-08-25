import { problem } from "./auth.ts";
import { html, page, raw, type Raw } from "./html.ts";
import { ingredientsFor, type IngredientSummary } from "./ingredients.ts";
import {
  draftFromJson,
  streamDraft,
  structureDraftWithRetry,
  STRUCTURED_BY,
  type Draft,
  type DraftLine,
  type IntakeSource,
} from "./intake.ts";
import {
  emptyLine,
  FormRefused,
  lineCountForRendering,
  lineRows,
  lineValuesFromDraft,
  lineValuesFromForm,
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
import { saveRecipe, SaveRefused } from "./recipe-save.ts";
import type { RouteContext } from "./router.ts";

/**
 * Intake: getting a recipe into the store by pasting text. The correction
 * screen is where a structured draft becomes a recipe, and it is deliberately
 * in the way — nothing saves while a line is unanswered.
 *
 * Nothing is written to D1 until the save, so a failed import leaves no trace
 * and a closed tab loses only the draft. That is why there is no draft table.
 */

/**
 * The one island of client-side work in the app. It streams the draft so bytes
 * keep flowing, shows it filling in, and then hands the finished draft to the
 * server to render the correction screen.
 *
 * Without JavaScript the form posts to /intake and works exactly as before,
 * just without the progress. The camera route needs this script either way:
 * downscaling a photograph is a canvas job.
 */
const STREAMING_ISLAND = `
(function () {
  var form = document.getElementById('intake');
  if (!form || !window.fetch || !window.ReadableStream || !window.createImageBitmap) return;

  var progress = document.getElementById('progress');
  var status = document.getElementById('status');
  var LONG_EDGE = 1500;

  // What the household is told while the model works. The draft arrives as
  // JSON, and showing raw JSON to somebody importing a recipe is showing them
  // the plumbing — so it is counted instead. The counts only ever rise, which
  // is the reassurance a spinner cannot give: something is still arriving.
  // No regular expressions in here: this whole script is a template literal, so
  // a backslash would be eaten before the browser ever saw it.
  function stringAfter(text, key) {
    var at = text.indexOf(key);
    if (at < 0) return '';
    var start = text.indexOf('"', at + key.length);
    if (start < 0) return '';
    var end = text.indexOf('"', start + 1);
    // A title containing a quote would come out short. It is a progress label.
    return end < 0 ? '' : text.slice(start + 1, end);
  }

  function count(text, key) {
    return text.split(key).length - 1;
  }

  function summarise(draft) {
    var title = stringAfter(draft, '"title"');
    var lines = count(draft, '"ingredient_name"');
    var steps = count(draft, '"text"');

    var parts = [];
    if (title) parts.push(title);
    if (lines) parts.push(lines === 1 ? '1 aines' : lines + ' ainesta');
    if (steps) parts.push(steps === 1 ? '1 vaihe' : steps + ' vaihetta');

    return parts.length ? parts.join(' · ') : 'Luetaan reseptiä…';
  }

  function shrink(file) {
    return createImageBitmap(file).then(function (bitmap) {
      var scale = Math.min(1, LONG_EDGE / Math.max(bitmap.width, bitmap.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      var url = canvas.toDataURL('image/jpeg', 0.85);
      return url.slice(url.indexOf(',') + 1);
    });
  }

  function handOver(draft, route, sourceText) {
    var hidden = document.createElement('form');
    hidden.method = 'post';
    hidden.action = '/intake/correct';
    [['draft', draft], ['route', route], ['sourceText', sourceText]].forEach(function (pair) {
      var field = document.createElement('input');
      field.type = 'hidden';
      field.name = pair[0];
      field.value = pair[1];
      hidden.appendChild(field);
    });
    document.body.appendChild(hidden);
    hidden.submit();
  }

  form.addEventListener('submit', function (event) {
    var file = form.photo.files[0];
    var text = form.sourceText.value.trim();
    if (!file && !text) return;

    event.preventDefault();
    form.querySelector('button').disabled = true;
    status.textContent = file ? 'Luetaan kuvaa…' : 'Luetaan reseptiä…';
    progress.hidden = false;
    progress.textContent = 'Luetaan reseptiä…';

    var prepared = file
      ? shrink(file).then(function (b64) { return { image: b64, mediaType: 'image/jpeg' }; })
      : Promise.resolve({ sourceText: text });

    prepared
      .then(function (body) {
        return fetch('/api/intake/structure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then(function (response) {
          if (!response.ok) {
            return response.text().then(function (t) { throw new Error(t || response.status); });
          }
          status.textContent = 'Malli lukee reseptiä…';
          var reader = response.body.getReader();
          var decoder = new TextDecoder();
          var draft = '';
          return (function pump() {
            return reader.read().then(function (chunk) {
              if (chunk.done) return draft;
              draft += decoder.decode(chunk.value, { stream: true });
              progress.textContent = summarise(draft);
              return pump();
            });
          })();
        });
      })
      .then(function (draft) {
        status.textContent = 'Valmis — avataan tarkistus.';
        handOver(draft, file ? 'photographed' : 'pasted', text);
      })
      .catch(function (error) {
        status.textContent = 'Jäsennys epäonnistui: ' + error.message;
        form.querySelector('button').disabled = false;
      });
  });
})();
`;

type SourceRoute = "pasted" | "photographed";

interface CorrectionView {
  title: string;
  yieldValue: string;
  sourceText: string;
  sourceRoute: SourceRoute;
  structuredBy: string;
  rows: Array<DraftLine | LineFormValues>;
  steps: StepFormValues[];
}

/** `GET /intake` */
export function intakeScreen(): Response {
  return page(
    "Lisää resepti",
    html`<h1>Lisää resepti</h1>
      <form method="post" action="/intake" class="stacked" id="intake">
        <label for="sourceText">Liitä reseptin teksti</label>
        <textarea
          id="sourceText"
          name="sourceText"
          rows="14"
          placeholder="Liitä tähän resepti sellaisenaan."
        ></textarea>

        <label for="photo">…tai kuvaa painettu sivu</label>
        <input id="photo" name="photo" type="file" accept="image/*" capture="environment" />
        <p class="empty">
          Kuva pienennetään selaimessa ja luetaan kerran. Sitä ei tallenneta
          minnekään — talteen jää vain sivulta luettu teksti.
        </p>

        <button type="submit">Jäsennä</button>
      </form>

      <p id="status" class="status" aria-live="polite"></p>
      <p id="progress" class="progress" aria-live="polite" hidden></p>

      <script>
        ${raw(STREAMING_ISLAND)}
      </script>`,
    "intake",
  );
}

/** `POST /intake` — run the model and show the draft for correcting. */
export async function structureScreen(
  { env, request }: RouteContext,
  member: Member,
): Promise<Response> {
  const form = await request.formData();
  const sourceText = String(form.get("sourceText") ?? "").trim();

  if (sourceText === "") {
    return failed("Liitä ensin reseptin teksti.", "");
  }

  const ingredients = await ingredientsFor(env.DB, member.householdId);

  let draft: Draft;
  try {
    draft = await structureDraftWithRetry(
      env,
      { route: "pasted", text: sourceText },
      ingredients,
    );
  } catch (error) {
    // The member's text is handed back rather than thrown away.
    return failed(String((error as Error).message ?? error), sourceText);
  }

  return page(
    "Tarkista resepti",
    correctionForm(draft, ingredients, "pasted"),
    "intake",
  );
}

/**
 * `POST /api/intake/structure` — run the model and stream the draft straight
 * through. The browser accumulates it and hands it back to /intake/correct,
 * which keeps the correction screen server-rendered.
 */
export async function structureStream(
  { env, request }: RouteContext,
  member: Member,
): Promise<Response> {
  let body: { sourceText?: unknown; image?: unknown; mediaType?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return problem(400, "Expected a JSON body.");
  }

  let source: IntakeSource;
  if (typeof body.image === "string" && body.image !== "") {
    source = {
      route: "photographed",
      imageBase64: body.image,
      mediaType: typeof body.mediaType === "string" ? body.mediaType : "image/jpeg",
    };
  } else if (typeof body.sourceText === "string" && body.sourceText.trim() !== "") {
    source = { route: "pasted", text: body.sourceText };
  } else {
    return problem(400, "Anna joko tekstiä tai kuva.");
  }

  const ingredients = await ingredientsFor(env.DB, member.householdId);

  let stream: ReadableStream<Uint8Array>;
  try {
    stream = streamDraft(env, source, ingredients);
  } catch (error) {
    return problem(503, String((error as Error).message ?? error));
  }

  return new Response(stream, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Nothing between here and the browser should hold bytes back.
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}

/** `POST /intake/correct` — render the correction screen for a streamed draft. */
export async function correctScreen(
  { env, request }: RouteContext,
  member: Member,
): Promise<Response> {
  const form = await request.formData();
  const json = String(form.get("draft") ?? "");
  const route: SourceRoute =
    form.get("route") === "photographed" ? "photographed" : "pasted";
  const pasted = String(form.get("sourceText") ?? "");

  const source: IntakeSource =
    route === "photographed"
      ? { route, imageBase64: "", mediaType: "image/jpeg" }
      : { route, text: pasted };

  const ingredients = await ingredientsFor(env.DB, member.householdId);

  try {
    const draft = draftFromJson(json, source, STRUCTURED_BY);
    return page(
      "Tarkista resepti",
      correctionForm(draft, ingredients, route),
      "intake",
    );
  } catch (error) {
    return failed(String((error as Error).message ?? error), pasted);
  }
}

/** `POST /recipes` — save the corrected draft. */
export async function saveScreen(
  { env, request }: RouteContext,
  member: Member,
): Promise<Response> {
  const form = await request.formData();
  const ingredients = await ingredientsFor(env.DB, member.householdId);

  try {
    const lineCount = readLineCount(form.get("lineCount"));
    const sourceRoute = readSourceRoute(form.get("sourceRoute"));
    const recipeId = await saveRecipe(env.DB, member, {
      title: String(form.get("title") ?? ""),
      yieldPortions: readWhole(form.get("yield")),
      sourceText: String(form.get("sourceText") ?? ""),
      sourceRoute,
      structuredBy: String(form.get("structuredBy") ?? "") || null,
      steps: readSteps(form),
      lines: readLines(form, lineCount),
    });

    // Straight to the recipe, which is why it was imported.
    return new Response(null, {
      status: 302,
      headers: { Location: `/recipes/${recipeId}` },
    });
  } catch (error) {
    if (!(error instanceof SaveRefused) && !(error instanceof FormRefused)) {
      throw error;
    }

    // Re-render the raw submitted values, not parsed approximations. An invalid
    // number is precisely the value the member needs to see and correct.
    return page(
      "Tarkista resepti",
      html`<p class="refused">${error.message}</p>
        ${correctionFormFromSubmission(form, ingredients)}`,
      "intake",
      400,
    );
  }
}

// ---------------------------------------------------------------- rendering

function correctionForm(
  draft: Draft,
  ingredients: IngredientSummary[],
  sourceRoute: SourceRoute,
): Raw {
  const rows = [
    ...draft.lines,
    ...Array.from({ length: SPARE_LINES }, emptyLine),
  ];
  const steps = draft.steps.map((step, index) => ({
    index,
    position: String(index + 1),
    text: step.text,
    section: step.section ?? "",
  }));

  return renderCorrection(
    {
      title: draft.title,
      yieldValue: String(draft.yieldPortions ?? ""),
      sourceText: draft.sourceText,
      sourceRoute,
      structuredBy: draft.structuredBy,
      rows,
      steps,
    },
    ingredients,
  );
}

function correctionFormFromSubmission(
  form: FormData,
  ingredients: IngredientSummary[],
): Raw {
  const lineCount = lineCountForRendering(form);
  return renderCorrection(
    {
      title: String(form.get("title") ?? ""),
      yieldValue: String(form.get("yield") ?? ""),
      sourceText: String(form.get("sourceText") ?? ""),
      sourceRoute: sourceRouteForRendering(form),
      structuredBy: String(form.get("structuredBy") ?? ""),
      rows: Array.from({ length: lineCount }, (_, index) =>
        lineValuesFromForm(form, index),
      ),
      steps: stepValuesForRendering(form),
    },
    ingredients,
  );
}

/**
 * How many lines are actually asking the reader for something. The model
 * proposes an ingredient it could not match, and nothing gets saved until a
 * person answers — so the count goes at the top, where it is the first thing
 * read, rather than being discovered by scrolling for badges.
 */
function decisionsNotice(rows: Array<DraftLine | LineFormValues>): Raw {
  const waiting = rows.filter((row) => {
    const values = isLineFormValues(row) ? row : lineValuesFromDraft(row, 0);
    return values.ingredientChoice === "" && values.newName.trim() !== "";
  }).length;

  if (waiting === 0) return html``;

  // Its own class, not .refused: nothing has gone wrong yet. This is the
  // screen saying what it is waiting for.
  return html`<p class="needs-answer">
    ${waiting === 1
      ? "Yksi aines on tuntematon. Valitse sille vastine tai hyväksy se uutena."
      : `${waiting} ainesta on tuntemattomia. Valitse niille vastineet tai hyväksy ne uusina.`}
  </p>`;
}

function isLineFormValues(
  row: DraftLine | LineFormValues,
): row is LineFormValues {
  return "ingredientChoice" in row;
}

function renderCorrection(
  view: CorrectionView,
  ingredients: IngredientSummary[],
): Raw {
  return html`<h1>Tarkista resepti</h1>
    <form method="post" action="/recipes" class="stacked">
      <input type="hidden" name="sourceText" value="${view.sourceText}" />
      <input type="hidden" name="sourceRoute" value="${view.sourceRoute}" />
      <input type="hidden" name="structuredBy" value="${view.structuredBy}" />
      <input type="hidden" name="lineCount" value="${view.rows.length}" />

      <label for="title">Nimi</label>
      <input id="title" name="title" value="${view.title}" required />

      <label for="yield">Annoksia</label>
      <input
        id="yield"
        name="yield"
        inputmode="numeric"
        value="${view.yieldValue}"
        placeholder="Tyhjä, jos teksti ei kerro"
      />

      <h2>Ainekset</h2>
      ${decisionsNotice(view.rows)}
      ${lineRows(view.rows, ingredients, { sections: true })}

      <h2>Valmistus</h2>
      <ol class="edit-steps">
        ${view.steps.map(
          (step) => html`<li class="edit-step">
            <div class="amounts">
              <!-- The spec asks for steps to be reorderable here, not only in
                   the editor. A position box does it without JavaScript. -->
              <input
                name="step.${step.index}.position"
                inputmode="numeric"
                value="${step.position}"
                aria-label="Järjestys"
                class="position"
              />
              <input
                name="step.${step.index}.section"
                value="${step.section}"
                aria-label="Osa"
                placeholder="Osa"
                class="section"
              />
            </div>
            <textarea name="step.${step.index}" rows="2">${step.text}</textarea>
          </li>`,
        )}
      </ol>

      <button type="submit">Tallenna resepti</button>
    </form>`;
}

function failed(message: string, sourceText: string): Response {
  return page(
    "Jäsennys epäonnistui",
    html`<h1>Jäsennys epäonnistui</h1>
      <p class="refused">${message}</p>
      <form method="post" action="/intake" class="stacked">
        <textarea name="sourceText" rows="16">${sourceText}</textarea>
        <button type="submit">Yritä uudelleen</button>
      </form>`,
    "intake",
    400,
  );
}

function readSourceRoute(value: FormDataEntryValue | null): SourceRoute {
  if (value === "pasted" || value === "photographed") return value;
  throw new FormRefused("Reseptin lähteen tyyppi on virheellinen.");
}

function sourceRouteForRendering(form: FormData): SourceRoute {
  return form.get("sourceRoute") === "photographed"
    ? "photographed"
    : "pasted";
}
