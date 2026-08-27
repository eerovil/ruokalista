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
}

const HOUSEHOLD_MEMBER_COLUMNS =
  "id, household_id, display_name, email, google_sub" as const;

/** Every household there is, with how many people are in it. */
export async function allHouseholds(db: D1Database): Promise<Household[]> {
  const { results } = await db
    .prepare(
      `SELECT h.id, h.name, count(m.id) AS member_count
         FROM household h
         LEFT JOIN member m ON m.household_id = h.id
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
         LEFT JOIN member m ON m.household_id = h.id
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
        WHERE household_id = ? ORDER BY id`,
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
 */
export async function updateMember(
  db: D1Database,
  householdId: number,
  memberId: number,
  input: MemberInput,
): Promise<void> {
  const existing = await memberOf(db, householdId, memberId);
  const fields = await memberFields(db, input, existing.id);

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
 * Removing somebody is the half of "move" that can fail, because a member is
 * what four other tables record as having created a row. Deleting one of those
 * members would either break a foreign key or, worse, take the household's
 * recipes with it — so this counts first and says what is in the way, in
 * Finnish, rather than letting D1 answer with a constraint error.
 */
export async function removeMember(
  db: D1Database,
  householdId: number,
  memberId: number,
): Promise<HouseholdMember> {
  const member = await memberOf(db, householdId, memberId);

  const authored = await db
    .prepare(
      `SELECT
         (SELECT count(*) FROM ingredient    WHERE created_by = ?1) +
         (SELECT count(*) FROM recipe        WHERE created_by = ?1 OR updated_by = ?1) +
         (SELECT count(*) FROM planned_batch WHERE created_by = ?1) AS rows_made`,
    )
    .bind(memberId)
    .first<{ rows_made: number }>();

  if (authored !== null && authored.rows_made > 0) {
    throw new HouseholdRefused(
      `${member.displayName} on tehnyt talouteen sisältöä (${authored.rows_made} riviä), joten häntä ei voi poistaa. Sisältö katoaisi mukana.`,
    );
  }

  await db
    .prepare("DELETE FROM member WHERE id = ? AND household_id = ?")
    .bind(memberId, householdId)
    .run();

  return member;
}

async function memberOf(
  db: D1Database,
  householdId: number,
  memberId: number,
): Promise<HouseholdMember> {
  const row = Number.isInteger(memberId)
    ? await db
        .prepare(
          `SELECT ${HOUSEHOLD_MEMBER_COLUMNS} FROM member
            WHERE id = ? AND household_id = ?`,
        )
        .bind(memberId, householdId)
        .first<HouseholdMemberRow>()
    : null;

  if (row === null) throw new HouseholdRefused("Tuntematon jäsen.");

  return toHouseholdMember(row);
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

  const clash = await db
    .prepare(
      `SELECT m.id, h.name AS household_name FROM member m
         JOIN household h ON h.id = m.household_id
        WHERE m.google_sub = ?`,
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
