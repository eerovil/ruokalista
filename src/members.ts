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
}

interface MemberRow {
  id: number;
  household_id: number;
  display_name: string;
  email: string | null;
}

export async function findMemberById(
  db: D1Database,
  id: number,
): Promise<Member | null> {
  const row = await db
    .prepare(
      "SELECT id, household_id, display_name, email FROM member WHERE id = ?",
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
      "SELECT id, household_id, display_name, email FROM member WHERE google_sub = ?",
    )
    .bind(googleSub)
    .first<MemberRow>();

  return row === null ? null : toMember(row);
}

function toMember(row: MemberRow): Member {
  return {
    id: row.id,
    householdId: row.household_id,
    displayName: row.display_name,
    email: row.email,
  };
}
