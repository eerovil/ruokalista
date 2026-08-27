/**
 * A member is one person in a household, known by the Google account they sign
 * in with. Looking one up is how a request stops being anonymous and gains the
 * household_id that every other query is scoped by.
 */

export interface Member {
  id: number;
  householdId: number;
  displayName: string;
  email: string | null;
  /**
   * Whether this person may use the operations that are not every member's to
   * use — the ones that spend money or rewrite what the household already has.
   * It comes from the `member.is_admin` column and from nowhere else.
   */
  isAdmin: boolean;
}

interface MemberRow {
  id: number;
  household_id: number;
  display_name: string;
  email: string | null;
  is_admin: number;
}

const MEMBER_COLUMNS =
  "id, household_id, display_name, email, is_admin" as const;

/**
 * A member removed from their household by the admin screen (#127) keeps their
 * row, because four tables record them as having made something and the recipe
 * screen prints their name. What they lose is entry — so every lookup that
 * turns a request into a member asks this, and nothing here is a "just hide
 * them from a list" filter.
 *
 * It has to be on the id lookup and not only on the Google one: a session
 * cookie already in a browser names a member id, and would otherwise still
 * open the household somebody was just removed from.
 */
const STILL_A_MEMBER = "removed_at IS NULL" as const;

export async function findMemberById(
  db: D1Database,
  id: number,
): Promise<Member | null> {
  const row = await db
    .prepare(
      `SELECT ${MEMBER_COLUMNS} FROM member WHERE id = ? AND ${STILL_A_MEMBER}`,
    )
    .bind(id)
    .first<MemberRow>();

  return row === null ? null : toMember(row);
}

/**
 * Matched on Google's stable account id, never on email — an email can be
 * reassigned, and the spec is explicit that it is shown but never used to match.
 *
 * No row means no entry. There is no signup path anywhere in the app, so this
 * returning null is the wall a stranger hits, not a reason to create anything.
 */
export async function findMemberByGoogleSub(
  db: D1Database,
  googleSub: string,
): Promise<Member | null> {
  const row = await db
    .prepare(
      `SELECT ${MEMBER_COLUMNS} FROM member
        WHERE google_sub = ? AND ${STILL_A_MEMBER}`,
    )
    .bind(googleSub)
    .first<MemberRow>();

  return row === null ? null : toMember(row);
}

/**
 * Every member, for the development sign-in on `/signin`. There is no
 * household-facing screen that lists people, and there is not meant to be —
 * this exists so a development server can offer the members that already exist
 * rather than inventing one.
 */
export async function allMembers(db: D1Database): Promise<Member[]> {
  const { results } = await db
    .prepare(
      `SELECT ${MEMBER_COLUMNS} FROM member
        WHERE ${STILL_A_MEMBER} ORDER BY id`,
    )
    .all<MemberRow>();

  return results.map(toMember);
}

function toMember(row: MemberRow): Member {
  return {
    id: row.id,
    householdId: row.household_id,
    displayName: row.display_name,
    email: row.email,
    isAdmin: row.is_admin === 1,
  };
}
