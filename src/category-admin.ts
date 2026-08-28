import { CATEGORY_STYLE, loadVocabulary, type Category } from "./categories.ts";
import { html, page, raw, type Raw } from "./html.ts";
import type { Member } from "./members.ts";
import type { RouteContext } from "./router.ts";

/**
 * Curating the category vocabulary, from the admin panel (issue #199).
 *
 * #196 kept the list in code so nobody could coin a category the households
 * sharing a recipe had never heard of. That reason survives here: this is still
 * **one** list, still not per household, and still nothing a member can add to
 * while saving a recipe. What changes is who may edit it and how fast — an
 * admin, from a screen, instead of a release. ADR-0013 records the swap.
 *
 * Four rules the screen is built on:
 *
 * - **The label is typed; the slug is derived and then permanent.** A slug is
 *   what `recipe_category` stores, so letting it change would be a data
 *   migration performed by a text field. Renaming the label is free precisely
 *   because it is not the identity.
 * - **A duplicate is refused, not merged.** Two rows meaning the same thing is
 *   the mess a free-text vocabulary would have been; merging two categories is
 *   a different feature and nobody has asked for it.
 * - **Removal says what it will do before it does it.** The confirmation names
 *   the recipes that carry the category and how many; only then does one batch
 *   take the category off them and delete it. Recipes are never deleted, and
 *   this is the only place a category leaves a recipe without somebody ticking
 *   a box.
 * - **Order is the admin's**, because the picker and the chip row draw in it,
 *   and what a household cooks decides what should be near the top.
 */

export class CategoryAdminRefused extends Error {}

/**
 * A ceiling, not a target. The number itself is arbitrary; what is not is that
 * the picker is a row of checkboxes on a phone and the filter is a chip row, so
 * a vocabulary nobody can scan stops being a vocabulary.
 */
const MAX_CATEGORIES = 24;

/** Long enough for `Pizza/piirakka`, short enough to stay on one chip. */
const MAX_LABEL = 30;

/** One category, with what curating it needs to know. */
export interface CategoryRow extends Category {
  position: number;
  /** How many recipes carry it, across every household. */
  recipes: number;
}

export async function categoryRows(db: D1Database): Promise<CategoryRow[]> {
  const { results } = await db
    .prepare(
      `SELECT category.slug, category.label, category.position,
              (SELECT count(*) FROM recipe_category
                WHERE recipe_category.category = category.slug) AS recipes
         FROM category
        ORDER BY category.position, category.slug`,
    )
    .all<CategoryRow>();
  return results;
}

/**
 * The ASCII slug a Finnish label becomes.
 *
 * `ä`, `ö` and `å` fold rather than disappear, so *Jälkiruoka* is `jalkiruoka`
 * and not `jlkiruoka`. Everything else that is not a letter or a digit becomes
 * a single hyphen, which is what turns *Pizza/piirakka* into `pizza-piirakka`.
 * A label of nothing but punctuation has no slug at all, and that is refused
 * rather than stored as an empty identifier.
 */
export function slugFor(label: string): string {
  return label
    .toLowerCase()
    .replace(/[äå]/g, "a")
    .replace(/ö/g, "o")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Add a category. The label is the member's; the slug is derived from it. */
export async function addCategory(
  db: D1Database,
  label: string,
): Promise<CategoryRow> {
  const trimmed = label.trim();
  if (trimmed === "") {
    throw new CategoryAdminRefused("Anna kategorialle nimi.");
  }
  if (trimmed.length > MAX_LABEL) {
    throw new CategoryAdminRefused(
      `Nimi saa olla enintään ${MAX_LABEL} merkkiä.`,
    );
  }

  const slug = slugFor(trimmed);
  if (slug === "") {
    throw new CategoryAdminRefused(
      "Nimessä pitää olla ainakin yksi kirjain tai numero.",
    );
  }

  const rows = await categoryRows(db);
  if (rows.length >= MAX_CATEGORIES) {
    throw new CategoryAdminRefused(
      `Kategorioita voi olla enintään ${MAX_CATEGORIES}.`,
    );
  }
  if (rows.some((row) => row.slug === slug)) {
    throw new CategoryAdminRefused(`Kategoria ${slug} on jo olemassa.`);
  }
  if (rows.some((row) => sameLabel(row.label, trimmed))) {
    throw new CategoryAdminRefused(`Kategoria ${trimmed} on jo olemassa.`);
  }

  const position = rows.reduce((last, row) => Math.max(last, row.position), 0) + 1;
  await db
    .prepare("INSERT INTO category (slug, label, position) VALUES (?, ?, ?)")
    .bind(slug, trimmed, position)
    .run();
  return { slug, label: trimmed, position, recipes: 0 };
}

/**
 * Rename a category. The slug does not move, so no recipe row is touched and
 * every list, filter and shared recipe says the new word immediately.
 */
export async function renameCategory(
  db: D1Database,
  slug: string,
  label: string,
): Promise<void> {
  const trimmed = label.trim();
  if (trimmed === "") {
    throw new CategoryAdminRefused("Anna kategorialle nimi.");
  }
  if (trimmed.length > MAX_LABEL) {
    throw new CategoryAdminRefused(
      `Nimi saa olla enintään ${MAX_LABEL} merkkiä.`,
    );
  }

  const rows = await categoryRows(db);
  const current = rows.find((row) => row.slug === slug);
  if (current === undefined) {
    throw new CategoryAdminRefused("Tuntematon kategoria.");
  }
  if (rows.some((row) => row.slug !== slug && sameLabel(row.label, trimmed))) {
    throw new CategoryAdminRefused(`Kategoria ${trimmed} on jo olemassa.`);
  }

  await db
    .prepare("UPDATE category SET label = ? WHERE slug = ?")
    .bind(trimmed, slug)
    .run();
}

/**
 * Move a category one place up or down.
 *
 * The two rows swap positions rather than everything below being renumbered:
 * two writes whatever the list's length, and a gap left by an earlier removal
 * cannot make a move do nothing.
 */
export async function moveCategory(
  db: D1Database,
  slug: string,
  direction: "up" | "down",
): Promise<void> {
  const rows = await categoryRows(db);
  const index = rows.findIndex((row) => row.slug === slug);
  if (index === -1) throw new CategoryAdminRefused("Tuntematon kategoria.");

  const other = rows[direction === "up" ? index - 1 : index + 1];
  // Already at the end it is being pushed towards. Not a refusal — the button
  // is not drawn there, so this is a stale form, and the answer is the list.
  if (other === undefined) return;

  const here = rows[index]!;
  await db.batch([
    db
      .prepare("UPDATE category SET position = ? WHERE slug = ?")
      .bind(other.position, here.slug),
    db
      .prepare("UPDATE category SET position = ? WHERE slug = ?")
      .bind(here.position, other.slug),
  ]);
}

/**
 * Remove a category, taking it off every recipe that carries it.
 *
 * One batch, so a failure halfway cannot leave recipes pointing at a category
 * that is gone. The confirmation screen has already said how many recipes this
 * is; the count is read again here rather than trusted from the form, because
 * somebody may have categorised another recipe in between.
 */
export async function deleteCategory(
  db: D1Database,
  slug: string,
): Promise<number> {
  const rows = await categoryRows(db);
  const row = rows.find((category) => category.slug === slug);
  if (row === undefined) throw new CategoryAdminRefused("Tuntematon kategoria.");

  const affected = await db
    .prepare("SELECT count(*) AS n FROM recipe_category WHERE category = ?")
    .bind(slug)
    .first<{ n: number }>();

  await db.batch([
    db.prepare("DELETE FROM recipe_category WHERE category = ?").bind(slug),
    db.prepare("DELETE FROM category WHERE slug = ?").bind(slug),
  ]);
  return affected?.n ?? 0;
}

/** Which recipes carry a category, by title, for the confirmation screen. */
export async function recipesInCategory(
  db: D1Database,
  slug: string,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT recipe.title
         FROM recipe_category
         JOIN recipe ON recipe.id = recipe_category.recipe_id
        WHERE recipe_category.category = ?
        ORDER BY recipe.title`,
    )
    .bind(slug)
    .all<{ title: string }>();
  return results.map((row) => row.title);
}

// ------------------------------------------------------------------ screens

/** `GET /admin/kategoriat` — the whole vocabulary, and what can be done to it. */
export async function categoryAdminScreen(
  { env }: RouteContext,
  member: Member,
): Promise<Response> {
  return listPage(env, member, null);
}

/** `POST /admin/kategoriat` — add, rename or move, by `action`. */
export async function categoryAdminForm(
  { env, request }: RouteContext,
  member: Member,
): Promise<Response> {
  const form = await request.formData();
  const action = String(form.get("action") ?? "");
  const slug = String(form.get("slug") ?? "");

  try {
    if (action === "add") {
      const added = await addCategory(env.DB, String(form.get("label") ?? ""));
      return listPage(env, member, {
        message: `Kategoria ${added.label} lisättiin.`,
        refused: false,
      });
    }
    if (action === "rename") {
      await renameCategory(env.DB, slug, String(form.get("label") ?? ""));
      return listPage(env, member, {
        message: "Nimi tallennettiin.",
        refused: false,
      });
    }
    if (action === "up" || action === "down") {
      await moveCategory(env.DB, slug, action);
      return listPage(env, member, null);
    }
  } catch (error) {
    if (!(error instanceof CategoryAdminRefused)) throw error;
    return listPage(env, member, { message: error.message, refused: true });
  }

  return listPage(env, member, {
    message: "Tuntematon toiminto.",
    refused: true,
  });
}

/**
 * `GET /admin/kategoriat/:slug/poista` — what removing this would do.
 *
 * A screen of its own rather than a browser confirm: the point is the list of
 * recipes that would lose the category, and a dialog cannot show it.
 */
export async function categoryDeleteScreen(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const slug = String(params["slug"] ?? "");
  const rows = await categoryRows(env.DB);
  const row = rows.find((category) => category.slug === slug);
  if (row === undefined) return notFound(member);

  const titles = await recipesInCategory(env.DB, slug);

  return page(
    `Poista ${row.label}`,
    html`<h1>Poista kategoria ${row.label}</h1>
      ${titles.length === 0
        ? html`<p class="empty">
            Yksikään resepti ei ole tässä kategoriassa, joten poistaminen ei
            muuta yhtään reseptiä.
          </p>`
        : html`<p class="refused">
              Kategoria poistetaan
              ${titles.length === 1 ? "yhdeltä reseptiltä" : `${titles.length} reseptiltä`}.
              Reseptejä ei poisteta, mutta ne eivät enää löydy tästä
              kategoriasta.
            </p>
            <ul class="recipes">
              ${titles.map(
                (title) => html`<li>
                  <span class="recipes-text">${title}</span>
                </li>`,
              )}
            </ul>`}
      <form method="post" action="/admin/kategoriat/${row.slug}/poista">
        <button type="submit">Poista kategoria</button>
      </form>
      <p><a href="/admin/kategoriat">Peruuta</a></p>
      ${CATEGORY_ADMIN_STYLE}`,
    "week",
    member,
  );
}

/** `POST /admin/kategoriat/:slug/poista` */
export async function categoryDeleteForm(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const slug = String(params["slug"] ?? "");
  const rows = await categoryRows(env.DB);
  const row = rows.find((category) => category.slug === slug);
  if (row === undefined) return notFound(member);

  const detached = await deleteCategory(env.DB, slug);
  return listPage(env, member, {
    message: detached === 0
      ? `Kategoria ${row.label} poistettiin.`
      : `Kategoria ${row.label} poistettiin ${
        detached === 1 ? "yhdeltä reseptiltä" : `${detached} reseptiltä`
      }.`,
    refused: false,
  });
}

interface AdminNotice {
  message: string;
  refused: boolean;
}

async function listPage(
  env: RouteContext["env"],
  member: Member,
  notice: AdminNotice | null,
): Promise<Response> {
  const rows = await categoryRows(env.DB);
  return page(
    "Kategoriat",
    html`<h1>Kategoriat</h1>
      <p class="empty">
        Yksi lista kaikille talouksille. Nimen voi vaihtaa milloin tahansa —
        reseptit tallentavat tunnisteen, eivät nimeä.
      </p>
      ${noticeLine(notice)}
      ${rows.length === 0
        ? html`<p class="empty">
            Kategorioita ei ole yhtään. Reseptien kategoriavalinta ja
            kategoriasuodatin piiloutuvat, kunnes tässä on ainakin yksi.
          </p>`
        : html`<ul class="category-admin">
            ${rows.map((row, index) => categoryRow(row, index, rows.length))}
          </ul>`}
      <form method="post" action="/admin/kategoriat" class="stacked">
        <input type="hidden" name="action" value="add" />
        <label for="new-category">Uusi kategoria</label>
        <input
          id="new-category"
          name="label"
          value=""
          placeholder="Esimerkiksi Wokki"
          maxlength="${MAX_LABEL}"
        />
        <button type="submit">Lisää kategoria</button>
      </form>
      ${CATEGORY_STYLE} ${CATEGORY_ADMIN_STYLE}`,
    "week",
    member,
    notice?.refused === true ? 400 : 200,
  );
}

/**
 * One row: what it is called, how many recipes use it, and the three things
 * that can be done to it. Each is its own form, because a row with one text
 * field and four submit buttons is a row where Enter does something surprising.
 */
function categoryRow(row: CategoryRow, index: number, total: number): Raw {
  return html`<li>
    <form method="post" action="/admin/kategoriat" class="category-admin-name">
      <input type="hidden" name="action" value="rename" />
      <input type="hidden" name="slug" value="${row.slug}" />
      <input
        name="label"
        value="${row.label}"
        aria-label="Kategorian ${row.label} nimi"
        maxlength="${MAX_LABEL}"
      />
      <button type="submit">Tallenna</button>
    </form>
    <p class="meta">
      ${row.slug} ·
      ${row.recipes === 0
        ? "ei reseptejä"
        : row.recipes === 1
          ? "1 resepti"
          : `${row.recipes} reseptiä`}
    </p>
    <!-- A div rather than a p: a form inside a paragraph closes the paragraph
         before it, and the row's actions end up stacked full width. -->
    <div class="category-admin-actions">
      ${index === 0 ? "" : moveButton(row, "up", `Siirrä ${row.label} ylös`)}
      ${index === total - 1
        ? ""
        : moveButton(row, "down", `Siirrä ${row.label} alas`)}
      <a class="button" href="/admin/kategoriat/${row.slug}/poista">Poista</a>
    </div>
  </li>`;
}

function moveButton(
  row: CategoryRow,
  direction: "up" | "down",
  label: string,
): Raw {
  return html`<form method="post" action="/admin/kategoriat">
    <input type="hidden" name="action" value="${direction}" />
    <input type="hidden" name="slug" value="${row.slug}" />
    <button type="submit" aria-label="${label}">
      ${direction === "up" ? "↑" : "↓"}
    </button>
  </form>`;
}

function noticeLine(notice: AdminNotice | null): Raw {
  if (notice === null) return raw("");
  return notice.refused
    ? html`<p class="refused">${notice.message}</p>`
    : html`<p class="done">${notice.message}</p>`;
}

function notFound(member: Member): Response {
  return page(
    "Ei löytynyt",
    html`<h1>Ei löytynyt</h1>
      <p class="empty">Tätä kategoriaa ei ole.</p>`,
    "week",
    member,
    404,
  );
}

/** Two labels differ only by case or surrounding space is still a duplicate. */
function sameLabel(one: string, other: string): boolean {
  return one.trim().toLocaleLowerCase("fi") === other.trim().toLocaleLowerCase("fi");
}

const CATEGORY_ADMIN_STYLE = html`<style>
  /* The done rule lives in PUBLISH_STYLE, which is a recipe screen's
     stylesheet and not this one's. Repeated here rather than moved into the
     shell: the shell is what every screen pays for. */
  .done {
    padding: 0.7rem 0.8rem;
    margin: 0 0 1rem;
    color: var(--accent);
    font-size: 0.9rem;
    background: var(--surface);
    border: 1px solid var(--accent);
    border-radius: var(--radius);
  }
  .category-admin {
    padding: 0;
    margin: 0 0 1.5rem;
    list-style: none;
  }
  .category-admin li {
    padding: 0.6rem 0;
    border-bottom: 1px solid var(--edge);
  }
  .category-admin li:last-child {
    border-bottom: 0;
  }
  .category-admin-name {
    display: flex;
    gap: 0.5rem;
    margin: 0;
  }
  .category-admin-name input {
    flex: 1 1 auto;
    min-width: 0;
  }
  .category-admin-name button {
    flex: 0 0 auto;
  }
  .category-admin .meta {
    margin: 0.2rem 0 0.4rem;
  }
  .category-admin-actions {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    margin: 0;
  }
  .category-admin-actions form {
    margin: 0;
  }
  .category-admin-actions button,
  .category-admin-actions .button {
    padding: 0.3rem 0.8rem;
    font-size: 0.9rem;
    min-height: var(--tap-compact);
  }
  /* Removal is not the thing this screen is for, so it is not drawn as the
     screen's primary action. The confirmation behind it is the real guard. */
  .category-admin-actions .button {
    font-weight: 400;
    color: inherit;
    background: var(--surface);
    border-color: var(--edge);
  }
</style>`;
