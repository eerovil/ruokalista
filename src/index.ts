import {
  addDays,
  addMealEntry,
  buildWeek,
  deleteMealEntry,
  isoDate,
  loadWeek,
  mondayOf,
  parseIsoDate,
  updateMealEntryPortions,
  type MealEntryRow
} from "./week";
import { formatIngredientLine, getRecipe, listRecipes } from "./recipes";

interface Env {
  DB: D1Database;
  DEV_MEMBER_ID?: string;
}

interface MemberRow {
  id: number;
  household_id: number;
  display_name: string;
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="fi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Ruokalista</title>
  <style>
    :root { font-family: system-ui, sans-serif; color: #1d1d1f; background: #f6f6f2; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    a { color: inherit; }
    main { width: min(44rem, 100%); margin: 0 auto; padding: 1rem; }
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
    h1 { margin: .5rem 0 1rem; font-size: 1.8rem; }
    h2 { font-size: 1.15rem; }
    .muted { color: #666; }
    .top-nav { display: flex; gap: .8rem; margin: -.25rem 0 1rem; font-size: .95rem; }
    .week-nav { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: .75rem; margin-bottom: 1rem; }
    .week-nav a, .button { text-decoration: none; padding: .65rem .8rem; border: 1px solid #d3d3cc; border-radius: .65rem; background: white; }
    .week-nav a:last-child { text-align: right; }
    .day, .card, .notice { background: white; border: 1px solid #deded7; border-radius: .8rem; margin: .75rem 0; overflow: hidden; }
    .day h2 { margin: 0; padding: .8rem 1rem; font-size: 1rem; background: #efefe9; }
    .slot { display: grid; grid-template-columns: 5rem 1fr; gap: .7rem; padding: .8rem 1rem; border-top: 1px solid #ecece6; }
    .slot-name { font-size: .85rem; font-weight: 700; color: #555; padding-top: .15rem; }
    .meal { display: grid; grid-template-columns: 1fr auto; gap: .4rem .7rem; align-items: center; }
    .meal + .meal { margin-top: .7rem; padding-top: .7rem; border-top: 1px solid #ecece6; }
    .meal-actions { grid-column: 1 / -1; display: flex; gap: .4rem; align-items: center; }
    .meal-actions form { display: flex; gap: .35rem; align-items: center; margin: 0; }
    .meal-actions input[type="number"] { width: 5rem; padding: .45rem .5rem; }
    .meal-actions button { padding: .45rem .6rem; }
    .portions { white-space: nowrap; color: #666; }
    .empty { color: #888; text-decoration: none; display: block; min-height: 1.5rem; }
    .notice, .card { padding: 1rem; }
    .recipe-list { list-style: none; padding: 0; margin: 0; }
    .recipe-list li { padding: .85rem 0; border-top: 1px solid #ecece6; }
    .recipe-list li:first-child { border-top: 0; }
    .recipe-list a { font-weight: 650; }
    .meta { color: #666; font-size: .86rem; margin-top: .2rem; }
    .search, .stack-form { display: flex; gap: .5rem; margin: .7rem 0 1rem; }
    .stack-form { flex-direction: column; align-items: stretch; }
    input[type="search"], input[type="number"] { min-width: 0; width: 100%; padding: .7rem .8rem; border: 1px solid #c9c9c2; border-radius: .6rem; background: white; font: inherit; }
    button { padding: .7rem .9rem; border: 1px solid #c9c9c2; border-radius: .6rem; background: #efefe9; font: inherit; cursor: pointer; }
    .ingredients { list-style: none; padding: 0; }
    .ingredients li { margin: .55rem 0; }
    details { color: #666; font-size: .85rem; margin-top: .15rem; }
    .steps li { margin: .6rem 0; padding-left: .25rem; }
    pre.source { white-space: pre-wrap; overflow-wrap: anywhere; background: #f1f1ec; padding: .8rem; border-radius: .6rem; font: inherit; font-size: .9rem; }
  </style>
</head>
<body>
  <main>${body}</main>
</body>
</html>`;
}

function appHeader(member: MemberRow): string {
  return `
    <header>
      <h1>Ruokalista</h1>
      <span class="muted">${escapeHtml(member.display_name)}</span>
    </header>
    <nav class="top-nav">
      <a href="/">Viikko</a>
      <a href="/recipes">Reseptit</a>
    </nav>`;
}

function weekHref(date: string): string {
  const parsed = parseIsoDate(date);
  return parsed ? `/?week=${isoDate(mondayOf(parsed))}` : "/";
}

function renderMeals(entries: MealEntryRow[], date: string, slot: "lunch" | "dinner"): string {
  const addLink = `<a class="empty" href="/recipes/pick?date=${date}&slot=${slot}">+ Lisää ruoka</a>`;
  if (entries.length === 0) return addLink;

  return entries.map((entry) => `
    <div class="meal">
      <a href="/recipes/${entry.recipe_id}">${escapeHtml(entry.recipe_title)}</a>
      <span class="portions">${entry.portions} ann.</span>
      <div class="meal-actions">
        <form method="post" action="/meal-entries/${entry.id}/portions">
          <input type="hidden" name="return_to" value="${weekHref(entry.date)}">
          <input type="number" name="portions" min="1" step="1" required value="${entry.portions}" aria-label="Annosmäärä">
          <button type="submit">Päivitä</button>
        </form>
        <form method="post" action="/meal-entries/${entry.id}/delete">
          <input type="hidden" name="return_to" value="${weekHref(entry.date)}">
          <button type="submit">Poista</button>
        </form>
      </div>
    </div>`).join("") + `<div style="margin-top:.65rem">${addLink}</div>`;
}

async function resolveDevMember(env: Env): Promise<MemberRow | null> {
  if (!env.DEV_MEMBER_ID || !/^\d+$/.test(env.DEV_MEMBER_ID)) return null;
  return env.DB.prepare(`
    SELECT id, household_id, display_name
    FROM member
    WHERE id = ?
  `).bind(Number(env.DEV_MEMBER_ID)).first<MemberRow>();
}

async function renderWeek(request: Request, env: Env, member: MemberRow): Promise<Response> {
  const url = new URL(request.url);
  const requested = parseIsoDate(url.searchParams.get("week"));
  const today = new Date();
  const start = mondayOf(requested ?? today);
  const entries = await loadWeek(env.DB, member.household_id, start);
  const days = buildWeek(start, entries);
  const previous = isoDate(addDays(start, -7));
  const next = isoDate(addDays(start, 7));
  const end = addDays(start, 6);

  const dayCards = days.map((day) => `
    <section class="day">
      <h2>${escapeHtml(day.label)}</h2>
      <div class="slot">
        <div class="slot-name">Lounas</div>
        <div>${renderMeals(day.lunch, day.date, "lunch")}</div>
      </div>
      <div class="slot">
        <div class="slot-name">Päivällinen</div>
        <div>${renderMeals(day.dinner, day.date, "dinner")}</div>
      </div>
    </section>`).join("");

  return html(shell("Viikko", `
    ${appHeader(member)}
    <nav class="week-nav" aria-label="Vaihda viikkoa">
      <a href="/?week=${previous}">← Edellinen</a>
      <strong>${start.getUTCDate()}.${start.getUTCMonth() + 1}.–${end.getUTCDate()}.${end.getUTCMonth() + 1}.${end.getUTCFullYear()}</strong>
      <a href="/?week=${next}">Seuraava →</a>
    </nav>
    ${dayCards}
  `));
}

async function renderRecipeList(request: Request, env: Env, member: MemberRow): Promise<Response> {
  const url = new URL(request.url);
  const search = url.searchParams.get("q") ?? "";
  const recipes = await listRecipes(env.DB, member.household_id, search);
  const rows = recipes.length === 0
    ? `<p class="muted">${search ? "Hakua vastaavia reseptejä ei löytynyt." : "Reseptejä ei ole vielä."}</p>`
    : `<ul class="recipe-list">${recipes.map((recipe) => `
        <li>
          <a href="/recipes/${recipe.id}">${escapeHtml(recipe.title)}</a>
          <div class="meta">${recipe.yield_portions === null ? "Annosmäärä ei tiedossa" : `${recipe.yield_portions} annosta`} · lisäsi ${escapeHtml(recipe.created_by_name)}</div>
        </li>`).join("")}</ul>`;

  return html(shell("Reseptit", `
    ${appHeader(member)}
    <h2>Reseptit</h2>
    <form class="search" method="get" action="/recipes">
      <input type="search" name="q" value="${escapeHtml(search)}" placeholder="Hae nimellä" aria-label="Hae reseptejä">
      <button type="submit">Hae</button>
    </form>
    <section class="card">${rows}</section>
  `));
}

async function renderRecipePicker(request: Request, env: Env, member: MemberRow): Promise<Response> {
  const url = new URL(request.url);
  const dateValue = url.searchParams.get("date");
  const date = parseIsoDate(dateValue);
  const slot = url.searchParams.get("slot");
  if (!date || (slot !== "lunch" && slot !== "dinner")) {
    return html(shell("Virhe", `${appHeader(member)}<div class="notice">Päivä tai ateria-aika puuttuu.</div>`), 400);
  }

  const dateText = isoDate(date);
  const search = url.searchParams.get("q") ?? "";
  const selectedRecipeId = Number(url.searchParams.get("recipe"));
  const selected = Number.isInteger(selectedRecipeId) && selectedRecipeId > 0
    ? await getRecipe(env.DB, member.household_id, selectedRecipeId)
    : null;

  if (selected) {
    const defaultPortions = selected.recipe.yield_portions;
    return html(shell("Lisää ruoka", `
      ${appHeader(member)}
      <p><a href="/recipes/pick?date=${dateText}&slot=${slot}">← Valitse toinen resepti</a></p>
      <h2>${escapeHtml(selected.recipe.title)}</h2>
      <section class="card">
        <form class="stack-form" method="post" action="/meal-entries">
          <input type="hidden" name="date" value="${dateText}">
          <input type="hidden" name="slot" value="${slot}">
          <input type="hidden" name="recipe_id" value="${selected.recipe.id}">
          <label>Annosmäärä
            <input type="number" name="portions" min="1" step="1" required ${defaultPortions === null ? "" : `value="${defaultPortions}"`}>
          </label>
          ${defaultPortions === null ? `<p class="muted">Reseptillä ei ole annosmäärää. Syötä määrä ennen lisäämistä.</p>` : ""}
          <button type="submit">Lisää ${slot === "lunch" ? "lounaalle" : "päivälliselle"}</button>
        </form>
      </section>
    `));
  }

  const recipes = await listRecipes(env.DB, member.household_id, search);
  const querySuffix = `date=${dateText}&slot=${slot}`;
  const rows = recipes.length === 0
    ? `<p class="muted">${search ? "Hakua vastaavia reseptejä ei löytynyt." : "Reseptejä ei ole vielä."}</p>`
    : `<ul class="recipe-list">${recipes.map((recipe) => `
        <li>
          <a href="/recipes/pick?${querySuffix}&recipe=${recipe.id}">${escapeHtml(recipe.title)}</a>
          <div class="meta">${recipe.yield_portions === null ? "Annosmäärä ei tiedossa" : `${recipe.yield_portions} annosta`}</div>
        </li>`).join("")}</ul>`;

  return html(shell("Valitse resepti", `
    ${appHeader(member)}
    <p><a href="${weekHref(dateText)}">← Takaisin viikkoon</a></p>
    <h2>Valitse resepti</h2>
    <p class="meta">${date.getUTCDate()}.${date.getUTCMonth() + 1}.${date.getUTCFullYear()} · ${slot === "lunch" ? "lounas" : "päivällinen"}</p>
    <form class="search" method="get" action="/recipes/pick">
      <input type="hidden" name="date" value="${dateText}">
      <input type="hidden" name="slot" value="${slot}">
      <input type="search" name="q" value="${escapeHtml(search)}" placeholder="Hae nimellä" aria-label="Hae reseptejä">
      <button type="submit">Hae</button>
    </form>
    <section class="card">${rows}</section>
  `));
}

async function renderRecipeDetail(env: Env, member: MemberRow, recipeId: number): Promise<Response> {
  const detail = await getRecipe(env.DB, member.household_id, recipeId);
  if (!detail) return html(shell("404", `${appHeader(member)}<h2>Reseptiä ei löytynyt</h2>`), 404);

  const { recipe, lines, steps } = detail;
  const ingredientHtml = lines.length === 0
    ? `<p class="muted">Ei ainesosia.</p>`
    : `<ul class="ingredients">${lines.map((line) => `
        <li>
          ${escapeHtml(formatIngredientLine(line))}
          <details><summary>Lähdeteksti</summary>${escapeHtml(line.source_line)}</details>
        </li>`).join("")}</ul>`;
  const stepHtml = steps.length === 0
    ? `<p class="muted">Ei työvaiheita.</p>`
    : `<ol class="steps">${steps.map((step) => `<li>${escapeHtml(step.text)}</li>`).join("")}</ol>`;

  return html(shell(recipe.title, `
    ${appHeader(member)}
    <p><a href="/recipes">← Kaikki reseptit</a></p>
    <h2>${escapeHtml(recipe.title)}</h2>
    <p class="meta">${recipe.yield_portions === null ? "Annosmäärä ei tiedossa" : `${recipe.yield_portions} annosta`} · lisäsi ${escapeHtml(recipe.created_by_name)}</p>
    <section class="card">
      <h3>Ainekset</h3>
      ${ingredientHtml}
      <h3>Ohje</h3>
      ${stepHtml}
    </section>
    <section class="card">
      <details>
        <summary>Alkuperäinen lähdeteksti</summary>
        <pre class="source">${escapeHtml(recipe.source_text)}</pre>
      </details>
    </section>
  `));
}

async function handleAddMealEntry(request: Request, env: Env, member: MemberRow): Promise<Response> {
  const form = await request.formData();
  const dateText = String(form.get("date") ?? "");
  const date = parseIsoDate(dateText);
  const slot = String(form.get("slot") ?? "");
  const recipeId = Number(form.get("recipe_id"));
  const portions = Number(form.get("portions"));

  if (!date || (slot !== "lunch" && slot !== "dinner") || !Number.isInteger(recipeId) || recipeId <= 0 || !Number.isInteger(portions) || portions <= 0) {
    return html(shell("Virhe", `${appHeader(member)}<div class="notice">Aterian tiedot eivät kelpaa.</div>`), 400);
  }

  const added = await addMealEntry(env.DB, member.household_id, member.id, isoDate(date), slot, recipeId, portions);
  if (!added) return html(shell("404", `${appHeader(member)}<div class="notice">Reseptiä ei löytynyt.</div>`), 404);
  return redirect(weekHref(isoDate(date)));
}

function safeReturnTo(value: FormDataEntryValue | null): string {
  const text = typeof value === "string" ? value : "";
  return /^\/\?week=\d{4}-\d{2}-\d{2}$/.test(text) ? text : "/";
}

async function handleUpdatePortions(request: Request, env: Env, member: MemberRow, mealEntryId: number): Promise<Response> {
  const form = await request.formData();
  const portions = Number(form.get("portions"));
  if (!Number.isInteger(portions) || portions <= 0) {
    return html(shell("Virhe", `${appHeader(member)}<div class="notice">Annosmäärän pitää olla positiivinen kokonaisluku.</div>`), 400);
  }
  const updated = await updateMealEntryPortions(env.DB, member.household_id, mealEntryId, portions);
  if (!updated) return html(shell("404", `${appHeader(member)}<div class="notice">Ateriaa ei löytynyt.</div>`), 404);
  return redirect(safeReturnTo(form.get("return_to")));
}

async function handleDeleteMealEntry(request: Request, env: Env, member: MemberRow, mealEntryId: number): Promise<Response> {
  const form = await request.formData();
  const deleted = await deleteMealEntry(env.DB, member.household_id, mealEntryId);
  if (!deleted) return html(shell("404", `${appHeader(member)}<div class="notice">Ateriaa ei löytynyt.</div>`), 404);
  return redirect(safeReturnTo(form.get("return_to")));
}

function unauthorized(): Response {
  return html(shell("Kirjaudu", `
    <h1>Ruokalista</h1>
    <div class="notice">
      <strong>Kirjautuminen ei ole vielä kytketty.</strong>
      <p class="muted">Kehityksessä sovellus avataan vain, kun DEV_MEMBER_ID osoittaa paikallisen D1-kannan jäseneen.</p>
    </div>
  `), 401);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      const result = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      return Response.json({ ok: result?.ok === 1 });
    }

    const member = await resolveDevMember(env);
    if (!member) return unauthorized();

    if (request.method === "GET" && url.pathname === "/") {
      return renderWeek(request, env, member);
    }

    if (request.method === "GET" && url.pathname === "/recipes") {
      return renderRecipeList(request, env, member);
    }

    if (request.method === "GET" && url.pathname === "/recipes/pick") {
      return renderRecipePicker(request, env, member);
    }

    const recipeMatch = request.method === "GET" ? url.pathname.match(/^\/recipes\/(\d+)$/) : null;
    if (recipeMatch) {
      return renderRecipeDetail(env, member, Number(recipeMatch[1]));
    }

    if (request.method === "POST" && url.pathname === "/meal-entries") {
      return handleAddMealEntry(request, env, member);
    }

    const portionsMatch = request.method === "POST" ? url.pathname.match(/^\/meal-entries\/(\d+)\/portions$/) : null;
    if (portionsMatch) {
      return handleUpdatePortions(request, env, member, Number(portionsMatch[1]));
    }

    const deleteMatch = request.method === "POST" ? url.pathname.match(/^\/meal-entries\/(\d+)\/delete$/) : null;
    if (deleteMatch) {
      return handleDeleteMealEntry(request, env, member, Number(deleteMatch[1]));
    }

    return html(shell("404", `${appHeader(member)}<h2>404</h2><p>Sivua ei löytynyt.</p>`), 404);
  }
} satisfies ExportedHandler<Env>;
