export async function getHouseholdDefaultPortions(
  db: D1Database,
  householdId: number
): Promise<number> {
  const row = await db.prepare(`
    SELECT default_portions
    FROM household
    WHERE id = ?
  `).bind(householdId).first<{ default_portions: number }>();

  return row?.default_portions ?? 4;
}

export async function updateHouseholdDefaultPortions(
  db: D1Database,
  householdId: number,
  portions: number
): Promise<boolean> {
  if (!Number.isInteger(portions) || portions <= 0) return false;

  const result = await db.prepare(`
    UPDATE household
    SET default_portions = ?
    WHERE id = ?
  `).bind(portions, householdId).run();

  return result.meta.changes > 0;
}
