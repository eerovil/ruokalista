/**
 * The only cross-household queries in the app, and the one place they are
 * allowed to be.
 *
 * Everywhere else, a query takes the signed-in member's household_id as a
 * parameter and another household's record is a 404. That rule is untouched.
 * What #127 asks for is an operator's view of the whole database — every
 * household, and every household's people — so that membership stops being a
 * hand-written INSERT against production.
 *
 * So the exception is confined here rather than loosened globally: nothing in
 * this module takes a viewer's household_id, and nothing in this module is
 * reachable except through `requireAdminScreen` in `src/index.ts`. A function
 * added here is a function that can read any household, which is why the module
 * is small and stays that way.
 *
 * `member.is_admin` is deliberately absent from every read and every write
 * below. Admin is granted by `scripts/set-admin.sh` against the database, and
 * the app does not grant or revoke it — an admin-management screen that could
 * make more admins is the role system #94 refused to build.
 */

export class HouseholdRefused extends Error {}

export interface Household {
  id: number;
  name: string;
  memberCount: number;
}

/**
 * A member as this screen edits one: the three fields an operator has to be
 * able to correct, and nothing else. Note what is missing — `isAdmin`, which
 * `Member` in `src/members.ts` carries and this type must not.
 *
 * `is_admin` is still *read* below, but only as a guard on the two writes that
 * would otherwise move admin around (see `adminRowGuard`). It never leaves this
 * module, never reaches the markup and is never a form field.
 */
export interface HouseholdMember {
  id: number;
  householdId: number;
  displayName: string;
  email: string | null;
  googleSub: string;
}

interface HouseholdRow {
  id: number;
  name: string;
  member_count: number;
}

interface HouseholdMemberRow {
  id: number;
  household_id: number;
  display_name: string;
  email: string | null;
  google_sub: string;
  is_admin: number;
}

const HOUSEHOLD_MEMBER_COLUMNS =
  "id, household_id, display_name, email, google_sub, is_admin" as const;

/**
 * A removed member is still in the table — see `removeMember` — so every read
 * and every write on this screen asks for the ones who are still in.
 */
const STILL_A_MEMBER = "removed_at IS NULL" as const;

/**
 * What a removed member's `google_sub` becomes, so the real one is free for
 * another household. Google's `sub` is a decimal string, so this shape can
 * never collide with one; `memberFields` refuses it as input all the same,
 * because "can never happen" is cheaper to enforce than to rely on.
 */
const REMOVED_SUB = "'removed:' || id" as const;
const REMOVED_SUB_PREFIX = "removed:" as const;

/** Every household there is, with how many people are in it. */
export async function allHouseholds(db: D1Database): Promise<Household[]> {
  const { results } = await db
    .prepare(
      `SELECT h.id, h.name, count(m.id) AS member_count
         FROM household h
         LEFT JOIN member m ON m.household_id = h.id AND m.removed_at IS NULL
        GROUP BY h.id
        ORDER BY h.id`,
    )
    .all<HouseholdRow>();

  return results.map(toHousehold);
}

export async function findHousehold(
  db: D1Database,
  id: number,
): Promise<Household | null> {
  if (!Number.isInteger(id)) return null;

  const row = await db
    .prepare(
      `SELECT h.id, h.name, count(m.id) AS member_count
         FROM household h
         LEFT JOIN member m ON m.household_id = h.id AND m.removed_at IS NULL
        WHERE h.id = ?
        GROUP BY h.id`,
    )
    .bind(id)
    .first<HouseholdRow>();

  return row === null ? null : toHousehold(row);
}

export async function membersOfHousehold(
  db: D1Database,
  householdId: number,
): Promise<HouseholdMember[]> {
  const { results } = await db
    .prepare(
      `SELECT ${HOUSEHOLD_MEMBER_COLUMNS} FROM member
        WHERE household_id = ? AND ${STILL_A_MEMBER} ORDER BY id`,
    )
    .bind(householdId)
    .all<HouseholdMemberRow>();

  return results.map(toHouseholdMember);
}

/** The new household's id, so the caller can send the operator straight to it. */
export async function createHousehold(
  db: D1Database,
  rawName: string,
): Promise<number> {
  const name = householdName(rawName);

  const inserted = await db
    .prepare("INSERT INTO household (name) VALUES (?)")
    .bind(name)
    .run();

  return Number(inserted.meta.last_row_id);
}

export async function renameHousehold(
  db: D1Database,
  id: number,
  rawName: string,
): Promise<void> {
  const name = householdName(rawName);

  await db
    .prepare("UPDATE household SET name = ? WHERE id = ?")
    .bind(name, id)
    .run();
}

export interface MemberInput {
  displayName: string;
  email: string;
  googleSub: string;
}

/**
 * The bootstrap this replaces: until now the only way to let somebody in was to
 * INSERT a member row by hand, having read their Google `sub` off the sign-in
 * wall. This is that INSERT, with the mistakes it is easy to make in a terminal
 * caught first.
 */
export async function addMember(
  db: D1Database,
  householdId: number,
  input: MemberInput,
): Promise<number> {
  const fields = await memberFields(db, input, null);

  const inserted = await db
    .prepare(
      `INSERT INTO member (household_id, google_sub, display_name, email)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(householdId, fields.googleSub, fields.displayName, fields.email)
    .run();

  return Number(inserted.meta.last_row_id);
}

/**
 * The three editable fields, named one by one in the UPDATE rather than built
 * from the form — so a form field called `is_admin` or `household_id` is not a
 * field at all. Moving somebody between households is deliberately not offered:
 * #127 says remove them from one and add them to the other, which leaves a
 * visible pair of actions instead of a silent reparenting.
 *
 * On an admin's row, `google_sub` is not editable — see `adminRowGuard`.
 */
export async function updateMember(
  db: D1Database,
  householdId: number,
  memberId: number,
  input: MemberInput,
): Promise<void> {
  const row = await memberRowOf(db, householdId, memberId);
  const fields = await memberFields(db, input, row.id);

  if (row.is_admin === 1 && fields.googleSub !== row.google_sub) {
    throw new HouseholdRefused(adminRowGuard(row.display_name, "sub"));
  }

  await db
    .prepare(
      `UPDATE member SET display_name = ?, email = ?, google_sub = ?
        WHERE id = ? AND household_id = ?`,
    )
    .bind(
      fields.displayName,
      fields.email,
      fields.googleSub,
      memberId,
      householdId,
    )
    .run();
}

/**
 * Removing somebody takes away the household, not the person's history.
 *
 * A member is what four tables record as having made a row — `ingredient`,
 * `recipe` (twice), `planned_batch`, `pantry_entry` — and the recipe list and
 * recipe screen join `member` to print that name. So DELETE was never the right
 * verb here: for anybody who has actually used the app it either breaks a
 * foreign key or takes their recipes off the screen with them.
 *
 * The first attempt at #127 refused to remove such a member at all. That reads
 * as safe and is not: nearly every real member has made something, so it blocked
 * removal for exactly the people this tool manages — and with it the only move
 * there is, since #127 defines a move as removing somebody here and adding them
 * there.
 *
 * So this stamps `removed_at` and hands back the Google sub, keeping the real
 * one in `removed_google_sub`. The row stays and keeps attributing what it made;
 * what stops is entry — `src/members.ts` will not turn a cookie or a Google
 * account into a removed member, so an already-open session does not survive it
 * either. And the freed sub can be added to another household, which is the rest
 * of the move.
 *
 * An admin's row is still not removable here at all — see `adminRowGuard`.
 */
export async function removeMember(
  db: D1Database,
  householdId: number,
  memberId: number,
): Promise<HouseholdMember> {
  const row = await memberRowOf(db, householdId, memberId);

  if (row.is_admin === 1) {
    throw new HouseholdRefused(adminRowGuard(row.display_name, "delete"));
  }

  await db
    .prepare(
      `UPDATE member
          SET removed_at = datetime('now'),
              removed_google_sub = google_sub,
              google_sub = ${REMOVED_SUB}
        WHERE id = ? AND household_id = ? AND removed_at IS NULL`,
    )
    .bind(memberId, householdId)
    .run();

  return toHouseholdMember(row);
}

/**
 * The two ways this screen could move admin around without ever showing the
 * word, and the reason `is_admin` is read here at all.
 *
 * Sign-in matches a member on `google_sub` and then reads `is_admin` off that
 * same row (`src/members.ts::findMemberByGoogleSub`). So repointing an admin's
 * row at a different Google account hands that account admin, and deleting the
 * row takes admin away — both without `scripts/set-admin.sh`, which #127 says
 * is the only way admin is granted or revoked. Neither shows up in a review of
 * the form fields, because neither is a form field.
 *
 * Refusing both here rather than in the screen keeps the rule with the write it
 * protects: a second caller of `updateMember` cannot miss it. Name and email
 * stay editable, because neither decides who the row is.
 */
function adminRowGuard(displayName: string, what: "sub" | "delete"): string {
  const tail =
    "Ylläpito-oikeus kulkee rivin mukana, ja se annetaan ja otetaan pois vain käsin tietokannasta.";

  return what === "sub"
    ? `${displayName} on ylläpitäjä, joten hänen Google-tunnistettaan ei voi vaihtaa täältä. ${tail} Nimen ja sähköpostin voi silti korjata.`
    : `${displayName} on ylläpitäjä, joten häntä ei voi poistaa täältä. ${tail}`;
}

async function memberOf(
  db: D1Database,
  householdId: number,
  memberId: number,
): Promise<HouseholdMember> {
  return toHouseholdMember(await memberRowOf(db, householdId, memberId));
}

async function memberRowOf(
  db: D1Database,
  householdId: number,
  memberId: number,
): Promise<HouseholdMemberRow> {
  const row = Number.isInteger(memberId)
    ? await db
        .prepare(
          `SELECT ${HOUSEHOLD_MEMBER_COLUMNS} FROM member
            WHERE id = ? AND household_id = ? AND ${STILL_A_MEMBER}`,
        )
        .bind(memberId, householdId)
        .first<HouseholdMemberRow>()
    : null;

  if (row === null) throw new HouseholdRefused("Tuntematon jäsen.");

  return row;
}

/**
 * `google_sub` is UNIQUE across the whole table, so a clash is not this
 * household's business alone — it has to be looked for everywhere, and named
 * with the household it is already in so the operator knows where to look.
 */
async function memberFields(
  db: D1Database,
  input: MemberInput,
  exceptMemberId: number | null,
): Promise<{ displayName: string; email: string | null; googleSub: string }> {
  const displayName = input.displayName.trim();
  if (displayName === "") throw new HouseholdRefused("Jäsenellä pitää olla nimi.");

  const googleSub = input.googleSub.trim();
  if (googleSub === "") {
    throw new HouseholdRefused(
      "Google-tunniste (sub) puuttuu. Sen näkee kirjautumisseinältä, kun henkilö on yrittänyt kirjautua.",
    );
  }

  // The shape `removeMember` parks a removed member's row on. Google never
  // issues one, so this cannot be a real person's sub — and letting it be typed
  // in would put a live member where the removed ones are.
  if (googleSub.startsWith(REMOVED_SUB_PREFIX)) {
    throw new HouseholdRefused("Tämä ei ole kelvollinen Google-tunniste.");
  }

  const clash = await db
    .prepare(
      `SELECT m.id, h.name AS household_name FROM member m
         JOIN household h ON h.id = m.household_id
        WHERE m.google_sub = ? AND m.${STILL_A_MEMBER}`,
    )
    .bind(googleSub)
    .first<{ id: number; household_name: string }>();

  if (clash !== null && clash.id !== exceptMemberId) {
    throw new HouseholdRefused(
      `Tämä Google-tunniste on jo taloudessa ${clash.household_name}.`,
    );
  }

  const email = input.email.trim();

  return { displayName, email: email === "" ? null : email, googleSub };
}

function householdName(rawName: string): string {
  const name = rawName.trim();
  if (name === "") throw new HouseholdRefused("Taloudella pitää olla nimi.");
  return name;
}

function toHousehold(row: HouseholdRow): Household {
  return { id: row.id, name: row.name, memberCount: row.member_count };
}

function toHouseholdMember(row: HouseholdMemberRow): HouseholdMember {
  return {
    id: row.id,
    householdId: row.household_id,
    displayName: row.display_name,
    email: row.email,
    googleSub: row.google_sub,
  };
}
