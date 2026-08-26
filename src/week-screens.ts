import {
  addDays,
  dayName,
  isDate,
  mondayOf,
  shortDate,
  today,
  weekFrom,
} from "./dates.ts";
import { html, page, raw, type Raw } from "./html.ts";
import type { Member } from "./members.ts";
import {
  addPlannedBatch,
  changePortions,
  changeRecipe,
  DEFAULT_PORTIONS,
  findPlannedBatch,
  isSlot,
  menuBetween,
  MenuRefused,
  removePlannedBatch,
  replaceOccurrences,
  SLOTS,
  type BatchOccurrence,
  type PlannedBatch,
  type Slot,
} from "./menu.ts";
import { recipeSummaries, type RecipeSummary } from "./recipes.ts";
import type { RouteContext } from "./router.ts";

const SLOT_NAMES: Record<Slot, string> = {
  lunch: "Lounas",
  dinner: "Päivällinen",
};

/** `GET /` — seven days projected from every batch touching the week. */
export async function weekScreen(
  { env, url }: RouteContext,
  member: Member,
): Promise<Response> {
  const asked = url.searchParams.get("week") ?? "";
  const monday = mondayOf(isDate(asked) ? asked : today());
  const days = weekFrom(monday);
  const batches = await menuBetween(
    env.DB,
    member.householdId,
    monday,
    days[6]!,
  );
  const now = today();
  const { laneById, laneCount } = assignBatchLanes(batches);
  const railGutter = laneCount === 0 ? 0 : laneCount * 0.8 + 0.35;

  return page(
    "Viikko",
    html`<h1>Viikko</h1>
      <nav class="weeks">
        <a href="/?week=${addDays(monday, -7)}" rel="prev">← Edellinen</a>
        <a href="/">Tämä viikko</a>
        <a href="/?week=${addDays(monday, 7)}" rel="next">Seuraava →</a>
      </nav>
      <style>
        .week-days .day {
          display: grid;
          grid-template-columns: repeat(var(--rail-count), .8rem) minmax(0, 1fr);
          position: relative;
          margin-bottom: 0;
          padding-bottom: 1.5rem;
        }
        .week-days .day.is-today {
          border-left: 0;
          padding-left: 0;
          box-shadow: inset 3px 0 0 var(--accent);
        }
        .week-days .day h2,
        .week-days .batch-track,
        .week-days .slot-actions {
          grid-column: 1 / -1;
        }
        .week-days .day h2,
        .week-days .batch-track {
          padding-left: var(--rail-gutter);
        }
        .week-days .batch-track {
          display: block;
          min-width: 0;
        }
        .week-days .batch-track.is-end .batch-day-content::after {
          content: none;
        }
        .week-days .slot-actions {
          margin-left: var(--rail-gutter);
          padding-left: 0;
        }
        .week-days .batch-rail {
          position: relative;
          z-index: 1;
          min-width: 0;
          pointer-events: none;
        }
        .week-days .batch-rail-line {
          position: absolute;
          top: 0;
          bottom: 0;
          left: 50%;
          width: 3px;
          border-radius: 2px;
          background: var(--accent);
          transform: translateX(-50%);
        }
        .week-days .batch-rail.continues-after .batch-rail-line {
          bottom: -1.5rem;
        }
        .week-days .batch-rail-dot {
          position: absolute;
          left: 50%;
          z-index: 2;
          width: .65rem;
          height: .65rem;
          border-radius: 50%;
          background: var(--accent);
          transform: translateX(-50%);
        }
        .week-days .batch-rail-dot.is-start { top: .35rem; }
        .week-days .batch-rail-dot.is-end { bottom: .35rem; }
      </style>
      <div
        class="week-days"
        style="--rail-count:${Math.max(1, laneCount)};--rail-gutter:${railGutter}rem"
      >${days.map((date) => dayCard(date, batches, date === now, laneById))}</div>`,
    "week",
  );
}

function assignBatchLanes(
  batches: PlannedBatch[],
): { laneById: Map<number, number>; laneCount: number } {
  const laneEnds: string[] = [];
  const laneById = new Map<number, number>();
  const ordered = [...batches].sort(
    (a, b) => a.startDate.localeCompare(b.startDate) || a.id - b.id,
  );

  for (const batch of ordered) {
    let lane = laneEnds.findIndex((endDate) => endDate < batch.startDate);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = batch.endDate;
    laneById.set(batch.id, lane);
  }

  return { laneById, laneCount: laneEnds.length };
}

function dayCard(
  date: string,
  batches: PlannedBatch[],
  isToday: boolean,
  laneById: Map<number, number>,
): Raw {
  const active = batches
    .filter((batch) => batch.startDate <= date && batch.endDate >= date)
    .sort(
      (a, b) =>
        (laneById.get(a.id) ?? 0) - (laneById.get(b.id) ?? 0),
    );
  const lastGridLine = active.length + 3;

  return html`<section class="${isToday ? "day is-today" : "day"}">
    <h2 style="grid-row:1">${dayName(date)} <span class="meta">${shortDate(date)}</span></h2>
    ${active.map((batch, index) =>
      batchRail(
        batch,
        date,
        laneById.get(batch.id) ?? 0,
        index + 2,
        lastGridLine,
      ),
    )}
    ${active.map((batch, index) => batchTrack(batch, date, index + 2))}
    <div class="slot-actions" style="grid-row:${active.length + 2}">
      ${SLOTS.map((slot) => slotAction(date, slot, batches))}
    </div>
  </section>`;
}

function batchRail(
  batch: PlannedBatch,
  date: string,
  lane: number,
  trackRow: number,
  lastGridLine: number,
): Raw {
  const starts = date === batch.startDate;
  const ends = date === batch.endDate;
  const continuesBefore = date > batch.startDate;
  const continuesAfter = date < batch.endDate;
  const startRow = starts ? trackRow : 1;
  const endRow = ends ? trackRow + 1 : lastGridLine;

  return html`<div
    class="batch-rail${starts ? " is-start" : ""}${ends ? " is-end" : ""}${continuesBefore ? " continues-before" : ""}${continuesAfter ? " continues-after" : ""}"
    data-batch-id="${batch.id}"
    data-lane="${lane}"
    aria-hidden="true"
    style="grid-column:${lane + 1};grid-row:${startRow} / ${endRow}"
  >
    <span class="batch-rail-line"></span>
    ${starts ? html`<span class="batch-rail-dot is-start"></span>` : ""}
    ${ends ? html`<span class="batch-rail-dot is-end"></span>` : ""}
  </div>`;
}

function batchTrack(batch: PlannedBatch, date: string, gridRow: number): Raw {
  const occurrences = batch.occurrences.filter((item) => item.date === date);
  const starts = date === batch.startDate;
  const ends = date === batch.endDate;
  return html`<div
    class="batch-track${starts ? " is-start" : ""}${ends ? " is-end" : ""}"
    data-batch-id="${batch.id}"
    style="grid-row:${gridRow}"
  >
    <div class="batch-day-content">
      ${starts
        ? html`<strong class="batch-start">Kokataan · ${batch.portions} annosta</strong>`
        : ""}
      ${occurrences.length === 0
        ? html`<span class="batch-passes">Jatkuu</span>`
        : occurrences.map(
            (occurrence) => html`<div class="entry"><a href="/batches/${batch.id}">
              <span class="entry-slot">${SLOT_NAMES[occurrence.slot]}</span>
              <span class="entry-title">${batch.title}</span>
            </a></div>`,
          )}
      ${ends ? html`<span class="batch-end">viimeinen annos</span>` : ""}
    </div>
  </div>`;
}

function slotAction(
  date: string,
  slot: Slot,
  batches: PlannedBatch[],
): Raw {
  const occupied = batches.some((batch) =>
    batch.occurrences.some(
      (occurrence) => occurrence.date === date && occurrence.slot === slot,
    ),
  );
  return html`<a
    class="${occupied ? "add-more" : "empty-slot"}"
    href="/picker?date=${date}&slot=${slot}"
  >${occupied ? "+ Lisää toinen" : `+ ${SLOT_NAMES[slot]}`}</a>`;
}

/** `GET /batches/:id` — actions affect the whole cooked batch. */
export async function plannedBatchScreen(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const batch = await findPlannedBatch(
    env.DB,
    member.householdId,
    Number(params["id"]),
  );
  if (batch === null) return batchNotFound();
  const recipes = await recipeSummaries(env.DB, member.householdId, "");
  return page(batch.title, batchActions(batch, null, recipes), "week");
}

function batchActions(
  batch: PlannedBatch,
  refusal: { message: string; portions: string } | null,
  recipes: RecipeSummary[],
): Raw {
  const portions = refusal?.portions ?? String(batch.portions);
  return html`<p class="meta entry-when">
      ${batch.occurrences.length === 1 ? "1 ateria" : `${batch.occurrences.length} ateriaa`} ·
      ${batch.startDate === batch.endDate
        ? shortDate(batch.startDate)
        : `${shortDate(batch.startDate)}–${shortDate(batch.endDate)}`}
    </p>
    <h1>${batch.title}</h1>
    ${refusal === null ? "" : html`<p class="refused">${refusal.message}</p>`}

    <p class="batch-actions">
      <a class="button" href="/recipes/${batch.recipeId}?portions=${batch.portions}"
        >Avaa resepti</a
      >
      <a class="button" href="/batches/${batch.id}/coverage?week=${mondayOf(batch.startDate)}"
        >Jatkuu…</a
      >
    </p>

    <form method="post" action="/batches/${batch.id}/recipe" class="stacked">
      <label for="recipeId">Resepti koko erälle</label>
      <div class="portions-row">
        <select id="recipeId" name="recipeId">
          ${recipes.map(
            (recipe) => html`<option value="${recipe.id}" ${recipe.id === batch.recipeId ? rawSelected : ""}>${recipe.title}</option>`,
          )}
        </select>
        <button type="submit">Vaihda</button>
      </div>
    </form>

    <form method="post" action="/batches/${batch.id}/portions" class="stacked">
      <label for="portions">Koko erän annoksia</label>
      <div class="portions-row">
        <input id="portions" name="portions" inputmode="numeric" value="${portions}" />
        <button type="submit">Tallenna</button>
      </div>
    </form>

    <form method="post" action="/batches/${batch.id}/delete" class="stacked">
      <button type="submit" class="quiet">Poista erä ruokalistalta</button>
    </form>
    <p><a href="/?week=${mondayOf(batch.startDate)}">Takaisin viikkoon</a></p>`;
}

/** `GET /batches/:id/coverage` — one selector for every continuation shape. */
export async function coverageScreen(
  { env, params, url }: RouteContext,
  member: Member,
): Promise<Response> {
  const batch = await findPlannedBatch(
    env.DB,
    member.householdId,
    Number(params["id"]),
  );
  if (batch === null) return batchNotFound();
  const asked = url.searchParams.get("week") ?? "";
  const monday = mondayOf(isDate(asked) ? asked : batch.startDate);
  return page(batch.title, coverageEditor(batch, monday, null), "week");
}

function coverageEditor(
  batch: PlannedBatch,
  monday: string,
  error: string | null,
): Raw {
  const days = weekFrom(monday);
  const selected = new Set(
    batch.occurrences.map((item) => occurrenceValue(item)),
  );
  const outside = batch.occurrences.filter(
    (item) => item.date < monday || item.date > days[6]!,
  );

  return html`<h1>${batch.title} jatkuu</h1>
    <p>Valitse ateriat, joihin tämä sama erä riittää. Väliin ei voi jäädä kokonaan tyhjää päivää.</p>
    ${error === null ? "" : html`<p class="refused">${error}</p>`}

    <nav class="weeks coverage-weeks">
      <a href="/batches/${batch.id}/coverage?week=${addDays(monday, -7)}" rel="prev">← Edellinen</a>
      <span>${shortDate(monday)}–${shortDate(days[6]!)}</span>
      <a href="/batches/${batch.id}/coverage?week=${addDays(monday, 7)}" rel="next">Seuraava →</a>
    </nav>

    <form method="post" action="/batches/${batch.id}/coverage" class="coverage-form">
      <input type="hidden" name="week" value="${monday}" />
      ${outside.map(
        (item) => html`<input type="hidden" name="occurrence" value="${occurrenceValue(item)}" />`,
      )}
      <div class="coverage-grid">
        <span></span><strong>Lounas</strong><strong>Päivällinen</strong>
        ${days.map(
          (date) => html`<span class="coverage-day">${dayName(date)} <small>${shortDate(date)}</small></span>
            ${SLOTS.map((slot) => {
              const value = `${date}:${slot}`;
              return html`<label class="coverage-cell">
                <input type="checkbox" name="occurrence" value="${value}" ${selected.has(value) ? rawChecked : ""} />
                <span class="coverage-choice"><span class="choose">Valitse</span><span class="chosen">Valittu</span></span>
              </label>`;
            })}`,
        )}
      </div>
      <button class="primary" type="submit">Tallenna jatkumo</button>
    </form>
    <p><a href="/batches/${batch.id}">Takaisin erään</a></p>`;
}

const rawChecked = raw("checked");
const rawSelected = raw("selected");

function batchNotFound(): Response {
  return page(
    "Ei löytynyt",
    html`<h1>Ei löytynyt</h1><p class="empty">Tätä ruokaerää ei ole ruokalistalla.</p><p><a href="/">Takaisin viikkoon</a></p>`,
    "week",
    404,
  );
}

export async function pickerScreen(
  { env, url }: RouteContext,
  member: Member,
): Promise<Response> {
  const date = url.searchParams.get("date") ?? "";
  const slot = url.searchParams.get("slot") ?? "";
  const query = url.searchParams.get("q") ?? "";
  if (!isDate(date) || !isSlot(slot)) {
    return page(
      "Ei löytynyt",
      html`<h1>Ei löytynyt</h1><p class="empty">Tuntematon päivä tai ateria.</p>`,
      "week",
      404,
    );
  }
  const recipes = await recipeSummaries(env.DB, member.householdId, query);
  return page(
    "Valitse resepti",
    html`<h1>${SLOT_NAMES[slot]} ${shortDate(date)}</h1>
      <form method="get" action="/picker">
        <input type="hidden" name="date" value="${date}" />
        <input type="hidden" name="slot" value="${slot}" />
        <input type="search" name="q" value="${query}" placeholder="Hae nimellä" aria-label="Hae nimellä" />
        <button type="submit">Hae</button>
      </form>
      ${recipes.length === 0
        ? html`<div class="nothing"><p class="empty">${query.trim() === "" ? "Reseptejä ei ole vielä yhtään." : `Haku "${query.trim()}" ei löytänyt yhtään reseptiä.`}</p></div>`
        : html`<ul class="pick">${recipes.map(
            (recipe) => html`<li><form method="post" action="/batches" class="inline">
              <input type="hidden" name="date" value="${date}" />
              <input type="hidden" name="slot" value="${slot}" />
              <input type="hidden" name="recipeId" value="${recipe.id}" />
              <span class="pick-title">${recipe.title}</span>
              <input name="portions" inputmode="numeric" value="${recipe.yieldPortions ?? DEFAULT_PORTIONS}" aria-label="Annoksia" size="2" />
              <button type="submit">Lisää</button>
            </form></li>`,
          )}</ul>`}
      <p><a href="/?week=${mondayOf(date)}">Takaisin viikkoon</a></p>`,
    "week",
  );
}

export async function addBatchForm(
  { env, request }: RouteContext,
  member: Member,
): Promise<Response> {
  const form = await request.formData();
  const date = String(form.get("date") ?? "");
  try {
    await addPlannedBatch(env.DB, member, {
      date,
      slot: String(form.get("slot") ?? ""),
      recipeId: Number(form.get("recipeId")),
      portions: Number(form.get("portions")),
    });
  } catch (error) {
    if (!(error instanceof MenuRefused)) throw error;
    return refused(error.message, isDate(date) ? date : today());
  }
  return backToWeek(date);
}

export async function changeBatchPortionsForm(
  { env, request, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const form = await request.formData();
  const batch = await findPlannedBatch(env.DB, member.householdId, Number(params["id"]));
  if (batch === null) return batchNotFound();
  try {
    await changePortions(env.DB, member, batch.id, Number(form.get("portions")));
  } catch (error) {
    if (!(error instanceof MenuRefused)) throw error;
    const recipes = await recipeSummaries(env.DB, member.householdId, "");
    return page(
      batch.title,
      batchActions(batch, {
        message: error.message,
        portions: String(form.get("portions") ?? ""),
      }, recipes),
      "week",
      400,
    );
  }
  return backToWeek(batch.startDate);
}

export async function changeBatchRecipeForm(
  { env, request, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const form = await request.formData();
  const batch = await findPlannedBatch(env.DB, member.householdId, Number(params["id"]));
  if (batch === null) return batchNotFound();
  try {
    await changeRecipe(env.DB, member, batch.id, Number(form.get("recipeId")));
  } catch (error) {
    if (!(error instanceof MenuRefused)) throw error;
    return refused(error.message, batch.startDate);
  }
  return new Response(null, {
    status: 303,
    headers: { Location: `/batches/${batch.id}` },
  });
}

export async function coverageForm(
  { env, request, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const form = await request.formData();
  const batch = await findPlannedBatch(env.DB, member.householdId, Number(params["id"]));
  if (batch === null) return batchNotFound();
  const monday = mondayOf(
    isDate(String(form.get("week") ?? ""))
      ? String(form.get("week"))
      : batch.startDate,
  );
  const proposed = form.getAll("occurrence").map(parseOccurrence);
  try {
    await replaceOccurrences(env.DB, member, batch.id, proposed);
  } catch (error) {
    if (!(error instanceof MenuRefused)) throw error;
    return page(
      batch.title,
      coverageEditor({ ...batch, occurrences: proposed }, monday, error.message),
      "week",
      400,
    );
  }
  return new Response(null, {
    status: 303,
    headers: { Location: `/batches/${batch.id}/coverage?week=${monday}` },
  });
}

export async function removeBatchForm(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const batch = await findPlannedBatch(env.DB, member.householdId, Number(params["id"]));
  if (batch === null) return batchNotFound();
  await removePlannedBatch(env.DB, member, batch.id);
  return backToWeek(batch.startDate);
}

function parseOccurrence(value: FormDataEntryValue): BatchOccurrence {
  const text = String(value);
  return { date: text.slice(0, 10), slot: text.slice(11) as Slot };
}

function occurrenceValue(item: BatchOccurrence): string {
  return `${item.date}:${item.slot}`;
}

function backToWeek(date: string): Response {
  const week = mondayOf(isDate(date) ? date : today());
  return new Response(null, { status: 303, headers: { Location: `/?week=${week}` } });
}

function refused(message: string, date: string): Response {
  return page(
    "Ei onnistunut",
    html`<h1>Ei onnistunut</h1><p class="refused">${message}</p><p><a href="/?week=${mondayOf(date)}">Takaisin viikkoon</a></p>`,
    "week",
    400,
  );
}
