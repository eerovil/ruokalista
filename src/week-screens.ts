import {
  addDays,
  dayName,
  isDate,
  mondayOf,
  shortDate,
  today,
  weekFrom,
} from "./dates.ts";
import { html, page, type Raw } from "./html.ts";
import type { Member } from "./members.ts";
import {
  addMealEntry,
  changePortions,
  DEFAULT_PORTIONS,
  findMealEntry,
  isSlot,
  menuBetween,
  MenuRefused,
  removeMealEntry,
  SLOTS,
  type MealEntry,
  type Slot,
} from "./menu.ts";
import { recipeSummaries } from "./recipes.ts";
import type { RouteContext } from "./router.ts";

/**
 * The week: the home screen and the point of the app. Seven days down the page,
 * each with its lunch and dinner slot.
 *
 * Empty slots are visible and tappable — they are the invitation.
 */

const SLOT_NAMES: Record<Slot, string> = {
  lunch: "Lounas",
  dinner: "Päivällinen",
};

/** `GET /` */
export async function weekScreen(
  { env, url }: RouteContext,
  member: Member,
): Promise<Response> {
  const asked = url.searchParams.get("week") ?? "";
  const monday = mondayOf(isDate(asked) ? asked : today());
  const days = weekFrom(monday);

  const entries = await menuBetween(
    env.DB,
    member.householdId,
    monday,
    days[6]!,
  );

  const now = today();

  return page(
    "Viikko",
    html`<h1>Viikko</h1>
      <nav class="weeks">
        <a href="/?week=${addDays(monday, -7)}" rel="prev">← Edellinen</a>
        <a href="/">Tämä viikko</a>
        <a href="/?week=${addDays(monday, 7)}" rel="next">Seuraava →</a>
      </nav>

      ${days.map((date) => dayCard(date, entries, date === now))}`,
    "week",
  );
}

function dayCard(date: string, entries: MealEntry[], isToday: boolean): Raw {
  return html`<section class="${isToday ? "day is-today" : "day"}">
    <h2>${dayName(date)} <span class="meta">${shortDate(date)}</span></h2>
    ${SLOTS.map((slot) =>
      slotBlock(
        date,
        slot,
        entries.filter((entry) => entry.date === date && entry.slot === slot),
      ),
    )}
  </section>`;
}

function slotBlock(date: string, slot: Slot, entries: MealEntry[]): Raw {
  return html`<div class="slot">
    <h3>${SLOT_NAMES[slot]}</h3>
    ${entries.length === 0
      ? html`<a class="empty-slot" href="/picker?date=${date}&slot=${slot}">
          + Lisää ruoka
        </a>`
      : html`<ul class="entries">
            ${entries.map(entryRow)}
          </ul>
          <a class="add-more" href="/picker?date=${date}&slot=${slot}">
            + Lisää toinen
          </a>`}
  </div>`;
}

/**
 * A planned meal, as it reads while scanning: the dish and what it is cooked
 * for. Everything you can *do* to it lives one tap away, on its own screen —
 * a week of editable inputs and delete buttons reads like an admin form, not
 * like the household's plan.
 */
function entryRow(entry: MealEntry): Raw {
  return html`<li class="entry">
    <a href="/meal-entries/${entry.id}">
      <span class="entry-title">${entry.title}</span>
      <span class="entry-portions">${entry.portions} annosta</span>
    </a>
  </li>`;
}

/** `GET /meal-entries/:id` — the focused surface for one planned meal. */
export async function mealEntryScreen(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const entry = await findMealEntry(
    env.DB,
    member.householdId,
    Number(params["id"]),
  );
  if (entry === null) return entryNotFound();

  return page(entry.title, entryActions(entry, null), "week");
}

/**
 * `portions` is the raw submitted text when a change was refused, not the
 * stored count — an invalid number is precisely the value that needs to be seen
 * and corrected.
 */
function entryActions(
  entry: MealEntry,
  refusal: { message: string; portions: string } | null,
): Raw {
  const error = refusal?.message ?? null;
  const portions = refusal?.portions ?? String(entry.portions);

  return html`<p class="meta entry-when">
      ${dayName(entry.date)} ${shortDate(entry.date)} ·
      ${SLOT_NAMES[entry.slot]}
    </p>
    <h1>${entry.title}</h1>

    ${error === null ? "" : html`<p class="refused">${error}</p>`}

    <!-- The meal's portion count travels with the link, so the recipe opens at
         the amounts this meal actually needs. -->
    <p>
      <a
        class="button"
        href="/recipes/${entry.recipeId}?portions=${entry.portions}"
        >Avaa resepti</a
      >
    </p>

    <form method="post" action="/meal-entries/${entry.id}/portions" class="stacked">
      <label for="portions">Annoksia</label>
      <div class="portions-row">
        <input
          id="portions"
          name="portions"
          inputmode="numeric"
          value="${portions}"
        />
        <button type="submit">Tallenna</button>
      </div>
    </form>

    <form method="post" action="/meal-entries/${entry.id}/delete" class="stacked">
      <button type="submit" class="quiet">Poista ruokalistalta</button>
    </form>

    <p><a href="/?week=${mondayOf(entry.date)}">Takaisin viikkoon</a></p>`;
}

function entryNotFound(): Response {
  return page(
    "Ei löytynyt",
    html`<h1>Ei löytynyt</h1>
      <p class="empty">Tätä ateriaa ei ole ruokalistalla.</p>
      <p><a href="/">Takaisin viikkoon</a></p>`,
    "week",
    404,
  );
}

/** `GET /picker?date=&slot=` — reached from a slot. */
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
      html`<h1>Ei löytynyt</h1>
        <p class="empty">Tuntematon päivä tai ateria.</p>`,
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
        <input
          type="search"
          name="q"
          value="${query}"
          placeholder="Hae nimellä"
          aria-label="Hae nimellä"
        />
        <button type="submit">Hae</button>
      </form>

      ${recipes.length === 0
        ? html`<p class="empty">
            ${query.trim() === ""
              ? "Reseptejä ei ole vielä yhtään."
              : "Haku ei löytänyt yhtään reseptiä."}
          </p>`
        : html`<ul class="pick">
            ${recipes.map(
              (recipe) => html`<li>
                <form method="post" action="/meal-entries" class="inline">
                  <input type="hidden" name="date" value="${date}" />
                  <input type="hidden" name="slot" value="${slot}" />
                  <input type="hidden" name="recipeId" value="${recipe.id}" />
                  <span class="pick-title">${recipe.title}</span>
                  <input
                    name="portions"
                    inputmode="numeric"
                    value="${recipe.yieldPortions ?? DEFAULT_PORTIONS}"
                    aria-label="Annoksia"
                    size="2"
                  />
                  <button type="submit">Lisää</button>
                </form>
              </li>`,
            )}
          </ul>`}

      <p><a href="/?week=${mondayOf(date)}">Takaisin viikkoon</a></p>`,
    "week",
  );
}

// ------------------------------------------------------- the form handlers

/** `POST /meal-entries` */
export async function addEntryForm(
  { env, request }: RouteContext,
  member: Member,
): Promise<Response> {
  const form = await request.formData();
  const date = String(form.get("date") ?? "");
  const slot = String(form.get("slot") ?? "");

  try {
    await addMealEntry(env.DB, member, {
      date,
      slot,
      recipeId: Number(form.get("recipeId")),
      portions: Number(form.get("portions")),
    });
  } catch (error) {
    if (!(error instanceof MenuRefused)) throw error;
    return refused(error.message, isDate(date) ? date : today());
  }

  return backToWeek(date);
}

/**
 * `POST /meal-entries/:id/portions` — a form cannot send PATCH.
 *
 * Which week to come back to is the entry's own, read from the row rather than
 * carried in a hidden field: the entry is the only thing that knows, and a
 * hidden field is one more thing a submission can arrive without.
 */
export async function changePortionsForm(
  { env, request, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const form = await request.formData();
  const entry = await findMealEntry(
    env.DB,
    member.householdId,
    Number(params["id"]),
  );
  if (entry === null) return entryNotFound();

  try {
    await changePortions(env.DB, member, entry.id, Number(form.get("portions")));
  } catch (error) {
    if (!(error instanceof MenuRefused)) throw error;
    // Back to the surface they were on, with the reason — not a dead end.
    return page(
      entry.title,
      entryActions(entry, {
        message: error.message,
        portions: String(form.get("portions") ?? ""),
      }),
      "week",
      400,
    );
  }

  return backToWeek(entry.date);
}

/** `POST /meal-entries/:id/delete` */
export async function removeEntryForm(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const entry = await findMealEntry(
    env.DB,
    member.householdId,
    Number(params["id"]),
  );
  if (entry === null) return entryNotFound();

  await removeMealEntry(env.DB, member, entry.id);
  return backToWeek(entry.date);
}

function backToWeek(date: string): Response {
  const week = mondayOf(isDate(date) ? date : today());
  return new Response(null, {
    status: 303,
    headers: { Location: `/?week=${week}` },
  });
}

function refused(message: string, date: string): Response {
  return page(
    "Ei onnistunut",
    html`<h1>Ei onnistunut</h1>
      <p class="refused">${message}</p>
      <p><a href="/?week=${mondayOf(date)}">Takaisin viikkoon</a></p>`,
    "week",
    400,
  );
}
