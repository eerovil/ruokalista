/**
 * Dates are `YYYY-MM-DD` text, compared as strings, which sorts correctly.
 * Everything here works in that shape and never hands a Date around.
 *
 * "Today" is today in Helsinki, not in UTC: a Worker running at 01:00 UTC on a
 * Tuesday is on Tuesday morning in the kitchen, and the week screen should
 * agree with the kitchen.
 */

const ZONE = "Europe/Helsinki";

const DAY_NAMES = [
  "maanantai",
  "tiistai",
  "keskiviikko",
  "torstai",
  "perjantai",
  "lauantai",
  "sunnuntai",
];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isDate(text: string): boolean {
  if (!DATE_PATTERN.test(text)) return false;
  // Rejects 2026-02-31, which matches the pattern but is not a day.
  return toIso(toUtc(text)) === text;
}

export function today(): string {
  // sv-SE formats as YYYY-MM-DD, which saves parsing parts back together.
  return new Intl.DateTimeFormat("sv-SE", { timeZone: ZONE }).format(new Date());
}

export function addDays(date: string, days: number): string {
  const at = toUtc(date);
  at.setUTCDate(at.getUTCDate() + days);
  return toIso(at);
}

/** The Monday of the week `date` falls in. Weeks start on Monday here. */
export function mondayOf(date: string): string {
  const weekday = toUtc(date).getUTCDay(); // 0 is Sunday
  const fromMonday = (weekday + 6) % 7;
  return addDays(date, -fromMonday);
}

export function weekFrom(monday: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

export function dayName(date: string): string {
  const weekday = toUtc(date).getUTCDay();
  return DAY_NAMES[(weekday + 6) % 7]!;
}

/** `2026-08-25` as `25.8.` — enough beside a weekday name. */
export function shortDate(date: string): string {
  const [, month, day] = date.split("-") as [string, string, string];
  return `${Number(day)}.${Number(month)}.`;
}

function toUtc(date: string): Date {
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return new Date(Date.UTC(year, month - 1, day));
}

function toIso(at: Date): string {
  return at.toISOString().slice(0, 10);
}
