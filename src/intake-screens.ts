import { problem } from "./auth.ts";
import { html, page, raw, type Raw } from "./html.ts";
import { encodeDraftRefs } from "./ingredient-refs.ts";
import { ingredientsFor, type IngredientSummary } from "./ingredients.ts";
import {
  createIntakeJob,
  deleteIntakeJob,
  findIntakeJob,
  IntakeRefused,
  listIntakeJobs,
  retryIntakeJob,
  type IntakeJob,
} from "./intake-jobs.ts";
import {
  draftFromJson,
  importFailureMessage,
  MAX_IMAGES,
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
import { formatMeasurement } from "./quantities.ts";
import { saveRecipe, SaveRefused } from "./recipe-save.ts";
import { isLocalOrigin } from "./public-origin.ts";
import type { RouteContext } from "./router.ts";
import { SAMPLE_DRAFT } from "./sample-draft.ts";

/**
 * Intake: getting a recipe into the store by pasting text. The correction
 * screen is where a structured draft becomes a recipe, and it is deliberately
 * in the way — nothing saves while a line is unanswered.
 *
 * Structuring is a queued job whose source and validated result stay in D1.
 * The correction screen remains deliberately in the way of the final save.
 */

/**
 * The one island of client-side work in the app. It prepares photographed
 * pages, starts a durable import, then gets out of the model call's lifecycle.
 *
 * Intake requires this script. Pasted text starts its queued model path, and
 * the camera route also needs it for canvas downscaling.
 *
 * It also owns the chosen pages (#156). Neither file input holds the list,
 * because neither one can: a camera capture replaces its input's single file
 * every time, and a member shooting page two would otherwise lose page one.
 * The list lives here, both inputs only ever append to it, and it is what gets
 * sent — in order.
 */
const STREAMING_ISLAND = `
(function () {
  var form = document.getElementById('intake');
  var progress = document.getElementById('progress');
  var status = document.getElementById('status');
  var photoHelp = document.getElementById('photo-help');
  var chosenList = document.getElementById('chosen');
  if (!form || !progress || !status || !photoHelp || !chosenList || !window.fetch || !window.Promise) return;

  var button = form.querySelector('button[type="submit"]');
  if (!button) return;
  button.disabled = false;
  status.textContent = '';
  if (!window.createImageBitmap || !window.URL || !window.URL.createObjectURL || !window.URL.revokeObjectURL) {
    form.camera.disabled = true;
    form.photo.disabled = true;
    photoHelp.textContent = 'Kuvan tuonti ei ole käytettävissä tässä selaimessa.';
  }
  var LONG_EDGE = 1500;
  var MAX_PAGES = ${MAX_IMAGES};

  // The pages to import, in the order they were added. Camera shots and
  // library picks land in the same list; nothing distinguishes them after this.
  var pages = [];

  function shrink(file) {
    return window.createImageBitmap(file).then(function (bitmap) {
      var scale = Math.min(1, LONG_EDGE / Math.max(bitmap.width, bitmap.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      var url = canvas.toDataURL('image/jpeg', 0.85);
      return url.slice(url.indexOf(',') + 1);
    });
  }

  // One page at a time, on purpose: the order has to survive, and a phone
  // decoding eight full-size photographs at once is how a tab gets killed.
  function shrinkAll() {
    var images = [];
    return pages
      .reduce(function (chain, page, index) {
        return chain.then(function () {
          status.textContent = pages.length > 1
            ? 'Luetaan kuvaa ' + (index + 1) + '/' + pages.length + '…'
            : 'Luetaan kuvaa…';
          return shrink(page.file).then(function (b64) {
            images.push({ image: b64, mediaType: 'image/jpeg' });
          });
        });
      }, Promise.resolve())
      .then(function () { return images; });
  }

  // Rebuilt whole every time, so the numbering and the remove buttons always
  // agree with the list rather than with the order things were added.
  function renderPages() {
    while (chosenList.firstChild) chosenList.removeChild(chosenList.firstChild);
    chosenList.hidden = pages.length === 0;

    pages.forEach(function (page, index) {
      var item = document.createElement('li');

      var thumb = document.createElement('img');
      thumb.src = page.url;
      thumb.alt = '';
      item.appendChild(thumb);

      var name = document.createElement('span');
      name.className = 'page-name';
      name.textContent = 'Sivu ' + (index + 1);
      item.appendChild(name);

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'quiet';
      remove.textContent = 'Poista';
      remove.addEventListener('click', function () {
        URL.revokeObjectURL(page.url);
        pages.splice(index, 1);
        renderPages();
      });
      item.appendChild(remove);

      chosenList.appendChild(item);
    });
  }

  function addFrom(input) {
    var dropped = 0;
    for (var i = 0; i < input.files.length; i++) {
      if (pages.length >= MAX_PAGES) { dropped++; continue; }
      var file = input.files[i];
      pages.push({ file: file, url: URL.createObjectURL(file) });
    }

    // Clearing the input is what lets the same camera button be pressed again
    // for the next page: without it a second identical capture fires no change.
    input.value = '';
    renderPages();

    status.textContent = dropped
      ? 'Enintään ' + MAX_PAGES + ' sivua yhdessä reseptissä.'
      : '';
  }

  ['camera', 'photo'].forEach(function (id) {
    var input = document.getElementById(id);
    if (input) {
      input.addEventListener('change', function () { addFrom(input); });
    }
  });

  form.addEventListener('submit', function (event) {
    var text = form.sourceText.value.trim();
    var photographed = pages.length > 0;
    event.preventDefault();
    if (!photographed && !text) {
      status.textContent = 'Liitä ensin reseptin teksti tai valitse kuva.';
      return;
    }
    button.disabled = true;
    status.textContent = photographed ? 'Luetaan kuvaa…' : 'Luetaan reseptiä…';
    progress.hidden = false;
    progress.textContent = 'Luetaan reseptiä…';

    var prepared = photographed
      ? shrinkAll().then(function (images) { return { images: images }; })
      : Promise.resolve({ sourceText: text });

    prepared
      .then(function (body) {
        return fetch('/api/intake/imports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then(function (response) {
          if (!response.ok) {
            return response.text().then(function (t) { throw new Error(t || response.status); });
          }
          return response.json();
        });
      })
      .then(function (job) {
        status.textContent = 'Reseptiä käsitellään taustalla. Voit jatkaa Ruokalistan käyttöä.';
        progress.hidden = true;
        progress.textContent = '';
        button.disabled = false;
        if (job && job.id) {
          window.location.assign('/intake?started=' + encodeURIComponent(job.id));
        }
      })
      .catch(function (error) {
        // Only wording this island wrote is shown. Anything else — a transport
        // error, a server body — is generic, so no English or raw response
        // text ever lands on a member's screen.
        status.textContent = error && error.member
          ? 'Jäsennys epäonnistui: ' + error.message
          : 'Jäsennys epäonnistui. Yritä hetken kuluttua uudelleen.';
        // The counts belonged to an attempt that came to nothing. Leaving them
        // up would read as a half-finished import that is still going.
        progress.hidden = true;
        progress.textContent = '';
        button.disabled = false;
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
  intakeJobId: string;
  rows: Array<DraftLine | LineFormValues>;
  steps: StepFormValues[];
}

/**
 * The sample draft, offered only by a development server.
 *
 * It posts to the same `/intake/correct` the ready-job route ultimately uses, so
 * walking through it exercises the real review, the real editor and the real
 * save — nothing is special-cased downstream. What it skips is the one
 * expensive step.
 */
function sampleDraftForm(): Raw {
  return html`<hr />
    <form method="post" action="/intake/correct" class="stacked">
      <input type="hidden" name="draft" value="${JSON.stringify(SAMPLE_DRAFT)}" />
      <input type="hidden" name="route" value="pasted" />
      <input type="hidden" name="sourceText" value="${SAMPLE_DRAFT.source_text}" />
      <button type="submit" class="quiet">Avaa esimerkkiluonnos</button>
      <p class="empty">
        Kehityspalvelimen oikotie: vie tarkistusnäkymään kutsumatta mallia.
        Tätä ei ole julkaistussa sovelluksessa.
      </p>
    </form>`;
}

/** The JavaScript-owned intake form, optionally with a paste kept for retry. */
function intakeForm(sourceText = "", submitLabel = "Jäsennä"): Raw {
  return html`<form class="stacked" id="intake">
      <label for="sourceText">Liitä reseptin teksti</label>
      <textarea
        id="sourceText"
        name="sourceText"
        rows="14"
        placeholder="Liitä tähän resepti sellaisenaan."
      >${sourceText}</textarea>

      <label for="camera">…tai ota kuva painetusta sivusta</label>
      <input
        id="camera"
        name="camera"
        type="file"
        accept="image/*"
        capture="environment"
      />

      <label for="photo">…tai valitse kuvia kuvakirjastosta</label>
      <input id="photo" name="photo" type="file" accept="image/*" multiple />

      <ul id="chosen" class="chosen" hidden></ul>

      <p class="empty" id="photo-help">
        Voit lisätä saman reseptin sivuja useita, enintään ${MAX_IMAGES} —
        kaikista tulee yksi resepti siinä järjestyksessä kuin ne ovat tässä.
        Kuvat pienennetään selaimessa ja säilytetään yksityisesti jäsennyksen
        ajan. Onnistuneesta tuonnista talteen jää vain sivuilta luettu teksti.
      </p>

      <button type="submit" disabled>${submitLabel}</button>
    </form>

    <p id="status" class="status" aria-live="polite">
      Reseptin tuonti tarvitsee JavaScriptin.
    </p>
    <p id="progress" class="progress" aria-live="polite" hidden></p>

    <script>
      ${raw(STREAMING_ISLAND)}
    </script>`;
}

function intakeJobs(jobs: IntakeJob[]): Raw {
  if (jobs.length === 0) return html``;

  const state = (job: IntakeJob): Raw => {
    if (job.status === "ready") {
      return html`<p><strong>Valmis tarkistettavaksi</strong></p>
        <p><a class="button" href="/intake/imports/${job.id}/review">Tarkista resepti</a></p>`;
    }
    if (job.status === "failed") {
      return html`<p class="refused">${job.errorMessage ?? "Jäsennys epäonnistui."}</p>
        <form method="post" action="/intake/imports/${job.id}/retry">
          <button type="submit">Yritä uudelleen</button>
        </form>`;
    }
    return html`<p><strong>Käsitellään taustalla</strong></p>`;
  };

  return html`<section aria-labelledby="intake-jobs-title">
    <h2 id="intake-jobs-title">Keskeneräiset tuonnit</h2>
    <ul class="recipes">
      ${jobs.map((job) => html`<li
        data-intake-job="${job.id}"
        ${job.status === "queued" || job.status === "running"
          ? raw('data-intake-pending="true"')
          : ""}
      >
        <div class="recipes-text">
          <strong>${job.draftTitle ?? intakeSourceLabel(job)}</strong>
          <span class="meta">${job.sourceRoute === "photographed" ? "Kuvattu" : "Liitetty teksti"}</span>
          ${state(job)}
          ${job.status === "failed" && job.sourceText
            ? html`<details><summary>Alkuperäinen teksti</summary><pre>${job.sourceText}</pre></details>`
            : ""}
        </div>
      </li>`)}
    </ul>
    <script>${raw(`
      (function () {
        var pending = document.querySelectorAll('[data-intake-pending]');
        if (!pending.length || !window.fetch || !window.Promise) return;
        window.setTimeout(function check() {
          var requests = [];
          for (var i = 0; i < pending.length; i++) {
            requests.push(fetch('/api/intake/imports/' + pending[i].getAttribute('data-intake-job'))
              .then(function (response) { return response.ok ? response.json() : null; }));
          }
          Promise.all(requests).then(function (states) {
            for (var at = 0; at < states.length; at++) {
              if (states[at] && states[at].status !== 'queued' && states[at].status !== 'running') {
                window.location.reload();
                return;
              }
            }
            window.setTimeout(check, 3000);
          });
        }, 3000);
      })();
    `)}</script>
  </section>`;
}

function intakeSourceLabel(job: IntakeJob): string {
  if (job.sourceRoute === "photographed") {
    return job.imageRefs.length === 1
      ? "Kuvattu resepti"
      : `Kuvattu resepti (${job.imageRefs.length} sivua)`;
  }
  const firstLine = (job.sourceText ?? "").split("\n")[0]?.trim();
  return firstLine || "Liitetty resepti";
}

/** `GET /intake` */
export async function intakeScreen(
  { env, url }: RouteContext,
  member: Member,
): Promise<Response> {
  const jobs = await listIntakeJobs(env.DB, member.householdId);
  const started = url.searchParams.get("started");
  const startedJob = jobs.find((job) => job.id === started);
  if (startedJob?.status === "ready") {
    return new Response(null, {
      status: 302,
      headers: { Location: `/intake/imports/${startedJob.id}/review` },
    });
  }
  const confirmed = startedJob !== undefined;
  return page(
    "Lisää resepti",
    html`<h1>Lisää resepti</h1>
      ${confirmed
        ? html`<p class="status">Reseptiä käsitellään taustalla. Voit jatkaa Ruokalistan käyttöä.</p>`
        : ""}
      ${intakeForm()}
      ${intakeJobs(jobs)}
      ${isLocalOrigin(url) ? sampleDraftForm() : ""}
      `,
    "intake",
    member,
  );
}

/** `POST /api/intake/imports` — persist the source and return immediately. */
export async function startIntakeJob(
  { env, request }: RouteContext,
  member: Member,
): Promise<Response> {
  let body: {
    sourceText?: unknown;
    image?: unknown;
    mediaType?: unknown;
    images?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return problem(400, "Expected a JSON body.");
  }

  try {
    const job = await createIntakeJob(env, member, body);
    return Response.json({ id: job.id, status: job.status }, { status: 202 });
  } catch (error) {
    return error instanceof IntakeRefused
      ? problem(400, error.message)
      : problem(503, "Reseptin jäsennystä ei voitu käynnistää.");
  }
}

/** `GET /api/intake/imports/:id` — household-scoped polling state. */
export async function intakeJobStatus(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const job = await findIntakeJob(env.DB, params["id"] ?? "", member.householdId);
  if (job === null) return problem(404, "Not found.");
  return Response.json({
    id: job.id,
    status: job.status,
    reviewUrl: job.status === "ready" ? `/intake/imports/${job.id}/review` : null,
    error: job.status === "failed" ? job.errorMessage : null,
  });
}

/** `POST /intake/imports/:id/retry` — enqueue the retained source again. */
export async function retryIntakeJobForm(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const retried = await retryIntakeJob(
    env,
    params["id"] ?? "",
    member.householdId,
  );
  if (!retried) return intakeNotFound(member);
  return new Response(null, { status: 303, headers: { Location: "/intake" } });
}

/** `GET /intake/imports/:id/review` — reopen the normal review from D1. */
export async function intakeJobReviewScreen(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const job = await findIntakeJob(env.DB, params["id"] ?? "", member.householdId);
  if (job === null || job.status !== "ready" || job.draftJson === null) {
    return intakeNotFound(member);
  }

  const source: IntakeSource = job.sourceRoute === "photographed"
    ? { route: "photographed", images: [] }
    : { route: "pasted", text: job.sourceText ?? "" };
  const ingredients = await ingredientsFor(env.DB, member.householdId);

  try {
    const draft = draftFromJson(job.draftJson, source, STRUCTURED_BY);
    return page(
      "Tarkista resepti",
      correctionForm(draft, ingredients, job.sourceRoute, job.id),
      "intake",
      member,
    );
  } catch (error) {
    console.log(JSON.stringify({
      event: "intake.persisted_draft_invalid",
      job_id: job.id,
      detail: String((error as Error)?.message ?? error),
    }));
    return intakeNotFound(member);
  }
}

/** `POST /intake/correct` — render the local sample draft's correction screen. */
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
      ? { route, images: [] }
      : { route, text: pasted };

  const ingredients = await ingredientsFor(env.DB, member.householdId);

  try {
    const draft = draftFromJson(json, source, STRUCTURED_BY);
    return page(
      "Tarkista resepti",
      correctionForm(draft, ingredients, route),
      "intake",
      member,
    );
  } catch (error) {
    return failed(member, importFailureMessage(error), pasted);
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

    const intakeJobId = String(form.get("intakeJobId") ?? "");
    if (intakeJobId !== "") {
      try {
        await deleteIntakeJob(env, intakeJobId, member.householdId);
      } catch (error) {
        console.log(JSON.stringify({
          event: "intake.cleanup_failed",
          job_id: intakeJobId,
          detail: String((error as Error)?.message ?? error),
        }));
      }
    }

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
      member,
      400,
    );
  }
}

// ---------------------------------------------------------------- rendering

function correctionForm(
  draft: Draft,
  ingredients: IngredientSummary[],
  sourceRoute: SourceRoute,
  intakeJobId = "",
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
    phase: step.phase ?? "",
    // The draft already points at its own lines by index, and the form's rows
    // are those lines in the same order, so this rides through untouched.
    refs: encodeDraftRefs(step.refs),
  }));

  return renderCorrection(
    {
      title: draft.title,
      yieldValue: String(draft.yieldPortions ?? ""),
      sourceText: draft.sourceText,
      sourceRoute,
      structuredBy: draft.structuredBy,
      intakeJobId,
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
      intakeJobId: String(form.get("intakeJobId") ?? ""),
      rows: Array.from({ length: lineCount }, (_, index) =>
        lineValuesFromForm(form, index),
      ),
      steps: stepValuesForRendering(form),
    },
    ingredients,
  );
}

/**
 * The draft, read as the recipe it is about to become — parts and all.
 *
 * Testing the deployed v1 found that 99% of imports need no change at all, so
 * the screen that used to ask for corrections now mostly needs to be *read*
 * (#53). The form is still here, one disclosure down, and it is the same form:
 * a closed `<details>` still submits, so nothing about saving changed.
 */
function draftReview(
  view: CorrectionView,
  ingredients: IngredientSummary[],
): Raw {
  const rows = view.rows.map((row, index) =>
    isLineFormValues(row) ? row : lineValuesFromDraft(row, index),
  );

  const kept = rows.filter((row) => !row.remove && !isBlank(row));
  const parentBefore = kept.filter(
    (row) => row.section.trim() === "" && row.phase !== "after_parts",
  );
  const parentAfter = kept.filter(
    (row) => row.section.trim() === "" && row.phase === "after_parts",
  );
  const sections = [
    ...new Set(kept.map((row) => row.section.trim()).filter((name) => name !== "")),
  ];

  const reviewSection = (section: string, lines: LineFormValues[], phase?: string) => {
    const steps = view.steps.filter(
      (step) =>
        step.section.trim() === section &&
        step.text.trim() !== "" &&
        (phase === undefined
          ? true
          : phase === "after_parts"
            ? step.phase === "after_parts"
            : step.phase !== "after_parts"),
    );

    if (lines.length === 0 && steps.length === 0) return html``;
    return html`<section class="${section === "" ? "" : "part"}">
      ${section === "" ? "" : html`<h2>${section}</h2>`}
      ${lines.length === 0
        ? ""
        : html`<h3>Ainekset</h3><ul class="lines">${lines.map(reviewLine(ingredients))}</ul>`}
      ${steps.length === 0
        ? ""
        : html`<h3>Valmistus</h3><ol>${steps.map((step) => html`<li>${step.text}</li>`)}</ol>`}
    </section>`;
  };

  return html`<p class="review-title">${view.title}</p>
    <p class="meta">
      ${view.yieldValue.trim() === ""
        ? "Annosmäärää ei kerrottu"
        : `${view.yieldValue.trim()} annosta`}
    </p>

    ${newIngredientsNotice(kept)} ${notesNotice(kept)}

    ${reviewSection("", parentBefore, "before_parts")}
    ${sections.map((section) =>
      reviewSection(
        section,
        kept.filter((row) => row.section.trim() === section),
      ),
    )}
    ${reviewSection("", parentAfter, "after_parts")}`;
}

/**
 * The amount as the saved recipe will print it — "½ dl", "1–1½ l",
 * "½ kpl (500 g)" — rather than as the form holds it. A review that showed
 * `0,5` and dropped the range would not be a review of what gets saved.
 *
 * A value too broken to parse is shown as typed: that is the thing to look at.
 */
function reviewAmount(row: LineFormValues): string {
  const number = (text: string): number | null => {
    const parsed = Number(text.trim().replace(",", "."));
    return text.trim() === "" || !Number.isFinite(parsed) ? null : parsed;
  };

  const quantity = number(row.quantity);
  if (quantity === null) {
    return [row.quantity.trim(), row.unit.trim()]
      .filter((part) => part !== "")
      .join(" ");
  }

  const altQuantity = number(row.altQuantity);
  const altUnit = row.altUnit.trim();

  return formatMeasurement({
    quantity,
    quantityMax: number(row.quantityMax),
    unit: row.unit.trim() === "" ? null : row.unit.trim(),
    altQuantity: altUnit === "" ? null : altQuantity,
    altUnit: altQuantity === null ? null : altUnit || null,
  });
}

function reviewLine(ingredients: IngredientSummary[]) {
  return (row: LineFormValues): Raw => {
    const amount = reviewAmount(row);

    return html`<li>
      ${amount === "" ? "" : html`<span class="amount">${amount}</span> `}
      ${ingredientLabel(row, ingredients)}
      ${row.ingredientChoice === "new"
        ? html`<span class="badge is-decision">uusi</span>`
        : ""}
      ${row.note === ""
        ? ""
        : html`<span class="line-note">${row.note}</span>`}
      <span class="source">${row.sourceLine}</span>
    </li>`;
  };
}

function ingredientLabel(
  row: LineFormValues,
  ingredients: IngredientSummary[],
): string {
  const matched = ingredients.find(
    (ingredient) => String(ingredient.id) === row.ingredientChoice,
  );
  if (matched !== undefined) return matched.name;

  const proposed = row.newName.trim();
  return proposed === "" ? "— aines valitsematta —" : proposed;
}

/**
 * What saving will add to the household's shared vocabulary. Stated, not asked:
 * unmatched ingredients are almost always genuinely new, so the answer is
 * preselected and this is here to make a wrong one visible (#53).
 */
function newIngredientsNotice(rows: LineFormValues[]): Raw {
  const names = rows
    .filter((row) => row.ingredientChoice === "new")
    .map((row) => row.newName.trim())
    .filter((name) => name !== "");

  if (names.length === 0) return html``;

  return html`<p class="creating">
    Uutena luodaan: ${names.join(", ")}.
  </p>`;
}

/** The model's own doubts, gathered where they cannot be scrolled past. */
function notesNotice(rows: LineFormValues[]): Raw {
  const noted = rows.filter((row) => row.note !== "");
  if (noted.length === 0) return html``;

  return html`<div class="needs-answer is-doubt">
    <div>
      <strong
        >${noted.length === 1
          ? "Yksi rivi kannattaa vilkaista:"
          : `${noted.length} riviä kannattaa vilkaista:`}</strong
      >
      <ul class="plain">
        ${noted.map(
          (row) => html`<li>${row.sourceLine} — ${row.note}</li>`,
        )}
      </ul>
    </div>
  </div>`;
}

/** A spare row nobody filled in is not part of the recipe being reviewed. */
function isBlank(row: LineFormValues): boolean {
  return (
    row.ingredientChoice === "" &&
    row.newName.trim() === "" &&
    row.quantity.trim() === "" &&
    row.unit.trim() === "" &&
    row.sourceLine.trim() === ""
  );
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
  const multipart = view.rows.some((row) =>
    (isLineFormValues(row) ? row.section : row.section ?? "").trim() !== ""
  ) || view.steps.some((step) => step.section.trim() !== "");

  return html`<h1>Tarkista resepti</h1>
    <form method="post" action="/recipes" class="stacked">
      <input type="hidden" name="sourceText" value="${view.sourceText}" />
      <input type="hidden" name="sourceRoute" value="${view.sourceRoute}" />
      <input type="hidden" name="structuredBy" value="${view.structuredBy}" />
      <input type="hidden" name="intakeJobId" value="${view.intakeJobId}" />
      <input type="hidden" name="lineCount" value="${view.rows.length}" />

      ${draftReview(view, ingredients)}

      <button type="submit" class="button save-draft">Tallenna resepti</button>

      <!-- The same form, one tap down. A closed details still submits, so the
           99% that needs no change never opens it and loses nothing. -->
      <details class="edit-draft">
        <summary>Muokkaa ennen tallennusta</summary>

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
      ${lineRows(view.rows, ingredients, { sections: true, phases: multipart })}

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
            <input type="hidden" name="step.${step.index}.refs" value="${step.refs}" />
            <textarea name="step.${step.index}" rows="2">${step.text}</textarea>
            ${multipart && step.section.trim() === ""
              ? phaseSelect(`step.${step.index}.phase`, step.phase)
              : ""}
          </li>`,
        )}
      </ol>
      </details>
    </form>`;
}

function failed(member: Member, message: string, sourceText: string): Response {
  return page(
    "Jäsennys epäonnistui",
    html`<h1>Jäsennys epäonnistui</h1>
      <p class="refused">${message}</p>
      ${intakeForm(sourceText, "Yritä uudelleen")}`,
    "intake",
    member,
    400,
  );
}

function intakeNotFound(member: Member): Response {
  return page(
    "Ei löytynyt",
    html`<h1>Ei löytynyt</h1>
      <p class="empty">Tätä tuontia ei ole.</p>
      <p><a href="/intake">Takaisin tuonteihin</a></p>`,
    "intake",
    member,
    404,
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
