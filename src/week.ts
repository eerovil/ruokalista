export interface MealEntryRow {
  id: number;
  date: string;
  slot: "lunch" | "dinner";
  portions: number;
  recipe_id: number;
  recipe_title: string;
}

export interface WeekDay {
  date: string;
  label: string;
  lunch: MealEntryRow[];
  dinner: MealEntryRow[];
}

const DAY_NAMES = ["maanantai", "tiistai", "keskiviikko", "torstai", "perjantai", "lauantai", "sunnuntai"];

export function parseIsoDate(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;
  return date;
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function mondayOf(date: Date): Date {
  const copy = new Date(date.getTime());
  const weekday = copy.getUTCDay();
  const daysFromMonday = (weekday + 6) % 7;
  copy.setUTCDate(copy.getUTCDate() - daysFromMonday);
  return copy;
}

export function addDays(date: Date, amount: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + amount);
  return copy;
}

export function buildWeek(start: Date, entries: MealEntryRow[]): WeekDay[] {
  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(start, index);
    const key = isoDate(date);
    const label = `${DAY_NAMES[index]} ${date.getUTCDate()}.${date.getUTCMonth() + 1}.`;
    const onDate = entries.filter((entry) => entry.date === key);
    return {
      date: key,
      label,
      lunch: onDate.filter((entry) => entry.slot === "lunch"),
      dinner: onDate.filter((entry) => entry.slot === "dinner")
    };
  });
}

export async function loadWeek(
  db: D1Database,
  householdId: number,
  start: Date
): Promise<MealEntryRow[]> {
  const end = addDays(start, 6);
  const result = await db.prepare(`
    SELECT
      meal_entry.id,
      meal_entry.date,
      meal_entry.slot,
      meal_entry.portions,
      recipe.id AS recipe_id,
      recipe.title AS recipe_title
    FROM meal_entry
    JOIN recipe ON recipe.id = meal_entry.recipe_id
    WHERE meal_entry.household_id = ?
      AND meal_entry.date BETWEEN ? AND ?
    ORDER BY meal_entry.date, meal_entry.slot, meal_entry.id
  `).bind(householdId, isoDate(start), isoDate(end)).all<MealEntryRow>();

  return result.results;
}
