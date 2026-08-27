import {
  addDays,
  dayName,
  isDate,
  mondayOf,
  shortDate,
  shortDayName,
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
import { recipeImage, recipeSummaries, type RecipeSummary } from "./recipes.ts";
import type { RouteContext } from "./router.ts";

const SLOT_NAMES: Record<Slot, string> = {
  lunch: "Lounas",
  dinner: "Päivällinen",
};

/**
 * `GET /` — seven days, each holding the batches that *begin* in it.
 *
 * A batch is one cooking, however many meals it feeds, so the week draws it
 * once: one card, anchored at the batch's first occurrence inside the visible
 * week, listing every day and meal that cooking covers. Grouping is by batch
 * id — two separate cookings of the same recipe stay two cards.
 */
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
  const isCurrentWeek = monday === mondayOf(now);

  return page(
    "Viikko",
    html`<h1>Viikko</h1>
      <nav class="weeks">
        <a href="/?week=${addDays(monday, -7)}" rel="prev">← Edellinen</a>
        <a href="/">Tämä viikko</a>
        <a href="/?week=${addDays(monday, 7)}" rel="next">Seuraava →</a>
      </nav>
      <div class="week-days">
        ${days.map((date) => daySection(date, batches, date === now, monday, days[6]!))}
      </div>
      ${isCurrentWeek
        ? html`<a class="to-today" href="#tanaan">Tänään</a>`
        : ""}
      ${isCurrentWeek ? SCROLL_TO_TODAY : ""}`,
    "week",
    member,
  );
}

/**
 * Opens the current week where the household actually is, rather than always
 * at Monday. It runs once, at parse time, before anyone can have scrolled, so
 * there is nothing to fight; a past or future week never renders it at all.
 *
 * An empty week gets it too: seven day headings and fourteen add links are
 * already taller than a phone, and a week with nothing on it is exactly the
 * one somebody opens in order to plan today.
 *
 * ES5 on purpose — inline scripts ship untranspiled.
 */
const SCROLL_TO_TODAY = raw(`<script>
(function () {
  var day = document.getElementById("tanaan");
  if (!day || !day.scrollIntoView) return;
  // An explicit anchor, or a scroll position the browser restored, wins.
  if (window.location.hash) return;
  if (window.pageYOffset > 0) return;
  try {
    day.scrollIntoView(true);
  } catch (error) {
    // An old browser without the option object still has nothing to fix.
  }
})();
</script>`);

function daySection(
  date: string,
  batches: PlannedBatch[],
  isToday: boolean,
  monday: string,
  sunday: string,
): Raw {
  const starting = batches
    .filter((batch) => anchorDate(batch) === date)
    .sort(
      (a, b) =>
        slotOrder(firstOccurrenceOn(a, date)) -
          slotOrder(firstOccurrenceOn(b, date)) || a.id - b.id,
    );
  const continuing = continuingRecipesOn(date, batches);
  const isCovered = SLOTS.every((slot) =>
    continuing.some((recipe) => recipe.slots.includes(slot)),
  );

  return html`<section
    class="${isToday ? "day is-today" : "day"}"
    ${isToday ? rawTodayId : ""}
  >
    <h2>
      ${dayName(date)} <span class="meta">${shortDate(date)}</span>
      ${isToday ? html`<span class="today-badge">Tänään</span>` : ""}
      ${isCovered
        ? html`<span class="covered-status">✓ katettu</span>`
        : ""}
    </h2>
    ${continuing.length === 0
      ? ""
      : html`<ul class="continuing-card">
          ${continuing.map(
            (recipe) => html`<li
              class="continuing-row"
              data-recipe-id="${recipe.recipeId}"
            >
              <span class="continuing-title">${recipe.title}</span>
              <span class="continuing-slots"
                >${recipe.slots.map((slot) => SLOT_NAMES[slot]).join(" · ")}</span
              >
            </li>`,
          )}
        </ul>`}
    ${starting.length === 0
      ? ""
      : html`<div class="batch-cards">
          ${starting.map((batch) => batchCard(batch, monday, sunday))}
        </div>`}
    <div class="slot-actions">
      ${SLOTS.map((slot) => slotAction(date, slot, batches))}
    </div>
  </section>`;
}

const rawTodayId = raw('id="tanaan"');

interface ContinuingRecipe {
  recipeId: number;
  title: string;
  slots: Slot[];
  firstBatchId: number;
}

/** Recipes cooked on an earlier visible day, once each for this date. */
function continuingRecipesOn(
  date: string,
  batches: PlannedBatch[],
): ContinuingRecipe[] {
  const byRecipe = new Map<number, ContinuingRecipe>();

  for (const batch of batches) {
    if (anchorDate(batch) >= date) continue;
    const occurrences = batch.occurrences.filter((item) => item.date === date);
    if (occurrences.length === 0) continue;

    const existing = byRecipe.get(batch.recipeId);
    const recipe = existing ?? {
      recipeId: batch.recipeId,
      title: batch.title,
      slots: [],
      firstBatchId: batch.id,
    };
    for (const occurrence of occurrences) {
      if (!recipe.slots.includes(occurrence.slot)) {
        recipe.slots.push(occurrence.slot);
      }
    }
    recipe.slots.sort((a, b) => SLOTS.indexOf(a) - SLOTS.indexOf(b));
    recipe.firstBatchId = Math.min(recipe.firstBatchId, batch.id);
    if (existing === undefined) byRecipe.set(batch.recipeId, recipe);
  }

  return [...byRecipe.values()].sort(
    (a, b) =>
      SLOTS.indexOf(a.slots[0]!) - SLOTS.indexOf(b.slots[0]!) ||
      a.firstBatchId - b.firstBatchId,
  );
}

/** The day this batch's card is drawn in: its first occurrence in view. */
function anchorDate(batch: PlannedBatch): string {
  return batch.occurrences.reduce(
    (earliest, item) => (item.date < earliest ? item.date : earliest),
    batch.occurrences[0]?.date ?? batch.startDate,
  );
}

function firstOccurrenceOn(
  batch: PlannedBatch,
  date: string,
): BatchOccurrence | null {
  return batch.occurrences.find((item) => item.date === date) ?? null;
}

function slotOrder(occurrence: BatchOccurrence | null): number {
  return occurrence === null ? SLOTS.length : SLOTS.indexOf(occurrence.slot);
}

/**
 * One cooking, as one card. The head is the recipe, the portions pill and the
 * way into every batch action; the rows below it are the meals this same pot
 * covers, in order, across days.
 */
function batchCard(batch: PlannedBatch, monday: string, sunday: string): Raw {
  const days = occurrenceDays(batch);
  const cookedInView = batch.startDate >= monday;
  const finishesInView = batch.endDate <= sunday;

  return html`<article class="batch-card" data-batch-id="${batch.id}">
    <div class="entry"><a href="/batches/${batch.id}">
      <span class="batch-head-main">
        ${recipeImage({ id: batch.recipeId, imageKey: batch.imageKey }, "thumb")}
        <span class="entry-title">${batch.title}</span>
      </span>
      ${cookedInView
        ? html`<span class="batch-start">Kokataan · ${batch.portions} annosta</span>`
        : html`<span class="batch-carried">Kokattu ${shortDate(batch.startDate)} · ${batch.portions} annosta</span>`}
    </a></div>
    <ul class="batch-when">
      ${days.map(
        (day, index) => html`<li class="batch-when-day">
          <span class="batch-when-weekday">${shortDayName(day.date)}</span>
          <span class="batch-when-date">${shortDate(day.date)}</span>
          <span class="batch-when-slots">${day.slots.map((slot) => SLOT_NAMES[slot]).join(" · ")}</span>
          ${index === 0 ? "" : html`<span class="batch-passes">jatkuu</span>`}
        </li>`,
      )}
    </ul>
    ${finishesInView
      ? html`<p class="batch-end">viimeinen annos</p>`
      : html`<p class="batch-onward">jatkuu ensi viikolle</p>`}
  </article>`;
}

interface OccurrenceDay {
  date: string;
  slots: Slot[];
}

/** The batch's in-view occurrences, one row per day, lunch before dinner. */
function occurrenceDays(batch: PlannedBatch): OccurrenceDay[] {
  const byDate = new Map<string, Slot[]>();
  for (const occurrence of batch.occurrences) {
    const slots = byDate.get(occurrence.date);
    if (slots === undefined) byDate.set(occurrence.date, [occurrence.slot]);
    else if (!slots.includes(occurrence.slot)) slots.push(occurrence.slot);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, slots]) => ({
      date,
      slots: [...slots].sort((a, b) => SLOTS.indexOf(a) - SLOTS.indexOf(b)),
    }));
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
  // The same invitation whether or not the meal already has something on it:
  // a second dish is an ordinary thing to plan, not a different action.
  return html`<a
    class="${occupied ? "add-more" : "empty-slot"}"
    href="/picker?date=${date}&slot=${slot}"
  >+ ${SLOT_NAMES[slot]}</a>`;
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
  if (batch === null) return batchNotFound(member);
  const recipes = await recipeSummaries(env.DB, member.householdId, "");
  return page(batch.title, batchActions(batch, null, recipes), "week", member);
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
    ${recipeImage({ id: batch.recipeId, imageKey: batch.imageKey })}
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
  if (batch === null) return batchNotFound(member);
  const asked = url.searchParams.get("week") ?? "";
  const monday = mondayOf(isDate(asked) ? asked : batch.startDate);
  return page(batch.title, coverageEditor(batch, monday, null), "week", member);
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

function batchNotFound(member: Member): Response {
  return page(
    "Ei löytynyt",
    html`<h1>Ei löytynyt</h1><p class="empty">Tätä ruokaerää ei ole ruokalistalla.</p><p><a href="/">Takaisin viikkoon</a></p>`,
    "week",
    member,
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
      member,
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
              ${recipeImage(recipe, "thumb")}
              <span class="pick-title">${recipe.title}</span>
              <input name="portions" inputmode="numeric" value="${recipe.yieldPortions ?? DEFAULT_PORTIONS}" aria-label="Annoksia" size="2" />
              <button type="submit">Lisää</button>
            </form></li>`,
          )}</ul>`}
      <p><a href="/?week=${mondayOf(date)}">Takaisin viikkoon</a></p>`,
    "week",
    member,
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
    return refused(member, error.message, isDate(date) ? date : today());
  }
  return backToWeek(date);
}

export async function changeBatchPortionsForm(
  { env, request, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const form = await request.formData();
  const batch = await findPlannedBatch(env.DB, member.householdId, Number(params["id"]));
  if (batch === null) return batchNotFound(member);
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
      member,
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
  if (batch === null) return batchNotFound(member);
  try {
    await changeRecipe(env.DB, member, batch.id, Number(form.get("recipeId")));
  } catch (error) {
    if (!(error instanceof MenuRefused)) throw error;
    return refused(member, error.message, batch.startDate);
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
  if (batch === null) return batchNotFound(member);
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
      member,
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
  if (batch === null) return batchNotFound(member);
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

function refused(member: Member, message: string, date: string): Response {
  return page(
    "Ei onnistunut",
    html`<h1>Ei onnistunut</h1><p class="refused">${message}</p><p><a href="/?week=${mondayOf(date)}">Takaisin viikkoon</a></p>`,
    "week",
    member,
    400,
  );
}
