import { addDays, buildWeek, isoDate, loadWeek, mondayOf, parseIsoDate, type MealEntryRow } from "./week";

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
    .muted { color: #666; }
    .week-nav { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: .75rem; margin-bottom: 1rem; }
    .week-nav a { text-decoration: none; padding: .65rem .8rem; border: 1px solid #d3d3cc; border-radius: .65rem; background: white; }
    .week-nav a:last-child { text-align: right; }
    .week-nav strong { text-align: center; font-size: .9rem; }
    .day { background: white; border: 1px solid #deded7; border-radius: .8rem; margin: .75rem 0; overflow: hidden; }
    .day h2 { margin: 0; padding: .8rem 1rem; font-size: 1rem; background: #efefe9; }
    .slot { display: grid; grid-template-columns: 5rem 1fr; gap: .7rem; padding: .8rem 1rem; border-top: 1px solid #ecece6; }
    .slot-name { font-size: .85rem; font-weight: 700; color: #555; padding-top: .15rem; }
    .meal { display: flex; justify-content: space-between; gap: 1rem; }
    .meal + .meal { margin-top: .45rem; }
    .portions { white-space: nowrap; color: #666; }
    .empty { color: #888; text-decoration: none; display: block; min-height: 1.5rem; }
    .notice { background: white; border: 1px solid #deded7; border-radius: .8rem; padding: 1rem; }
  </style>
</head>
<body>
  <main>${body}</main>
</body>
</html>`;
}

function renderMeals(entries: MealEntryRow[], date: string, slot: "lunch" | "dinner"): string {
  if (entries.length === 0) {
    return `<a class="empty" href="/recipes/pick?date=${date}&slot=${slot}">+ Lisää ruoka</a>`;
  }

  return entries.map((entry) => `
    <div class="meal">
      <a href="/recipes/${entry.recipe_id}">${escapeHtml(entry.recipe_title)}</a>
      <span class="portions">${entry.portions} ann.</span>
    </div>`).join("");
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
    <header>
      <h1>Ruokalista</h1>
      <span class="muted">${escapeHtml(member.display_name)}</span>
    </header>
    <nav class="week-nav" aria-label="Vaihda viikkoa">
      <a href="/?week=${previous}">← Edellinen</a>
      <strong>${start.getUTCDate()}.${start.getUTCMonth() + 1}.–${end.getUTCDate()}.${end.getUTCMonth() + 1}.${end.getUTCFullYear()}</strong>
      <a href="/?week=${next}">Seuraava →</a>
    </nav>
    ${dayCards}
  `));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      const result = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      return Response.json({ ok: result?.ok === 1 });
    }

    const member = await resolveDevMember(env);

    if (url.pathname === "/") {
      if (!member) {
        return html(shell("Kirjaudu", `
          <h1>Ruokalista</h1>
          <div class="notice">
            <strong>Kirjautuminen ei ole vielä kytketty.</strong>
            <p class="muted">Kehityksessä viikkonäkymä avataan vain, kun DEV_MEMBER_ID osoittaa paikallisen D1-kannan jäseneen.</p>
          </div>
        `));
      }
      return renderWeek(request, env, member);
    }

    if (url.pathname === "/recipes/pick") {
      if (!member) return html(shell("Kirjaudu", "<h1>Kirjautuminen vaaditaan</h1>"), 401);
      return html(shell("Valitse resepti", `
        <h1>Valitse resepti</h1>
        <p class="muted">Reseptivalitsin rakennetaan seuraavaksi.</p>
        <p><a href="/">← Takaisin viikkoon</a></p>
      `));
    }

    return html(shell("404", "<h1>404</h1><p>Sivua ei löytynyt.</p>"), 404);
  }
} satisfies ExportedHandler<Env>;
