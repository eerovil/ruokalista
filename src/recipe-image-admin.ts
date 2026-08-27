import splitterBundle from "./generated/recipe-image-split.ts";
import { GRID, MAX_CELLS, OUTPUT_EDGE } from "./contact-sheet.ts";
import { html, page, type Raw } from "./html.ts";
import {
  imageStatus,
  type ImageOrigin,
  type ImageStatus,
} from "./image-freshness.ts";
import {
  dishBrief,
  GENERATED_BY,
  sheetPrompt,
  type DishBrief,
} from "./image-generation.ts";
import type { Member } from "./members.ts";
import {
  recipeFingerprint,
  type FingerprintLine,
} from "./recipe-fingerprint.ts";
import { findRecipe, recipeImage } from "./recipes.ts";
import type { Handler, RouteContext } from "./router.ts";

/**
 * The admin screen that decides which recipes get a generated picture, and
 * hands the drawing of it to a person.
 *
 * #95 works out whether a picture still shows its recipe and #96 built the
 * splitter; this is the screen that asks which recipes need one and then gets
 * it done. Two screens, both plain GETs:
 *
 *   1. `GET /admin/recipe-images` — every dish and what its picture is.
 *   2. `GET /admin/recipe-images/confirm` — the batch, the prompt to copy, and
 *      the field to bring the finished sheet back to.
 *
 * **Nothing here spends money and nothing here calls an image API.** #96 had a
 * paid OpenAI route; #111 removed it, because it could not work: the Workers
 * Free plan gives a request 10 ms of CPU and cutting one sheet needs over a
 * second, so the one live attempt ran 178 seconds, was killed with
 * `exceededResources`, and threw away the sheet it had just bought. See
 * `docs/adr/0005-the-worker-does-no-pixel-work.md`.
 *
 * What replaced it is the workflow the household was going to end up with
 * anyway: copy the prompt, draw the sheet in whichever image tool you like, and
 * bring the file back. The cutting then happens **in the admin's browser**, from
 * the same `contact-sheet.ts` this Worker imports, bundled by
 * `npm run generate:client`. Each crop is stored through
 * `PUT /api/recipes/:id/image?origin=generated&fingerprint=…&model=…`, which is
 * #89's bulk route with #95's provenance — no new endpoint, and the freshness
 * bookkeeping is the code that was already there.
 *
 * So the Worker's whole part in a batch is: list the recipes, write the prompt,
 * state each recipe's fingerprint, and then answer sixteen ordinary image PUTs.
 * None of that is pixel work.
 *
 * The second screen needs JavaScript, and is the only screen in the app that
 * does. It says so, and its button is rendered disabled until the bundle turns
 * it on. That is a deliberate exception to the standing rule in #65: cutting a
 * PNG apart is not something a server on this plan can do at all, and the image
 * manager is not a screen anybody uses on a fifteen-year-old iPad.
 */

/** What the flow costs, which is nothing, and what it needs from a person. */
const FLOW_NOTE =
  `Yhdelle arkille mahtuu ${MAX_CELLS} reseptiä ${GRID}×${GRID} -ruudukkona. ` +
  "Ruokalista kirjoittaa kehotteen ja leikkaa valmiin arkin selaimessasi — " +
  "kuvan piirtäminen tapahtuu itse valitsemassasi työkalussa, eikä tämä " +
  "sovellus lähetä mitään maksullista pyyntöä.";

/** One dish, and what its picture is. */
export interface ImageCandidate {
  id: number;
  title: string;
  imageKey: string | null;
  status: ImageStatus;
  /** Where the picture came from, or null when there is none. */
  origin: ImageOrigin | null;
  generatedAt: string | null;
  /**
   * What the recipe's content hashes to right now.
   *
   * Computed for the freshness verdict anyway, and carried out to the screen
   * because the browser has to state it when it stores a crop: it is the recipe
   * the picture was actually drawn from, and the gap between reading this list
   * and uploading is however long the admin spent in another tool.
   */
  fingerprint: string;
}

/** `GET /admin/recipe-images` */
export async function recipeImageAdminScreen(
  { env }: RouteContext,
  member: Member,
): Promise<Response> {
  const candidates = await imageCandidates(env.DB, member.householdId);
  return page("Reseptikuvat", listBody(candidates, null), "week", member);
}

/**
 * `GET /admin/recipe-images/confirm` — the batch, the prompt, and the sheet.
 *
 * A GET on purpose, and more so than when this screen only confirmed a paid
 * request: the admin leaves it, goes off to draw a sheet somewhere else, and
 * comes back. A screen that can be refreshed, bookmarked and reached with the
 * back button is the only sane place to stand while doing that.
 */
export async function recipeImageConfirmScreen(
  { env, url }: RouteContext,
  member: Member,
): Promise<Response> {
  const candidates = await imageCandidates(env.DB, member.householdId);
  const chosen = chooseFrom(candidates, url.searchParams.getAll("id"));

  if (typeof chosen === "string") {
    return page("Reseptikuvat", listBody(candidates, chosen), "week", member, 400);
  }

  const dishes = await briefsFor(env.DB, member.householdId, chosen);
  if (dishes === null) {
    return page(
      "Reseptikuvat",
      listBody(candidates, "Valinnassa oli resepti, jota ei enää ole."),
      "week",
      member,
      409,
    );
  }

  return page(
    "Luo reseptikuvat",
    confirmBody(chosen, sheetPrompt(dishes)),
    "week",
    member,
  );
}

/**
 * `GET /admin/recipe-images/split.js` — the committed browser bundle.
 *
 * Behind the admin wall like everything else on this screen. Not because the
 * code is secret — it is in the repository — but because there is one rule for
 * these routes and carving out an exception for the one that happens to be
 * harmless is how a boundary starts to leak.
 */
export const recipeImageSplitter: Handler = () =>
  new Response(splitterBundle, {
    headers: {
      // Revalidate every time: the bundle changes when the splitter does, and a
      // stale cached copy of the crop rules would cut sheets by rules nobody is
      // reading any more. It is 13 kB.
      "Cache-Control": "no-cache",
      "Content-Type": "text/javascript; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });

// ---------------------------------------------------------------- selection

/**
 * The posted ids as candidates, in the posted order, or the Finnish complaint
 * about them. Order is the manifest, so nothing here sorts or dedupes silently:
 * a repeat is refused, because one recipe takes one cell.
 */
function chooseFrom(
  candidates: readonly ImageCandidate[],
  raw: readonly string[],
): ImageCandidate[] | string {
  if (raw.length === 0) return "Valitse ainakin yksi resepti.";
  if (raw.length > MAX_CELLS) {
    return (
      `Yhteen erään mahtuu ${MAX_CELLS} reseptiä; valittuna oli ${raw.length}. ` +
      "Tee loput seuraavana eränä."
    );
  }

  const chosen: ImageCandidate[] = [];
  for (const value of raw) {
    const id = Number(value);
    const candidate = candidates.find((entry) => entry.id === id);
    if (candidate === undefined) return "Valinnassa oli resepti, jota ei ole.";
    if (chosen.some((entry) => entry.id === id)) {
      return `Resepti "${candidate.title}" on valittu kahdesti.`;
    }
    chosen.push(candidate);
  }

  return chosen;
}

/** What the screen preselects: everything without a usable picture, up to 16. */
function needingWork(
  candidates: readonly ImageCandidate[],
): ImageCandidate[] {
  return candidates.filter(
    (candidate) => candidate.status === "missing" || candidate.status === "stale",
  );
}

// ------------------------------------------------------------------ screens

function listBody(candidates: readonly ImageCandidate[], error: string | null): Raw {
  const waiting = needingWork(candidates);
  const rest = candidates.filter((candidate) => !waiting.includes(candidate));

  return html`<h1>Reseptikuvat</h1>
    ${error === null ? "" : html`<p class="image-error">${error}</p>`}
    <p class="empty">${FLOW_NOTE}</p>
    ${waiting.length === 0
      ? html`<p class="empty">
          Jokaisella reseptillä on ajan tasalla oleva kuva.
        </p>`
      : html`<form class="stacked" method="get" action="/admin/recipe-images/confirm">
          <h2>Kuvaa vailla (${waiting.length})</h2>
          ${waiting.length > MAX_CELLS
            ? html`<p class="empty">
                Näistä ${waiting.length} reseptistä ensimmäiset ${MAX_CELLS} on
                valmiiksi valittu. Loput tehdään omana eränään.
              </p>`
            : ""}
          ${pickList(waiting, MAX_CELLS)}
          <button type="submit" class="primary">Jatka kehotteeseen</button>
        </form>`}
    ${rest.length === 0 ? "" : currentSection(rest)}
    <p class="recipe-edit"><a href="/admin">Takaisin ylläpitoon</a></p>
    ${LIST_STYLE}`;
}

/**
 * The pictures that are current, behind a disclosure and with their own form.
 *
 * Redoing one of these is a real thing to want — a style version moved, or the
 * picture is simply poor — but it is not the job this screen is for, and a
 * fresh recipe sitting in the same list with the same checkbox is one mis-click
 * away from being replaced. So: closed by default, nothing preselected, its own
 * button, and its own words.
 *
 * A picture somebody uploaded is listed but has no checkbox at all. #95 calls
 * those manually managed: replacing a photograph a person chose is the editor's
 * job, and a bulk screen quietly overwriting one is what that rule exists to
 * prevent. That the batch is free now does not change it — their picture is
 * still theirs.
 */
function currentSection(current: readonly ImageCandidate[]): Raw {
  const generated = current.filter((candidate) => candidate.origin === "generated");
  const manual = current.filter((candidate) => candidate.origin !== "generated");

  return html`<details class="image-current">
    <summary>Ajan tasalla olevat (${current.length})</summary>
    ${generated.length === 0
      ? ""
      : html`<form class="stacked" method="get" action="/admin/recipe-images/confirm">
          ${pickList(generated, 0)}
          <button type="submit" class="quiet">Luo valituille uudelleen</button>
        </form>`}
    ${manual.length === 0
      ? ""
      : html`<h3>Itse lisätyt kuvat</h3>
          <p class="empty">
            Näitä ei luoda uudelleen. Vaihda tai poista kuva reseptin
            muokkausnäkymässä.
          </p>
          <ul class="image-list">
            ${manual.map(
              (candidate) => html`<li>
                ${recipeImage(candidate, "thumb")}
                <span class="recipes-text">
                  ${candidate.title}
                  <span class="meta">${statusLabel(candidate)}</span>
                </span>
              </li>`,
            )}
          </ul>`}
  </details>`;
}

/** A list of checkboxes; the first `preselect` of them start out ticked. */
function pickList(candidates: readonly ImageCandidate[], preselect: number): Raw {
  return html`<ul class="image-list">
    ${candidates.map(
      (candidate, at) => html`<li>
        <label>
          <input
            type="checkbox"
            name="id"
            value="${candidate.id}"
            ${at < preselect ? "checked" : ""}
          />
          ${recipeImage(candidate, "thumb")}
          <span class="recipes-text">
            ${candidate.title}
            <span class="meta">${statusLabel(candidate)}</span>
          </span>
        </label>
      </li>`,
    )}
  </ul>`;
}

/**
 * The working screen: copy the prompt, draw the sheet, bring it back.
 *
 * The prompt sits in a read-only textarea rather than a `<pre>` because copying
 * it is the point, and a textarea can be selected and copied with the keyboard
 * on every browser — which is what the Copy button degrades to. `readonly`
 * rather than `disabled` keeps it selectable while saying it is not to be
 * edited; editing it would change nothing anyway, since the prompt is never
 * posted back. Only the sheet comes back.
 *
 * The manifest carries each recipe's id and fingerprint as data attributes,
 * because that is what the browser needs to store a crop: which recipe the cell
 * belongs to, and which version of the recipe the picture is of. It is also
 * what an admin checks the drawn sheet against before cutting it — position is
 * the whole mapping, so a sheet whose cells came back in another order would
 * put pictures on the wrong recipes and nothing downstream could tell.
 */
function confirmBody(chosen: readonly ImageCandidate[], prompt: string): Raw {
  const current = chosen.filter((candidate) => candidate.status === "fresh");

  return html`<h1>Luo reseptikuvat</h1>
    <p>
      ${chosen.length === 1
        ? "Yksi resepti saa uuden kuvan."
        : `${chosen.length} reseptiä saa uuden kuvan.`}
      Ne piirretään yhdelle arkille tässä järjestyksessä.
    </p>
    <p class="empty">${FLOW_NOTE}</p>
    ${current.length === 0
      ? ""
      : html`<p class="image-error">
          ${current.length === 1
            ? "Yhden valitun reseptin kuva on jo ajan tasalla."
            : `${current.length} valitun reseptin kuva on jo ajan tasalla.`}
          Vanha kuva korvataan.
        </p>`}

    <h2>1. Kopioi kehote</h2>
    <p class="empty">
      Vie kehote haluamaasi kuvageneraattoriin. Älä muuta ruudukon muotoa: aina
      ${GRID}×${GRID} ruutua, läpinäkyvä tausta, ei tekstiä. Ruudun paikka on
      ainoa asia, joka kertoo minkä reseptin kuva se on.
    </p>
    <textarea id="sheet-prompt" class="sheet-prompt" rows="14" readonly>${prompt}</textarea>
    <p><button type="button" class="button" id="copy-prompt">Kopioi kehote</button></p>

    <h2>2. Tarkista ruutujärjestys</h2>
    <p class="empty">
      Ruudut luetaan vasemmalta oikealle ja sitten alaspäin. Ruutu 1 on listan
      ensimmäinen resepti.
    </p>
    <ol class="image-manifest" id="split-manifest">
      ${chosen.map(
        (candidate) => html`<li
          data-recipe-id="${candidate.id}"
          data-fingerprint="${candidate.fingerprint}"
          data-expected-image-key="${candidate.imageKey ?? ""}"
          data-title="${candidate.title}"
        >
          <span class="image-row">
            ${recipeImage(candidate, "thumb")}
            <span class="recipes-text">
              ${candidate.title}
              <span class="meta" data-cell-status>${statusLabel(candidate)}</span>
            </span>
          </span>
        </li>`,
      )}
    </ol>

    <h2>3. Leikkaa arkki ja tallenna kuvat</h2>
    <p class="empty">
      Arkin pitää olla PNG, jonka tausta on läpinäkyvä — juuri läpinäkyvyydestä
      annokset erotellaan toisistaan. Moni kuvageneraattori litistää
      läpinäkyvyyden, ja sellainen arkki hylätään. Leikkaaminen tapahtuu tässä
      selaimessa, ja jokainen kuva tallennetaan ${OUTPUT_EDGE} kuvapisteen
      neliönä. Jos arkkia ei voi leikata turvallisesti, mitään ei tallenneta.
    </p>
    <form class="stacked" id="split-form" data-model="${GENERATED_BY}">
      <label for="sheet">Valmis arkki</label>
      <input type="file" id="sheet" name="sheet" accept="image/png" />
      <button type="submit" class="primary" id="split-submit" disabled>
        Leikkaa arkki ja tallenna kuvat
      </button>
    </form>
    <p class="split-note split-quiet" id="split-note">
      Tämä vaihe tarvitsee JavaScriptin: arkin leikkaaminen on kuvankäsittelyä,
      johon palvelimen suoritinaika ei riitä.
    </p>
    <p class="recipe-edit"><a href="/admin/recipe-images">Takaisin listaan</a></p>
    <script src="/admin/recipe-images/split.js" defer></script>
    ${COPY_SCRIPT}
    ${LIST_STYLE}`;
}

function statusLabel(candidate: ImageCandidate): string {
  if (candidate.status === "missing") return "Ei kuvaa";
  if (candidate.status === "stale") return "Vanhentunut — resepti on muuttunut";
  return candidate.origin === "generated" ? "Ajan tasalla" : "Itse lisätty kuva";
}

/**
 * The Copy button, which is an enhancement and nothing more.
 *
 * Three levels, tried in order: the async clipboard API, the old
 * `document.execCommand("copy")`, and — failing both — the text left selected
 * so the admin can copy it with the keyboard. The prompt is visible and
 * selectable whatever happens, so this can fail quietly.
 *
 * Inline and separate from the bundle on purpose: it is four lines of DOM work
 * with no shared logic behind it, and it is the one part of this screen that
 * still works on a browser too old to cut a sheet.
 *
 * A template literal, so no backslashes and no regular expressions in here.
 */
const COPY_SCRIPT = html`<script>
  (function () {
    var button = document.getElementById("copy-prompt");
    var field = document.getElementById("sheet-prompt");
    if (!button || !field || !button.addEventListener) return;

    function finish(copied) {
      button.innerHTML = copied ? "Kopioitu" : "Kopioi näppäimistöllä";
    }

    function fallback() {
      var copied = false;
      if (document.execCommand) {
        try {
          copied = document.execCommand("copy");
        } catch (error) {
          copied = false;
        }
      }
      finish(copied);
    }

    button.addEventListener("click", function () {
      // Selecting first: it is what the keyboard fallback needs, and it is
      // harmless feedback when a copy does go through.
      field.focus();
      field.select();

      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          navigator.clipboard.writeText(field.value).then(function () {
            finish(true);
          }, fallback);
          return;
        } catch (error) {
          fallback();
          return;
        }
      }
      fallback();
    });
  })();
</script>`;

const LIST_STYLE = html`<style>
  .image-list, .image-manifest { margin: 0 0 1.5rem; }
  .image-list { list-style: none; padding: 0; }
  .image-manifest { padding-left: 1.6rem; }
  .image-list li, .image-manifest li { border-bottom: 1px solid var(--edge); }
  /* Specific enough to beat form.stacked's block labels, which would put the
     checkbox, the picture and the title on three separate lines. */
  .image-list li label, .image-list > li, .image-manifest .image-row {
    display: flex; align-items: center; gap: .7rem; margin: 0;
    min-height: var(--tap); padding: .6rem 0; font-size: 1rem;
  }
  .image-list li label { padding: 0; }
  /* The cell number is the point of this list, so the row cannot be the list
     item itself — a flex list item shows no marker. */
  .image-manifest li { padding-left: .3rem; }
  .image-list li > .recipes-text { display: inline-flex; }
  .image-list input[type="checkbox"] { width: auto; min-height: 0; flex: none; }
  .image-current { margin: 1.5rem 0; }
  .image-current > summary {
    display: inline-flex; align-items: center; min-height: var(--tap-compact);
    cursor: pointer; color: var(--muted); font-size: .9rem;
  }
  .image-error, .split-note {
    padding: .6rem .7rem; border-radius: var(--radius);
    background: var(--surface); color: var(--text); font-size: .9rem;
  }
  /* A read-only field is not an input to fill in, so it does not read as one. */
  .sheet-prompt {
    width: 100%; font-family: monospace; font-size: .85rem; line-height: 1.4;
    background: var(--surface); color: var(--text);
  }
  .split-done { color: var(--accent); }
  .split-error { color: var(--text); font-weight: 600; }
</style>`;

// ------------------------------------------------------------------ queries

interface CandidateRow {
  id: number;
  parent_id: number | null;
  title: string;
  image_key: string | null;
  image_origin: ImageOrigin | null;
  image_fingerprint: string | null;
  image_generated_at: string | null;
}

interface CandidateLineRow {
  recipe_id: number;
  quantity: number | null;
  quantity_max: number | null;
  unit: string | null;
  alt_quantity: number | null;
  alt_unit: string | null;
  ingredient: string;
}

/**
 * Every dish in the household with the freshness of its picture.
 *
 * Two queries for the whole list, not two per recipe. The fingerprint needs a
 * dish's lines *and* its parts' lines, which `findRecipe` would fetch one
 * recipe at a time; a household of a hundred recipes would be several hundred
 * round trips to render one screen. So the rows come back in bulk and the
 * dishes are assembled here.
 *
 * Only dishes are listed. A part is not something anybody plans or picks, and
 * a picture of a cheese sauce on its own is not what this screen is for — the
 * fingerprint of the dish already includes its parts' ingredients.
 *
 * The verdict itself is `imageStatus` from #95, the same function the recipe
 * API answers with, so this screen and that API cannot disagree.
 */
export async function imageCandidates(
  db: D1Database,
  householdId: number,
): Promise<ImageCandidate[]> {
  const batch = await db.batch<never>([
    db
      .prepare(
        `SELECT id, parent_id, title, image_key, image_origin,
                image_fingerprint, image_generated_at
           FROM recipe
          WHERE household_id = ?
          ORDER BY created_at DESC, id DESC`,
      )
      .bind(householdId),
    db
      .prepare(
        `SELECT ingredient_line.recipe_id,
                ingredient_line.quantity,
                ingredient_line.quantity_max,
                ingredient_line.unit,
                ingredient_line.alt_quantity,
                ingredient_line.alt_unit,
                ingredient.name AS ingredient
           FROM ingredient_line
           JOIN recipe ON recipe.id = ingredient_line.recipe_id
           JOIN ingredient ON ingredient.id = ingredient_line.ingredient_id
          WHERE recipe.household_id = ?`,
      )
      .bind(householdId),
  ]);

  const rows = (batch[0]?.results ?? []) as unknown as CandidateRow[];
  const lineRows = (batch[1]?.results ?? []) as unknown as CandidateLineRow[];

  const lines = new Map<number, FingerprintLine[]>();
  for (const row of lineRows) {
    const mine = lines.get(row.recipe_id) ?? [];
    mine.push({
      quantity: row.quantity,
      quantityMax: row.quantity_max,
      unit: row.unit,
      altQuantity: row.alt_quantity,
      altUnit: row.alt_unit,
      ingredient: row.ingredient,
    });
    lines.set(row.recipe_id, mine);
  }

  const parts = new Map<number, CandidateRow[]>();
  for (const row of rows) {
    if (row.parent_id === null) continue;
    const mine = parts.get(row.parent_id) ?? [];
    mine.push(row);
    parts.set(row.parent_id, mine);
  }

  const candidates: ImageCandidate[] = [];
  for (const row of rows) {
    if (row.parent_id !== null) continue;

    const fingerprint = await recipeFingerprint({
      title: row.title,
      lines: lines.get(row.id) ?? [],
      parts: (parts.get(row.id) ?? []).map((part) => ({
        title: part.title,
        lines: lines.get(part.id) ?? [],
      })),
    });

    candidates.push({
      id: row.id,
      title: row.title,
      imageKey: row.image_key,
      status: imageStatus(
        {
          imageKey: row.image_key,
          imageOrigin: row.image_origin,
          imageFingerprint: row.image_fingerprint,
        },
        fingerprint,
      ),
      origin: row.image_key === null ? null : (row.image_origin ?? "manual"),
      generatedAt: row.image_generated_at,
      fingerprint,
    });
  }

  return candidates;
}

/**
 * The visual briefs the prompt is written from, in cell order.
 *
 * `dishBrief` needs a recipe's parts as well as its own lines — a lasagne looks
 * like its meat sauce and its cheese sauce — so this is the one place that does
 * pay for a `findRecipe` per recipe. It is sixteen reads at most, on a screen
 * reached by pressing a button, rather than the whole list `imageCandidates`
 * renders.
 *
 * Null when a chosen recipe has gone: it was on the list a moment ago, and
 * building a prompt for a recipe that no longer exists would produce a sheet
 * with a cell nothing can be stored into.
 */
async function briefsFor(
  db: D1Database,
  householdId: number,
  chosen: readonly ImageCandidate[],
): Promise<DishBrief[] | null> {
  const dishes: DishBrief[] = [];

  for (const candidate of chosen) {
    const recipe = await findRecipe(db, householdId, candidate.id);
    if (recipe === null) return null;
    dishes.push(dishBrief(candidate.id, recipe));
  }

  return dishes;
}
