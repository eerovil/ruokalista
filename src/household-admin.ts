import { adminNotFound } from "./auth.ts";
import { html, page, type Raw } from "./html.ts";
import {
  addMember,
  allHouseholds,
  createHousehold,
  findHousehold,
  HouseholdRefused,
  membersOfHousehold,
  removeMember,
  renameHousehold,
  updateMember,
  type Household,
  type HouseholdMember,
  type MemberInput,
} from "./households.ts";
import type { Member } from "./members.ts";
import type { RouteContext } from "./router.ts";

/**
 * `Householdit` — the admin tool #127 asked for, and the third row on `/admin`.
 *
 * Until now a household and its people existed only as SQL somebody ran against
 * production: the sign-in wall shows a stranger their Google `sub` and tells the
 * household to INSERT it by hand. This is that job, done in the app, by the one
 * member the app already distinguishes.
 *
 * It reads and writes across household boundaries on purpose, which nothing else
 * in the app does — see `src/households.ts` for why the exception is confined
 * there. Two things it deliberately cannot do, both from the issue: it cannot
 * move admin around, and it offers no "move to another household". A move is a
 * removal and an addition, which leaves two visible actions instead of one
 * silent reparenting.
 *
 * "Cannot move admin around" is more than leaving `is_admin` off the form.
 * Sign-in matches on `google_sub`, so repointing an admin's row at a different
 * Google account would hand that account admin, and deleting the row would take
 * admin away — neither of which is a form field, and both of which
 * `src/households.ts::adminRowGuard` refuses.
 *
 * Household deletion is out of scope, so there is no button for it.
 */

/**
 * Which form on the screen refused, so the message lands next to the fields the
 * operator was filling in and those fields keep what they typed. `problem()`
 * would answer a form post with raw JSON and lose the lot.
 */
interface Refusal {
  scope: string;
  message: string;
  values: Partial<MemberInput> & { name?: string };
}

/** `GET /admin/households` */
export async function householdListScreen(
  { env }: RouteContext,
  member: Member,
): Promise<Response> {
  return page(
    "Householdit",
    householdListBody(await allHouseholds(env.DB), null),
    "week",
    member,
  );
}

/** `POST /admin/households` — create one, then open it. */
export async function createHouseholdForm(
  { env, request }: RouteContext,
  member: Member,
): Promise<Response> {
  const form = await request.formData();
  const name = String(form.get("name") ?? "");

  let id: number;
  try {
    id = await createHousehold(env.DB, name);
  } catch (error) {
    if (!(error instanceof HouseholdRefused)) throw error;
    return page(
      "Householdit",
      householdListBody(await allHouseholds(env.DB), {
        scope: "create",
        message: error.message,
        values: { name },
      }),
      "week",
      member,
      400,
    );
  }

  return seeOther(`/admin/households/${id}`);
}

/** `GET /admin/households/:id` */
export async function householdScreen(
  { env, params }: RouteContext,
  member: Member,
): Promise<Response> {
  return renderHousehold(env.DB, member, Number(params["id"]), null, 200);
}

/** `POST /admin/households/:id/name` */
export async function renameHouseholdForm(
  ctx: RouteContext,
  member: Member,
): Promise<Response> {
  const form = await ctx.request.formData();
  const name = String(form.get("name") ?? "");
  const id = Number(ctx.params["id"]);

  return withRefusal(ctx, member, id, { scope: "name", values: { name } }, () =>
    renameHousehold(ctx.env.DB, id, name),
  );
}

/** `POST /admin/households/:id/members` */
export async function addMemberForm(
  ctx: RouteContext,
  member: Member,
): Promise<Response> {
  const input = await memberInput(ctx.request);
  const id = Number(ctx.params["id"]);

  return withRefusal(ctx, member, id, { scope: "add", values: input }, () =>
    addMember(ctx.env.DB, id, input),
  );
}

/** `POST /admin/households/:id/members/:memberId` */
export async function editMemberForm(
  ctx: RouteContext,
  member: Member,
): Promise<Response> {
  const input = await memberInput(ctx.request);
  const id = Number(ctx.params["id"]);
  const memberId = Number(ctx.params["memberId"]);

  return withRefusal(
    ctx,
    member,
    id,
    { scope: `member-${memberId}`, values: input },
    () => updateMember(ctx.env.DB, id, memberId, input),
  );
}

/** `POST /admin/households/:id/members/:memberId/delete` */
export async function removeMemberForm(
  ctx: RouteContext,
  member: Member,
): Promise<Response> {
  const id = Number(ctx.params["id"]);
  const memberId = Number(ctx.params["memberId"]);

  // No "not yourself" check here on purpose. `removeMember` refuses to delete
  // any admin's row, and only an admin can reach this route — so the caller's
  // own row is already covered, by a rule that also covers the other admin the
  // caller is not.
  return withRefusal(ctx, member, id, { scope: `member-${memberId}` }, () =>
    removeMember(ctx.env.DB, id, memberId),
  );
}

/**
 * Every write on the detail screen has the same shape: do it and come back to
 * the household, or re-render the household with the message beside the form
 * that refused.
 */
async function withRefusal(
  { env }: RouteContext,
  member: Member,
  householdId: number,
  refusal: { scope: string; values?: Refusal["values"] },
  write: () => Promise<unknown>,
): Promise<Response> {
  // A household the operator invented is not there, the same answer the rest of
  // the admin surface gives — checked before the write, not after it.
  if ((await findHousehold(env.DB, householdId)) === null) {
    return adminNotFound(member);
  }

  try {
    await write();
  } catch (error) {
    if (!(error instanceof HouseholdRefused)) throw error;
    return renderHousehold(
      env.DB,
      member,
      householdId,
      {
        scope: refusal.scope,
        message: error.message,
        values: refusal.values ?? {},
      },
      400,
    );
  }

  return seeOther(`/admin/households/${householdId}`);
}

async function renderHousehold(
  db: D1Database,
  member: Member,
  householdId: number,
  refusal: Refusal | null,
  status: number,
): Promise<Response> {
  const household = await findHousehold(db, householdId);
  if (household === null) return adminNotFound(member);

  const members = await membersOfHousehold(db, household.id);

  return page(
    household.name,
    householdBody(household, members, refusal),
    "week",
    member,
    status,
  );
}

function householdListBody(
  households: Household[],
  refusal: Refusal | null,
): Raw {
  return html`<h1>Householdit</h1>
    <p class="empty">
      Kaikki taloudet, myös ne joihin et itse kuulu. Tämä on ylläpitäjän
      poikkeus: muualla sovelluksessa toisen talouden tiedot eivät näy
      lainkaan.
    </p>
    <ul class="recipes">
      ${households.map(
        (household) => html`<li>
          <a href="/admin/households/${household.id}">
            <span class="recipes-text">
              ${household.name}
              <span class="meta">
                ${household.memberCount === 1
                  ? "1 jäsen"
                  : `${household.memberCount} jäsentä`}
              </span>
            </span>
          </a>
        </li>`,
      )}
    </ul>
    <h2>Uusi talous</h2>
    ${message(refusal, "create")}
    <form method="post" action="/admin/households" class="stacked">
      <label for="new-household">Nimi</label>
      <input
        id="new-household"
        name="name"
        value="${refusal?.scope === "create" ? (refusal.values.name ?? "") : ""}"
      />
      <button type="submit" class="primary">Luo talous</button>
    </form>
    <p><a href="/admin">Takaisin ylläpitoon</a></p>`;
}

function householdBody(
  household: Household,
  members: HouseholdMember[],
  refusal: Refusal | null,
): Raw {
  return html`<h1>${household.name}</h1>
    ${message(refusal, "name")}
    <form
      method="post"
      action="/admin/households/${household.id}/name"
      class="stacked"
    >
      <label for="household-name">Talouden nimi</label>
      <input
        id="household-name"
        name="name"
        value="${refusal?.scope === "name"
          ? (refusal.values.name ?? "")
          : household.name}"
      />
      <button type="submit">Tallenna nimi</button>
    </form>

    <h2>Jäsenet</h2>
    ${members.length === 0
      ? html`<p class="empty">
          Taloudessa ei ole jäseniä. Ilman jäsentä siihen ei pääse kukaan.
        </p>`
      : html`<ul class="ingredients">
          ${members.map((person) => memberRow(household, person, refusal))}
        </ul>`}

    <h2>Lisää jäsen</h2>
    <p class="empty">
      Google-tunnisteen (sub) näkee kirjautumisseinältä, kun henkilö on kerran
      yrittänyt kirjautua. Sähköposti näytetään, mutta sillä ei tunnisteta.
    </p>
    ${message(refusal, "add")}
    ${memberFieldset(
      `/admin/households/${household.id}/members`,
      "add",
      refusal?.scope === "add"
        ? refusal.values
        : { displayName: "", email: "", googleSub: "" },
      "Lisää jäsen",
    )}
    <p><a href="/admin/households">Takaisin talouksiin</a></p>`;
}

function memberRow(
  household: Household,
  person: HouseholdMember,
  refusal: Refusal | null,
): Raw {
  const scope = `member-${person.id}`;
  const mine = refusal !== null && refusal.scope === scope;

  // A refusal reopens the row it came from, so the message and the fields the
  // operator was typing into are both on screen rather than folded away.
  const values = mine
    ? refusal.values
    : {
        displayName: person.displayName,
        email: person.email ?? "",
        googleSub: person.googleSub,
      };

  return html`<li>
    <details class="rename" ${mine ? "open" : ""}>
      <summary>
        <span class="ingredient-name">${person.displayName}</span>
        <span class="meta">${person.email ?? "ei sähköpostia"}</span>
      </summary>
      ${message(refusal, scope)}
      ${memberFieldset(
        `/admin/households/${household.id}/members/${person.id}`,
        scope,
        values,
        "Tallenna muutokset",
      )}
      <form
        method="post"
        action="/admin/households/${household.id}/members/${person.id}/delete"
        class="confirm"
      >
        <button type="submit" class="danger">Poista taloudesta</button>
      </form>
    </details>
  </li>`;
}

/**
 * The three editable fields, and only those three. There is no `is_admin`
 * control here and no hidden household field: what a member may become through
 * this screen is a different name, a different email or a different Google
 * account, and nothing more.
 */
function memberFieldset(
  action: string,
  scope: string,
  values: Partial<MemberInput>,
  submit: string,
): Raw {
  return html`<form method="post" action="${action}" class="stacked">
    <label for="${scope}-name">Nimi</label>
    <input id="${scope}-name" name="display_name" value="${values.displayName ?? ""}" />
    <label for="${scope}-email">Sähköposti</label>
    <input id="${scope}-email" name="email" value="${values.email ?? ""}" />
    <label for="${scope}-sub">Google-tunniste (sub)</label>
    <input id="${scope}-sub" name="google_sub" value="${values.googleSub ?? ""}" />
    <button type="submit">${submit}</button>
  </form>`;
}

function message(refusal: Refusal | null, scope: string): Raw | string {
  return refusal !== null && refusal.scope === scope
    ? html`<p class="refused">${refusal.message}</p>`
    : "";
}

async function memberInput(request: Request): Promise<MemberInput> {
  const form = await request.formData();

  return {
    displayName: String(form.get("display_name") ?? ""),
    email: String(form.get("email") ?? ""),
    googleSub: String(form.get("google_sub") ?? ""),
  };
}

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location } });
}
