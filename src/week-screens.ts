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
import { html, multiplierField, page, raw, type Raw } from "./html.ts";
import type { Member } from "./members.ts";
import {
  addPlannedBatch,
  changeMultiplier,
  changeRecipe,
  findPlannedBatch,
  isSlot,
  menuBetween,
  MenuRefused,
  moveBatchTo,
  removePlannedBatch,
  SLOTS,
  type BatchOccurrence,
  type PlannedBatch,
  type Slot,
} from "./menu.ts";
import { loadVocabulary } from "./categories.ts";
import { cookHistory } from "./cook-history.ts";
import { browseStateFrom, recipeBrowser } from "./recipe-browser.ts";
import {
  plannableRecipeSummaries,
  recipeImage,
  type RecipeSummary,
} from "./recipes.ts";
import { preferredMultipliers } from "./recipe-preference.ts";
import type { RouteContext } from "./router.ts";
import {
  DEFAULT_MULTIPLIER,
  formatMultiplier,
  MULTIPLIER_CHOICES,
  parseMultiplier,
} from "./scaling.ts";

const SLOT_NAMES: Record<Slot, string> = {
  lunch: "Lounas",
  dinner: "Päivällinen",
};

/** How many weeks the planning screen shows at once (#250). */
const VISIBLE_WEEKS = 2;

/**
 * `GET /` — two weeks of days, each holding the batches that *begin* in it.
 *
 * A batch is one cooking, however many meals it feeds, so the screen draws it
 * once: one card, anchored at the batch's first occurrence inside the visible
 * range, listing every day and meal that cooking covers. Grouping is by batch
 * id — two separate cookings of the same recipe stay two cards.
 *
 * Two weeks rather than one (#250), because a household plans the shopping and
 * the cooking for a fortnight in one sitting and a cooking that runs over a
 * Sunday is no longer split across two screens. `?week=` still names the first
 * Monday; the arrows move a whole fortnight, so the pair does not shear.
 */
export async function weekScreen(
  { env, url }: RouteContext,
  member: Member,
): Promise<Response> {
  const asked = url.searchParams.get("week") ?? "";
  const monday = mondayOf(isDate(asked) ? asked : today());
  const weeks = Array.from({ length: VISIBLE_WEEKS }, (_, index) =>
    weekFrom(addDays(monday, index * 7)),
  );
  const lastDay = weeks[VISIBLE_WEEKS - 1]![6]!;
  const batches = await menuBetween(
    env.DB,
    member.householdId,
    monday,
    lastDay,
  );
  const now = today();
  // The whole visible range, not just its first week: today is in view
  // wherever inside the fortnight it falls.
  const showsToday = now >= monday && now <= lastDay;

  return page(
    "Viikko",
    html`<h1>Viikko</h1>
      <nav class="weeks">
        <a href="/?week=${addDays(monday, -7 * VISIBLE_WEEKS)}" rel="prev">← Edelliset</a>
        <a href="/">Tämä viikko</a>
        <a href="/?week=${addDays(monday, 7 * VISIBLE_WEEKS)}" rel="next">Seuraavat →</a>
      </nav>
      <div class="week-pair">
        ${weeks.map((days) => weekBlock(days, batches, now, monday, lastDay))}
      </div>
      ${showsToday
        ? html`<a class="to-today" href="#tanaan">Tänään</a>`
        : ""}
      ${showsToday ? SCROLL_TO_TODAY : ""}`,
    "week",
    member,
  );
}

/**
 * One of the two weeks, under a heading naming its dates.
 *
 * Fourteen day headings are a long scroll on a phone, and the heading is what
 * keeps the second week from reading as more of the first.
 */
function weekBlock(
  days: string[],
  batches: PlannedBatch[],
  now: string,
  rangeStart: string,
  rangeEnd: string,
): Raw {
  const holdsToday = now >= days[0]! && now <= days[6]!;
  return html`<section class="week-block">
    <h2 class="week-heading">
      <span class="week-range">${shortDate(days[0]!)}–${shortDate(days[6]!)}</span>
      ${holdsToday ? html`<span class="week-now">Tämä viikko</span>` : ""}
    </h2>
    <div class="week-days">
      ${days.map((date) =>
        daySection(date, batches, date === now, rangeStart, rangeEnd),
      )}
    </div>
  </section>`;
}

/**
 * Opens the current week where the household actually is, rather than always
 * at Monday. It runs once, at parse time, before anyone can have scrolled, so
 * there is nothing to fight; a past or future week never renders it at all.
 *
 * An empty fortnight gets it too: fourteen day headings and twenty-eight add
 * links are already taller than a phone, and a fortnight with nothing on it is
 * exactly the one somebody opens in order to plan today.
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
  rangeStart: string,
  rangeEnd: string,
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
    <h3>
      ${dayName(date)} <span class="meta">${shortDate(date)}</span>
      ${isToday ? html`<span class="today-badge">Tänään</span>` : ""}
      ${isCovered
        ? html`<span class="covered-status">✓ katettu</span>`
        : ""}
    </h3>
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
          ${starting.map((batch) => batchCard(batch, rangeStart, rangeEnd))}
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
 * One cooking, as one card. The head is the recipe and the multiplier pill, and
 * tapping it opens the recipe at this batch's amounts — cooking is what the
 * week screen is for, so it is the plain tap and not a stop on the way (#309).
 * Changing the plan is the quiet `Muokkaa` beside it. The rows below are the
 * meals this same pot covers, in order, across days.
 */
function batchCard(
  batch: PlannedBatch,
  rangeStart: string,
  rangeEnd: string,
): Raw {
  const days = occurrenceDays(batch);
  const cookedInView = batch.startDate >= rangeStart;
  const finishesInView = batch.endDate <= rangeEnd;

  return html`<article class="batch-card" data-batch-id="${batch.id}">
    <div class="entry"><a href="/recipes/${batch.recipeId}?multiplier=${String(batch.multiplier)}">
      <span class="batch-head-main">
        ${recipeImage({ id: batch.recipeId, imageKey: batch.imageKey }, "thumb")}
        <span class="entry-title">${batch.title}</span>
      </span>
      ${cookedInView
        ? html`<span class="batch-start">Kokataan · ${formatMultiplier(batch.multiplier)}</span>`
        : html`<span class="batch-carried">Kokattu ${shortDate(batch.startDate)} · ${formatMultiplier(batch.multiplier)}</span>`}
    </a></div>
    <a class="batch-edit" href="/batches/${batch.id}" aria-label="Muokkaa: ${batch.title}"
      >Muokkaa</a
    >
    ${batch.legacyPortions === null
      ? ""
      : // #165 could not turn this batch's old portion count into a multiplier,
        // because its recipe never said what it makes. Rather than invent one it
        // sits at 1x and says so, with the number the household actually typed.
        html`<p class="batch-unconverted">
          Vanha annosmäärä ${batch.legacyPortions} — kerroin on nyt
          ${formatMultiplier(DEFAULT_MULTIPLIER)}, tarkista se.
        </p>`}
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
      : // Past the last day on screen, which since #250 is the end of the
        // fortnight rather than the end of a single week.
        html`<p class="batch-onward">jatkuu eteenpäin</p>`}
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
  const recipes = await plannableRecipeSummaries(env.DB, member.householdId, "");
  return page(batch.title, batchActions(batch, null, recipes, member.householdId), "week", member);
}

function batchActions(
  batch: PlannedBatch,
  refusal: BatchRefusal | null,
  recipes: RecipeSummary[],
  householdId: number,
): Raw {
  // On a refused multiplier the box holds what was typed, not what is stored;
  // otherwise — including when it was the day that was refused — it holds the
  // batch's own multiplier so the number on screen is the truth. The day box
  // works the same way round: a refused move hands back the date that was
  // asked for, because that is the thing the member has to look at and fix.
  const typedMultiplier = refusal?.multiplier ?? null;
  const typed = typedMultiplier ??
    formatMultiplier(batch.multiplier).slice(0, -1);
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
      <a class="button" href="/recipes/${batch.recipeId}?multiplier=${String(batch.multiplier)}"
        >Avaa resepti</a
      >
    </p>

    <form method="post" action="/batches/${batch.id}/day" class="stacked">
      <input type="hidden" name="instanceKey" value="${batch.instanceKey}" />
      <label for="batchDate">Päivä</label>
      <div class="control-row">
        <input type="date" id="batchDate" name="date" value="${refusal?.date ?? batch.startDate}" required />
        <button type="submit">Siirrä</button>
      </div>
      ${batch.startDate === batch.endDate
        ? ""
        : html`<p class="meta">Koko erä siirtyy, myös sen jatkopäivät.</p>`}
    </form>

    <form method="post" action="/batches/${batch.id}/recipe" class="stacked">
      <input type="hidden" name="instanceKey" value="${batch.instanceKey}" />
      <label for="recipeId">Resepti koko erälle</label>
      <div class="control-row">
        <select id="recipeId" name="recipeId">
          ${recipes.map(
            (recipe) => html`<option value="${recipe.id}" ${recipe.id === batch.recipeId ? rawSelected : ""}>${recipe.householdId === householdId ? recipe.title : `${recipe.title} (${recipe.householdName})`}</option>`,
          )}
        </select>
        <button type="submit">Vaihda</button>
      </div>
    </form>

    <form method="post" action="/batches/${batch.id}/multiplier" class="stacked">
      <input type="hidden" name="instanceKey" value="${batch.instanceKey}" />
      <p class="preference-label" id="batchMultiplierLabel">Koko erän kerroin</p>
      ${multiplierField({
        current: typedMultiplier === null ? batch.multiplier : null,
        typed,
        label: "Koko erän kerroin",
        submit: "Tallenna",
      })}
    </form>

    <form method="post" action="/batches/${batch.id}/delete" class="stacked">
      <input type="hidden" name="instanceKey" value="${batch.instanceKey}" />
      <button type="submit" class="quiet">Poista erä ruokalistalta</button>
    </form>
    <p><a href="/?week=${mondayOf(batch.startDate)}">Takaisin viikkoon</a></p>`;
}

const rawSelected = raw("selected");

/**
 * What the member typed on a refused batch action, so the screen can hand it
 * back rather than replacing it with what is stored (the repo's screen-refusal
 * rule). Each field is null when that action was not the one refused.
 */
interface BatchRefusal {
  message: string;
  multiplier: string | null;
  date: string | null;
}

function batchNotFound(member: Member): Response {
  return page(
    "Ei löytynyt",
    html`<h1>Ei löytynyt</h1><p class="empty">Tätä ruokaerää ei ole ruokalistalla.</p><p><a href="/">Takaisin viikkoon</a></p>`,
    "week",
    member,
    404,
  );
}

/**
 * `GET /picker` — choosing what to cook, which is browsing recipes (#307).
 *
 * The same component the recipe screen lists through, so the search, the
 * category chips and the order are the ones the household already knows; what
 * this screen adds is the multiplier and the button that plans the batch. The
 * day and the meal ride along in `carried`, so no chip loses them.
 */
export async function pickerScreen(
  { env, url }: RouteContext,
  member: Member,
): Promise<Response> {
  const date = url.searchParams.get("date") ?? "";
  const slot = url.searchParams.get("slot") ?? "";
  if (!isDate(date) || !isSlot(slot)) {
    return page(
      "Ei löytynyt",
      html`<h1>Ei löytynyt</h1><p class="empty">Tuntematon päivä tai ateria.</p>`,
      "week",
      member,
      404,
    );
  }
  const vocabulary = await loadVocabulary(env.DB);
  const state = browseStateFrom(vocabulary, url.searchParams);
  const [recipes, history] = await Promise.all([
    plannableRecipeSummaries(env.DB, member.householdId, state.query),
    cookHistory(env.DB, member.householdId),
  ]);
  // How much of a recipe this household cooks, which is not what the recipe says
  // and is not what its publisher cooks it at either (#143).
  const preferred = await preferredMultipliers(
    env.DB,
    member.householdId,
    recipes.map((recipe) => recipe.id),
  );
  return page(
    "Valitse resepti",
    html`<h1>${SLOT_NAMES[slot]} ${shortDate(date)}</h1>
      ${recipeBrowser(
        { path: "/picker", carried: { date, slot } },
        {
          state,
          vocabulary,
          matching: recipes,
          history,
          viewerHouseholdId: member.householdId,
          emptyAll: "Reseptejä ei ole vielä yhtään.",
          listClass: "pick",
          row: (recipe, card) => html`<form
            method="post"
            action="/batches"
            class="inline"
          >
            <input type="hidden" name="date" value="${date}" />
            <input type="hidden" name="slot" value="${slot}" />
            <input type="hidden" name="recipeId" value="${recipe.id}" />
            <span class="pick-title">${card}</span>
            ${multiplierPicker(preferred.get(recipe.id) ?? DEFAULT_MULTIPLIER)}
            <button type="submit">Lisää</button>
          </form>`,
        },
      )}
      <datalist id="multiplierChoices">
        ${MULTIPLIER_CHOICES.map(
          (choice) => html`<option value="${formatMultiplier(choice)}"></option>`,
        )}
      </datalist>
      <p><a href="/?week=${mondayOf(date)}">Takaisin viikkoon</a></p>`,
    "week",
    member,
  );
}

/**
 * The multiplier a recipe gets added to the week at.
 *
 * One compact field rather than the chip row the batch screen offers: the
 * picker is a list of every plannable recipe, and four buttons on each row
 * would bury the one thing that list is for. A datalist still offers the four
 * common values while leaving any other positive multiplier typeable.
 */
function multiplierPicker(current: number): Raw {
  return html`<input
    name="multiplier"
    class="pick-multiplier"
    inputmode="decimal"
    list="multiplierChoices"
    value="${formatMultiplier(current)}"
    aria-label="Kerroin"
    size="4"
    required
  />`;
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
      multiplier: parseMultiplier(String(form.get("multiplier") ?? "")) ?? Number.NaN,
    });
  } catch (error) {
    if (!(error instanceof MenuRefused)) throw error;
    return refused(member, error.message, isDate(date) ? date : today());
  }
  return backToWeek(date);
}

/**
 * `POST /batches/:id/multiplier` — how much of the recipe this cooking makes.
 *
 * A tapped chip arrives as `preset`, a typed value as `multiplier`, and the
 * chip wins where both are present: pressing 2× means 2×, whatever is left in
 * the box beside it.
 */
export async function changeBatchMultiplierForm(
  { env, request, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const form = await request.formData();
  const batch = await findPlannedBatch(env.DB, member.householdId, Number(params["id"]));
  const instanceKey = String(form.get("instanceKey") ?? "");
  if (batch === null || batch.instanceKey !== instanceKey) return batchNotFound(member);
  const preset = String(form.get("preset") ?? "").trim();
  const chosen = preset === "" ? String(form.get("multiplier") ?? "").trim() : preset;
  try {
    const changed = await changeMultiplier(
      env.DB,
      member,
      batch.id,
      instanceKey,
      parseMultiplier(chosen) ?? Number.NaN,
    );
    if (!changed) return batchNotFound(member);
  } catch (error) {
    if (!(error instanceof MenuRefused)) throw error;
    const recipes = await plannableRecipeSummaries(env.DB, member.householdId, "");
    return page(
      batch.title,
      batchActions(batch, {
        message: error.message,
        multiplier: chosen,
        date: null,
      }, recipes, member.householdId),
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
  const instanceKey = String(form.get("instanceKey") ?? "");
  if (batch === null || batch.instanceKey !== instanceKey) return batchNotFound(member);
  try {
    const changed = await changeRecipe(
      env.DB,
      member,
      batch.id,
      instanceKey,
      Number(form.get("recipeId")),
    );
    if (!changed) return batchNotFound(member);
  } catch (error) {
    if (!(error instanceof MenuRefused)) throw error;
    return refused(member, error.message, batch.startDate);
  }
  return new Response(null, {
    status: 303,
    headers: { Location: `/batches/${batch.id}` },
  });
}

/**
 * `POST /batches/:id/day` — the same cooking, another day (#309).
 *
 * Landing back on the week the batch moved *to* is the point of the move, so
 * the redirect follows the dish rather than returning to where it came from.
 */
export async function moveBatchDayForm(
  { env, request, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const form = await request.formData();
  const batch = await findPlannedBatch(env.DB, member.householdId, Number(params["id"]));
  const instanceKey = String(form.get("instanceKey") ?? "");
  if (batch === null || batch.instanceKey !== instanceKey) return batchNotFound(member);
  const date = String(form.get("date") ?? "");
  try {
    const moved = await moveBatchTo(env.DB, member, batch.id, instanceKey, date);
    if (!moved) return batchNotFound(member);
  } catch (error) {
    if (!(error instanceof MenuRefused)) throw error;
    const recipes = await plannableRecipeSummaries(env.DB, member.householdId, "");
    return page(
      batch.title,
      batchActions(
        batch,
        // The date that was asked for, not the one the batch still sits on.
        { message: error.message, multiplier: null, date: isDate(date) ? date : null },
        recipes,
        member.householdId,
      ),
      "week",
      member,
      400,
    );
  }
  return backToWeek(date);
}

export async function removeBatchForm(
  { env, request, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const form = await request.formData();
  const batch = await findPlannedBatch(env.DB, member.householdId, Number(params["id"]));
  const instanceKey = String(form.get("instanceKey") ?? "");
  if (batch === null || batch.instanceKey !== instanceKey) return batchNotFound(member);
  const removed = await removePlannedBatch(env.DB, member, batch.id, instanceKey);
  if (!removed) return batchNotFound(member);
  return backToWeek(batch.startDate);
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
