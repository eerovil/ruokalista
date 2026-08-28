import { problem } from "./auth.ts";
import { html, page, raw, type Raw } from "./html.ts";
import { encodeDraftRefs } from "./ingredient-refs.ts";
import { ingredientsFor, type IngredientSummary } from "./ingredients.ts";
import {
  draftFromJson,
  importFailureMessage,
  MAX_IMAGES,
  streamDraft,
  STRUCTURED_BY,
  type Draft,
  type DraftLine,
  type IntakeImage,
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
import {
  fetchRecipePage,
  normaliseRecipeUrl,
  PageRefused,
  type FetchFailure,
} from "./recipe-fetch.ts";
import type { RouteContext } from "./router.ts";
import { SAMPLE_DRAFT } from "./sample-draft.ts";

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
 * Intake requires this script. Pasted text uses its streamed model path, and
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
  if (!form || !progress || !status || !photoHelp || !chosenList || !window.fetch || !window.Promise || !window.Response || !window.ReadableStream || !window.TextDecoder) return;

  try {
    var streamProbe = new window.Response(new window.ReadableStream()).body;
    if (!streamProbe || !streamProbe.getReader) return;
  } catch (error) {
    return;
  }

  var button = form.querySelector('button[type="submit"]');
  if (!button) return;
  var linkField = form.sourceUrl;
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

  var FAILED_TEXT = 'malli ei saanut reseptiä valmiiksi. Liittämäsi teksti on tallessa — kokeile uudelleen.';

  // Marked so the catch below knows this wording is ours and is safe to show.
  function refusal() {
    var error = new Error(FAILED_TEXT);
    error.member = true;
    return error;
  }

  // Why a web address gave up no recipe (#192). The server names the case in a
  // closed set of words and this is where each one becomes Finnish, so a page's
  // own error text — or somebody else's Finnish — never reaches a screen.
  var LINK_REASONS = {
    invalid_url: 'osoite ei näytä nettiosoitteelta. Tarkista linkki.',
    unreachable: 'sivua ei saatu auki. Tarkista linkki tai kokeile hetken kuluttua uudelleen.',
    not_a_page: 'osoitteesta ei löytynyt nettisivua.',
    too_large: 'sivu on liian suuri luettavaksi.',
    no_recipe: 'sivulta ei löytynyt reseptiä. Voit liittää tekstin itse alla olevaan kenttään.'
  };

  function linkRefusal(reason) {
    var known = typeof reason === 'string' && LINK_REASONS[reason];
    var error = new Error(known || LINK_REASONS.unreachable);
    error.member = true;
    error.heading = 'Linkin luku epäonnistui';
    return error;
  }

  // The page, read on the server and handed back as text. No model runs here —
  // what comes back goes into the ordinary source-text field before the model
  // starts, so the fetched text stays with the draft and the saved recipe.
  function readLink(address) {
    status.textContent = 'Haetaan sivua…';
    return fetch('/api/intake/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: address })
    }).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok || !data || typeof data.sourceText !== 'string' || !data.sourceText) {
          throw linkRefusal(data && data.reason);
        }
        return data;
      }, function () {
        throw linkRefusal('unreachable');
      });
    }, function () {
      throw linkRefusal('unreachable');
    });
  }

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

  function handOver(draft, route, sourceText, sourceUrl) {
    var hidden = document.createElement('form');
    hidden.method = 'post';
    hidden.action = '/intake/correct';
    [['draft', draft], ['route', route], ['sourceText', sourceText], ['sourceUrl', sourceUrl]].forEach(function (pair) {
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
    var text = form.sourceText.value.trim();
    var link = linkField ? linkField.value.trim() : '';
    var photographed = pages.length > 0;
    // A photograph wins over a link and a link over an already-pasted box, so
    // the recipe that gets imported is the newest thing the member reached for.
    var linked = !photographed && !!link;
    var address = '';
    event.preventDefault();
    if (!photographed && !linked && !text) {
      status.textContent = 'Anna reseptin osoite, liitä sen teksti tai valitse kuva.';
      return;
    }
    button.disabled = true;
    status.textContent = photographed
      ? 'Luetaan kuvaa…'
      : linked ? 'Haetaan sivua…' : 'Luetaan reseptiä…';
    progress.hidden = false;
    progress.textContent = 'Luetaan reseptiä…';

    var prepared;
    if (photographed) {
      prepared = shrinkAll().then(function (images) { return { images: images }; });
    } else if (linked) {
      prepared = readLink(link).then(function (page) {
        text = page.sourceText;
        address = typeof page.url === 'string' ? page.url : link;
        // Put it in the ordinary source field so even a partial reading is
        // preserved through review and save rather than disappearing here.
        form.sourceText.value = text;
        status.textContent = 'Sivulta luettiin resepti — malli jäsentää sen.';
        return { sourceText: text, url: address };
      });
    } else {
      prepared = Promise.resolve({ sourceText: text });
    }

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
          if (!response.body || !response.body.getReader) {
            throw new Error('Streaming response unavailable');
          }
          status.textContent = 'Malli lukee reseptiä…';
          var reader = response.body.getReader();
          var decoder = new TextDecoder();
          var LF = String.fromCharCode(10);
          var pending = '';
          var draft = '';
          var completed = null;
          var retried = false;

          // Each line is one JSON record. Draft bytes live in an escaped string,
          // so pasted text cannot impersonate restart or completion framing.
          function accept(line) {
            var record;
            try {
              record = JSON.parse(line);
            } catch (_error) {
              throw refusal();
            }

            if (completed !== null || !record || typeof record.type !== 'string') {
              throw refusal();
            }
            if (record.type === 'delta' && typeof record.text === 'string') {
              draft += record.text;
              progress.textContent = summarise(draft);
              return;
            }
            if (record.type === 'restart') {
              draft = '';
              if (!retried) {
                retried = true;
                status.textContent = 'Ensimmäinen yritys katkesi — yritetään uudelleen…';
              }
              return;
            }
            if (record.type === 'complete') {
              completed = draft;
              return;
            }
            throw refusal();
          }

          function acceptCompleteLines() {
            var end = pending.indexOf(LF);
            while (end >= 0) {
              var line = pending.slice(0, end);
              pending = pending.slice(end + 1);
              if (line) accept(line);
              end = pending.indexOf(LF);
            }
          }

          return (function pump() {
            return reader.read().then(function (chunk) {
              if (chunk.done) {
                pending += decoder.decode();
                acceptCompleteLines();
                // Every record ends in a newline. Leftovers mean the transport
                // ended mid-record, so no draft is safe to hand over.
                if (pending || completed === null) throw refusal();
                return completed;
              }
              pending += decoder.decode(chunk.value, { stream: true });
              acceptCompleteLines();
              return pump();
            });
          })();
        });
      })
      .then(function (draft) {
        status.textContent = 'Valmis — avataan tarkistus.';
        var route = photographed ? 'photographed' : linked ? 'linked' : 'pasted';
        handOver(draft, route, text, address);
      })
      .catch(function (error) {
        // Only wording this island wrote is shown. Anything else — a transport
        // error, a server body — is generic, so no English or raw response
        // text ever lands on a member's screen.
        status.textContent = error && error.member
          ? (error.heading || 'Jäsennys epäonnistui') + ': ' + error.message
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

type SourceRoute = "pasted" | "photographed" | "linked";

interface CorrectionView {
  title: string;
  yieldValue: string;
  sourceText: string;
  sourceRoute: SourceRoute;
  /** The address a linked import was read from, empty on every other route. */
  sourceUrl: string;
  structuredBy: string;
  rows: Array<DraftLine | LineFormValues>;
  steps: StepFormValues[];
}

/**
 * The sample draft, offered only by a development server.
 *
 * It posts to the same `/intake/correct` the streaming island hands over to, so
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
function intakeForm(
  sourceText = "",
  submitLabel = "Jäsennä",
  sourceUrl = "",
): Raw {
  return html`<form class="stacked" id="intake">
      <label for="sourceText">Liitä reseptin teksti</label>
      <textarea
        id="sourceText"
        name="sourceText"
        rows="14"
        placeholder="Liitä tähän resepti sellaisenaan."
      >${sourceText}</textarea>

      <label for="sourceUrl">…tai hae resepti nettiosoitteesta</label>
      <!-- Deliberately not type="url": that refuses an address with no scheme,
           and pasting "kotikokki.fi/resepti" is exactly what people do. The
           browser would then block the submit before the island ever ran.
           recipe-fetch.ts fills the scheme in and checks the address. -->
      <input
        id="sourceUrl"
        name="sourceUrl"
        type="text"
        inputmode="url"
        autocomplete="off"
        value="${sourceUrl}"
        placeholder="https://…"
      />
      <p class="empty" id="link-help">
        Sivu haetaan ja siitä luetaan resepti. Löytynyt teksti tulee yllä
        olevaan kenttään ennen jäsennystä, joten voit täydentää sitä. Osoite jää
        talteen reseptin lähteeksi.
      </p>

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
        Kuvat pienennetään selaimessa ja luetaan kerran. Niitä ei tallenneta
        minnekään — talteen jää vain sivuilta luettu teksti.
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

/** `GET /intake` */
export function intakeScreen(
  { url }: RouteContext,
  member: Member,
): Response {
  return page(
    "Lisää resepti",
    html`<h1>Lisää resepti</h1>
      ${intakeForm()}
      ${isLocalOrigin(url) ? sampleDraftForm() : ""}
      `,
    "intake",
    member,
  );
}

/**
 * The photographed pages a streaming request carries, in the order they were
 * sent — that order is the reading order of the printed recipe, so nothing
 * here may sort or dedupe.
 *
 * The older single-`image` body is still read. Ruokalista is an installable
 * PWA, so a browser can be running a cached copy of yesterday's island; the
 * one-photo import it sends keeps working rather than becoming a 400.
 */
export function readImages(body: {
  image?: unknown;
  mediaType?: unknown;
  images?: unknown;
}): IntakeImage[] {
  const mediaTypeOf = (value: unknown): string =>
    typeof value === "string" && value !== "" ? value : "image/jpeg";

  if (Array.isArray(body.images)) {
    return body.images.flatMap((entry): IntakeImage[] => {
      const page = (entry ?? {}) as Record<string, unknown>;
      const base64 = page["image"];
      if (typeof base64 !== "string" || base64 === "") return [];
      return [{ base64, mediaType: mediaTypeOf(page["mediaType"]) }];
    });
  }

  if (typeof body.image === "string" && body.image !== "") {
    return [{ base64: body.image, mediaType: mediaTypeOf(body.mediaType) }];
  }

  return [];
}

/**
 * `POST /api/intake/fetch` — read a recipe off a web address (#192).
 *
 * Deliberately its own route rather than a branch of the streaming one. No
 * model runs here and nothing is spent, so the island can put the fetched text
 * in front of the member before anything expensive happens — and a page that
 * gave up nothing is a plain failure to report rather than a stream that has
 * to be unwound.
 *
 * A refusal answers with a `reason` from a closed set and no prose. The island
 * owns every Finnish word a member reads; a fetched page's own error text must
 * never become one.
 */
export async function fetchPageForIntake(
  { request }: RouteContext,
  _member: Member,
): Promise<Response> {
  let body: { url?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return fetchRefusal("invalid_url");
  }

  if (typeof body.url !== "string" || body.url.trim() === "") {
    return fetchRefusal("invalid_url");
  }

  try {
    const page = await fetchRecipePage(body.url);
    console.log(JSON.stringify({
      event: "intake.page_fetched",
      host: new URL(page.url).hostname,
      structured: page.structured,
      characters: page.sourceText.length,
    }));
    return Response.json({
      url: page.url,
      sourceText: page.sourceText,
      structured: page.structured,
    });
  } catch (error) {
    if (!(error instanceof PageRefused)) throw error;
    console.log(JSON.stringify({
      event: "intake.page_refused",
      reason: error.reason,
    }));
    return fetchRefusal(error.reason);
  }
}

/** A fetch failure on the wire: the case, named, and nothing else. */
function fetchRefusal(reason: FetchFailure): Response {
  return Response.json({ reason }, { status: 400 });
}

/**
 * `POST /api/intake/structure` — run the model and stream the draft straight
 * through. The browser accumulates it and hands it back to /intake/correct,
 * which keeps the correction screen server-rendered.
 *
 * The body is newline-delimited JSON: text deltas plus restart, complete or
 * failed records. Only the island reads it.
 */
export async function structureStream(
  { env, request }: RouteContext,
  member: Member,
): Promise<Response> {
  let body: {
    sourceText?: unknown;
    image?: unknown;
    mediaType?: unknown;
    images?: unknown;
    url?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return problem(400, "Expected a JSON body.");
  }

  const images = readImages(body);
  if (images.length > MAX_IMAGES) {
    return problem(400, `Yhteen reseptiin voi antaa enintään ${MAX_IMAGES} kuvaa.`);
  }

  const text =
    typeof body.sourceText === "string" && body.sourceText.trim() !== ""
      ? body.sourceText
      : null;

  let source: IntakeSource;
  if (images.length > 0) {
    source = { route: "photographed", images };
  } else if (text !== null && typeof body.url === "string" && body.url !== "") {
    // The address is not fetched again here — the island already did that
    // through /api/intake/fetch, and the text it got back is what arrives.
    source = { route: "linked", url: body.url, text };
  } else if (text !== null) {
    source = { route: "pasted", text };
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
      "Content-Type": "application/x-ndjson; charset=utf-8",
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
  const handedRoute = form.get("route");
  const route: SourceRoute =
    handedRoute === "photographed" || handedRoute === "linked"
      ? handedRoute
      : "pasted";
  const pasted = String(form.get("sourceText") ?? "");
  // Re-checked rather than carried through: this came back from the browser,
  // and it ends up in a href on the recipe screen.
  const address = readSourceUrl(form.get("sourceUrl"));

  const source: IntakeSource =
    route === "photographed"
      ? { route, images: [] }
      : route === "linked"
        ? { route, url: address, text: pasted }
        : { route, text: pasted };

  const ingredients = await ingredientsFor(env.DB, member.householdId);

  try {
    const draft = draftFromJson(json, source, STRUCTURED_BY);
    return page(
      "Tarkista resepti",
      correctionForm(draft, ingredients, route, address),
      "intake",
      member,
    );
  } catch (error) {
    return failed(member, importFailureMessage(error), pasted, address);
  }
}

/**
 * A web address that survived the round trip through the browser, or nothing.
 *
 * `normaliseRecipeUrl` is the same check the fetch went through, so an address
 * that could not have been fetched cannot be saved as the source of something
 * that was. A bad one is dropped rather than refused: the recipe is worth more
 * than the link, and the import is otherwise finished.
 */
function readSourceUrl(value: FormDataEntryValue | null): string {
  const given = String(value ?? "").trim();
  if (given === "") return "";
  try {
    return normaliseRecipeUrl(given).toString();
  } catch {
    return "";
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
    const sourceUrl = readSourceUrl(form.get("sourceUrl"));
    const recipeId = await saveRecipe(env.DB, member, {
      title: String(form.get("title") ?? ""),
      yieldPortions: readWhole(form.get("yield")),
      sourceText: String(form.get("sourceText") ?? ""),
      sourceRoute,
      sourceUrl: sourceUrl === "" ? null : sourceUrl,
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
  sourceUrl: string,
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
      sourceUrl,
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
      sourceUrl: readSourceUrl(form.get("sourceUrl")),
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
      <input type="hidden" name="sourceUrl" value="${view.sourceUrl}" />
      <input type="hidden" name="structuredBy" value="${view.structuredBy}" />
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

function failed(
  member: Member,
  message: string,
  sourceText: string,
  sourceUrl = "",
): Response {
  return page(
    "Jäsennys epäonnistui",
    html`<h1>Jäsennys epäonnistui</h1>
      <p class="refused">${message}</p>
      ${intakeForm(sourceText, "Yritä uudelleen", sourceUrl)}`,
    "intake",
    member,
    400,
  );
}

function readSourceRoute(value: FormDataEntryValue | null): SourceRoute {
  if (value === "pasted" || value === "photographed" || value === "linked") {
    return value;
  }
  throw new FormRefused("Reseptin lähteen tyyppi on virheellinen.");
}

function sourceRouteForRendering(form: FormData): SourceRoute {
  const given = form.get("sourceRoute");
  return given === "photographed" || given === "linked" ? given : "pasted";
}
