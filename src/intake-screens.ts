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
import type { Member } from "./members.ts";
import {
  emptyLine,
  lineRow,
  readLines,
  readIngredient,
  readNumber,
  readSteps,
  readText,
  readWhole,
  SPARE_LINES,
} from "./line-form.ts";
import { saveRecipe, SaveRefused, type LineIngredient } from "./recipe-save.ts";
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
    status.textContent = file ? 'Luetaan kuvaa…' : 'Jäsennetään…';
    progress.hidden = false;
    progress.textContent = '';

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
          status.textContent = 'Jäsennetään…';
          var reader = response.body.getReader();
          var decoder = new TextDecoder();
          var draft = '';
          return (function pump() {
            return reader.read().then(function (chunk) {
              if (chunk.done) return draft;
              draft += decoder.decode(chunk.value, { stream: true });
              progress.textContent = draft;
              progress.scrollTop = progress.scrollHeight;
              return pump();
            });
          })();
        });
      })
      .then(function (draft) {
        status.textContent = 'Valmis, avataan tarkistus…';
        handOver(draft, file ? 'photographed' : 'pasted', text);
      })
      .catch(function (error) {
        status.textContent = 'Jäsennys epäonnistui: ' + error.message;
        form.querySelector('button').disabled = false;
      });
  });
})();
`;

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

      <p id="status" class="empty" aria-live="polite"></p>
      <pre id="progress" class="progress" hidden></pre>

      <script>
        ${raw(STREAMING_ISLAND)}
      </script>`,
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

  return page("Tarkista resepti", correctionForm(draft, ingredients));
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
  const route = form.get("route") === "photographed" ? "photographed" : "pasted";
  const pasted = String(form.get("sourceText") ?? "");

  const source: IntakeSource =
    route === "photographed"
      ? { route, imageBase64: "", mediaType: "image/jpeg" }
      : { route, text: pasted };

  const ingredients = await ingredientsFor(env.DB, member.householdId);

  try {
    const draft = draftFromJson(json, source, STRUCTURED_BY);
    return page("Tarkista resepti", correctionForm(draft, ingredients));
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

  const sourceText = String(form.get("sourceText") ?? "");
  const structuredBy = String(form.get("structuredBy") ?? "") || null;
  const lineCount = Number(form.get("lineCount") ?? 0);

  const lines = readLines(form, lineCount);
  const steps = readSteps(form);

  try {
    const recipeId = await saveRecipe(env.DB, member, {
      title: String(form.get("title") ?? ""),
      yieldPortions: readWhole(form.get("yield")),
      sourceText,
      sourceRoute: "pasted",
      structuredBy,
      steps,
      lines,
    });

    // Straight to the recipe, which is why it was imported.
    return new Response(null, {
      status: 302,
      headers: { Location: `/recipes/${recipeId}` },
    });
  } catch (error) {
    if (!(error instanceof SaveRefused)) throw error;

    // Re-render what they had, with the reason, rather than losing the work.
    const draft = draftFromForm(form, lineCount, sourceText, structuredBy);
    return page(
      "Tarkista resepti",
      html`<p class="refused">${error.message}</p>
        ${correctionForm(draft, ingredients)}`,
      400,
    );
  }
}

// ---------------------------------------------------------------- rendering

function correctionForm(draft: Draft, ingredients: IngredientSummary[]): Raw {
  const rows = [
    ...draft.lines,
    ...Array.from({ length: SPARE_LINES }, emptyLine),
  ];

  return html`<h1>Tarkista resepti</h1>
    <form method="post" action="/recipes" class="stacked">
      <input type="hidden" name="sourceText" value="${draft.sourceText}" />
      <input type="hidden" name="structuredBy" value="${draft.structuredBy}" />
      <input type="hidden" name="lineCount" value="${rows.length}" />

      <label for="title">Nimi</label>
      <input id="title" name="title" value="${draft.title}" required />

      <label for="yield">Annoksia</label>
      <input
        id="yield"
        name="yield"
        inputmode="numeric"
        value="${draft.yieldPortions ?? ""}"
        placeholder="Tyhjä, jos teksti ei kerro"
      />

      <h2>Ainekset</h2>
      <ol class="edit-lines">
        ${rows.map((line, index) =>
          lineRow(line, index, ingredients, { sections: true }),
        )}
      </ol>

      <h2>Valmistus</h2>
      <ol class="edit-steps">
        ${draft.steps.map(
          (step, index) => html`<li class="edit-step">
            <textarea name="step.${index}" rows="2">${step.text}</textarea>
            <input
              name="step.${index}.section"
              value="${step.section ?? ""}"
              aria-label="Osa"
              placeholder="Osa"
              class="section"
            />
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
    400,
  );
}

/** Rebuild the draft from a refused submission so nothing typed is lost. */
function draftFromForm(
  form: FormData,
  lineCount: number,
  sourceText: string,
  structuredBy: string | null,
): Draft {
  const lines: DraftLine[] = [];

  for (let i = 0; i < lineCount; i++) {
    if (form.get(`line.${i}.remove`) !== null) continue;

    const ingredient = readIngredient(form, i);
    lines.push({
      quantity: readNumber(form.get(`line.${i}.quantity`)),
      quantityMax: readNumber(form.get(`line.${i}.quantityMax`)),
      unit: readText(form.get(`line.${i}.unit`)),
      altQuantity: readNumber(form.get(`line.${i}.altQuantity`)),
      altUnit: readText(form.get(`line.${i}.altUnit`)),
      ingredientId: ingredient.kind === "existing" ? ingredient.id : null,
      ingredientName: String(form.get(`line.${i}.newName`) ?? ""),
      sourceLine: String(form.get(`line.${i}.source`) ?? ""),
      section: readText(form.get(`line.${i}.section`)),
    });
  }

  return {
    title: String(form.get("title") ?? ""),
    yieldPortions: readWhole(form.get("yield")),
    sourceText,
    steps: readSteps(form),
    lines,
    structuredBy: structuredBy ?? "",
  };
}
