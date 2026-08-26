import { MAX_CELLS } from "./contact-sheet.ts";
import { html, page, type Raw } from "./html.ts";
import {
  imageStatus,
  type ImageOrigin,
  type ImageStatus,
} from "./image-freshness.ts";
import type { Member } from "./members.ts";
import { isLocalOrigin } from "./public-origin.ts";
import {
  recipeFingerprint,
  type FingerprintLine,
} from "./recipe-fingerprint.ts";
import {
  runImageBatch,
  type BatchOutcome,
  type CellReport,
} from "./recipe-image-batch.ts";
import { recipeImage } from "./recipes.ts";
import type { RouteContext } from "./router.ts";

/**
 * The admin screen that decides which recipes get a generated picture.
 *
 * #96 built the generator and #95 built the freshness calculation; neither of
 * them can say *which* recipes need one, and asking that question was the point
 * of both. This is the screen that asks it, and it is the only place in the app
 * from which money can be spent by a person rather than by a script.
 *
 * Three screens, three plain form posts, and nothing that needs JavaScript:
 *
 *   1. `GET /admin/recipe-images` — every dish and what its picture is.
 *   2. `GET /admin/recipe-images/confirm` — the exact recipes about to be
 *      drawn, in the order they will take cells. Still free.
 *   3. `POST /admin/recipe-images/generate` — the paid request, and the report.
 *
 * Opening any screen but the third buys nothing, and the third is only ever
 * reached by somebody pressing a button that says what it costs. There is no
 * regeneration on save, no queue and no schedule: a picture is bought when an
 * admin asks for one and at no other time.
 *
 * The batch itself is #96's, unchanged — including its cap of sixteen recipes
 * to a sheet. Seventeen candidates are therefore two visits to this screen
 * rather than one silent pair of paid requests, which is the whole reason the
 * cap is visible in the wording rather than only in the validation.
 */

/** How a batch's cost is described. Tokens, because a price would go stale. */
const COST_NOTE =
  "Yksi erä on yksi maksullinen kuvapyyntö: enintään 16 reseptiä samalta " +
  "arkilta. Mitattuna yksi arkki maksoi noin 7 000 kuvatokenia — suuruusluokka, " +
  "ei lasku, sillä hinta tokenia kohti on OpenAI:n hinnastossa.";

/** One dish, and what its picture is. */
export interface ImageCandidate {
  id: number;
  title: string;
  imageKey: string | null;
  status: ImageStatus;
  /** Where the picture came from, or null when there is none. */
  origin: ImageOrigin | null;
  generatedAt: string | null;
}

/** `GET /admin/recipe-images` */
export async function recipeImageAdminScreen(
  { env }: RouteContext,
  member: Member,
): Promise<Response> {
  const candidates = await imageCandidates(env.DB, member.householdId);
  return page("Reseptikuvat", listBody(candidates, null), "week");
}

/**
 * `GET /admin/recipe-images/confirm` — the recipes about to be drawn, named.
 *
 * A GET on purpose. It renders what the next screen will spend money on, and a
 * screen that can be refreshed, bookmarked and reached with the back button
 * without a browser asking about resubmission is a safer place to stand while
 * reading a list one is about to pay for.
 */
export async function recipeImageConfirmScreen(
  { env, url }: RouteContext,
  member: Member,
): Promise<Response> {
  const candidates = await imageCandidates(env.DB, member.householdId);
  const chosen = chooseFrom(candidates, url.searchParams.getAll("id"));

  if (typeof chosen === "string") {
    return page("Reseptikuvat", listBody(candidates, chosen), "week", 400);
  }

  return page("Vahvista kuvien luonti", confirmBody(chosen), "week");
}

/**
 * `POST /admin/recipe-images/generate` — the one paid action.
 *
 * The manifest is the posted order, cell 1 first, which is the same contract
 * `POST /api/admin/recipe-images/generate` keeps; the hidden fields on the
 * confirmation screen are written in that order and nothing here sorts them.
 *
 * The response is rendered rather than redirected to. A batch's report is the
 * only record of what happened to each recipe — three stored, one refused
 * because somebody uploaded a picture in the meantime — and post-then-redirect
 * would have to either throw that away or stash it somewhere to be read once.
 */
export async function recipeImageGenerateForm(
  ctx: RouteContext,
  member: Member,
): Promise<Response> {
  const form = await ctx.request.formData();
  const candidates = await imageCandidates(ctx.env.DB, member.householdId);
  const chosen = chooseFrom(candidates, form.getAll("id").map(String));

  if (typeof chosen === "string") {
    return page("Reseptikuvat", listBody(candidates, chosen), "week", 400);
  }

  const outcome = await runImageBatch(
    ctx,
    member,
    chosen.map((candidate) => candidate.id),
    suppliedSheet(ctx, form),
  );

  // Read the statuses back rather than reasoning about them: the admin is here
  // to see which recipes became fresh, and the answer to that is in the rows
  // the batch just wrote, not in what the batch believes it wrote.
  const after = await imageCandidates(ctx.env.DB, member.householdId);

  return page(
    "Kuvien luonti",
    resultBody(outcome, chosen, after),
    "week",
    outcome.kind === "refused" ? outcome.status : 200,
  );
}

/**
 * The development escape hatch, exactly the one `POST /api/admin/…/generate`
 * already has: a sheet supplied instead of bought, gated on the address the
 * browser reached rather than on any flag. It is what lets the browser suite
 * walk this whole screen — the selection, the confirmation, the split, the
 * commit and the refreshed statuses — without ever calling OpenAI.
 *
 * A deployed Worker is only ever addressed by a public hostname, so no secret
 * and no configuration turns this on live.
 */
function suppliedSheet(
  { url }: RouteContext,
  form: FormData,
): string | undefined {
  if (!isLocalOrigin(url)) return undefined;
  const supplied = form.get("sheetBase64");
  return typeof supplied === "string" && supplied.length > 0 ? supplied : undefined;
}

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
    <p class="empty">${COST_NOTE}</p>
    ${waiting.length === 0
      ? html`<p class="empty">
          Jokaisella reseptillä on ajan tasalla oleva kuva. Tältä sivulta ei
          lähde pyyntöjä ennen kuin joku painaa nappia.
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
          <button type="submit" class="primary">Katso erä ennen luontia</button>
        </form>`}
    ${rest.length === 0 ? "" : currentSection(rest)}
    <p class="recipe-edit"><a href="/admin">Takaisin ylläpitoon</a></p>
    ${LIST_STYLE}`;
}

/**
 * The pictures that are current, behind a disclosure and with their own form.
 *
 * Regenerating one of these is a real thing to want — a style version moved, or
 * the picture is simply poor — but it is not the job this screen is for, and a
 * fresh recipe sitting in the same list with the same checkbox is one mis-click
 * away from being paid for. So: closed by default, nothing preselected, its own
 * button, and its own words.
 *
 * A picture somebody uploaded is listed but has no checkbox at all. #95 calls
 * those manually managed, and replacing one is the editor's job — this screen
 * spending money to overwrite a photograph a person chose is exactly what that
 * rule exists to prevent.
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
          <button type="submit" class="quiet">
            Luo valituille uudelleen (maksullinen)
          </button>
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

function confirmBody(chosen: readonly ImageCandidate[]): Raw {
  const current = chosen.filter((candidate) => candidate.status === "fresh");

  return html`<h1>Vahvista kuvien luonti</h1>
    <p>
      ${chosen.length === 1
        ? "Yksi resepti saa uuden kuvan."
        : `${chosen.length} reseptiä saa uuden kuvan.`}
      Ne piirretään yhdelle arkille tässä järjestyksessä.
    </p>
    <p class="empty">${COST_NOTE}</p>
    ${current.length === 0
      ? ""
      : html`<p class="image-error">
          ${current.length === 1
            ? "Yhden valitun reseptin kuva on jo ajan tasalla."
            : `${current.length} valitun reseptin kuva on jo ajan tasalla.`}
          Vanha kuva korvataan.
        </p>`}
    <ol class="image-manifest">
      ${chosen.map(
        (candidate) => html`<li>
          <span class="image-row">
            ${recipeImage(candidate, "thumb")}
            <span class="recipes-text">
              ${candidate.title}
              <span class="meta">${statusLabel(candidate)}</span>
            </span>
          </span>
        </li>`,
      )}
    </ol>
    <form class="stacked" method="post" action="/admin/recipe-images/generate" id="generate">
      ${chosen.map(
        (candidate) => html`<input type="hidden" name="id" value="${candidate.id}" />`,
      )}
      <button type="submit" class="primary" id="generate-submit">
        Luo kuvat nyt (1 maksullinen pyyntö)
      </button>
    </form>
    <p class="recipe-edit"><a href="/admin/recipe-images">Peruuta</a></p>
    ${GUARD_SCRIPT}
    ${LIST_STYLE}`;
}

/**
 * What the batch did, recipe by recipe.
 *
 * Every recipe that was asked for appears, whatever happened to it — a report
 * that listed only the successes would leave an admin to work out from the
 * count which one did not come back. The statuses are the ones read from the
 * database afterwards, so a recipe shown as fresh here is fresh.
 */
function resultBody(
  outcome: BatchOutcome,
  chosen: readonly ImageCandidate[],
  after: readonly ImageCandidate[],
): Raw {
  if (outcome.kind === "refused") {
    return html`<h1>Kuvia ei luotu</h1>
      <p class="image-error">Erä ei lähtenyt: ${outcome.english}</p>
      <p class="empty">
        Mitään ei muutettu, joten reseptit ovat yhä valittavissa uudelleen.
      </p>
      <p><a class="button" href="/admin/recipe-images">Takaisin listaan</a></p>
      ${LIST_STYLE}`;
  }

  const cells: readonly CellReport[] = outcome.cells;
  const stored = outcome.kind === "stored" ? outcome.stored : 0;

  return html`<h1>${stored === 0 ? "Kuvia ei luotu" : "Kuvat luotu"}</h1>
    ${outcome.kind === "rejected"
      ? html`<p class="image-error">
          Arkkia ei voitu leikata turvallisesti, joten mitään ei tallennettu.
          Yritä uudelleen — se ostaa uuden arkin.
        </p>`
      : html`<p>
          ${stored} / ${cells.length} reseptiä sai kuvan. Mallina
          ${outcome.model}, tyyli ${outcome.styleVersion}.
        </p>`}
    <ul class="image-list">
      ${cells.map((cell) => {
        const now = after.find((candidate) => candidate.id === cell.recipeId);
        return html`<li>
          ${now === undefined ? "" : recipeImage(now, "thumb")}
          <span class="recipes-text">
            <a href="/recipes/${cell.recipeId}">${cell.title}</a>
            <span class="meta">
              ${cell.status === "stored"
                ? `Kuva tallennettu · ${now === undefined ? "" : statusLabel(now)}`
                : `Ei kuvaa: ${cell.reason ?? "syytä ei kerrottu"}`}
            </span>
          </span>
        </li>`;
      })}
    </ul>
    <p><a class="button" href="/admin/recipe-images">Takaisin listaan</a></p>
    ${LIST_STYLE}`;
}

function statusLabel(candidate: ImageCandidate): string {
  if (candidate.status === "missing") return "Ei kuvaa";
  if (candidate.status === "stale") return "Vanhentunut — resepti on muuttunut";
  return candidate.origin === "generated" ? "Ajan tasalla" : "Itse lisätty kuva";
}

/**
 * One press, one batch. The button is disabled as the form goes, because a
 * second press during the minute a sheet takes to be drawn is a second paid
 * request for the same recipes.
 *
 * Feature-detected and free to do nothing: without it the worst case is the
 * duplicate this prevents, not an unusable screen, and the server refuses
 * nothing on account of it. Note the *first* press still submits — the guard
 * runs during the submit it is guarding.
 */
const GUARD_SCRIPT = html`<script>
  (function () {
    var form = document.getElementById("generate");
    if (!form || !form.addEventListener) return;
    form.addEventListener("submit", function () {
      var button = document.getElementById("generate-submit");
      if (!button) return;
      // Disabled after the browser has taken the click, so the post still goes.
      setTimeout(function () {
        button.disabled = true;
        button.innerHTML = "Luodaan kuvia…";
      }, 0);
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
  .image-error {
    padding: .6rem .7rem; border-radius: var(--radius);
    background: var(--surface); color: var(--text); font-size: .9rem;
  }
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
                          AND ingredient.household_id = recipe.household_id
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
    });
  }

  return candidates;
}
