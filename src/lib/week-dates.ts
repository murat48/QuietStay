/**
 * Default and follow-on dates for a week's check-in and check-out, as the
 * issuer's form and the owner's details form use them (2026-11-26: both
 * start from today, and check-out and the use year follow check-in).
 */

const DAY_MS = 86_400_000;

/** Today in this browser's time zone, as YYYY-MM-DD. */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parse(iso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

export function addDays(iso: string, days: number): string | null {
  const ms = parse(iso);
  return ms === null ? null : new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * A new check-in, with the check-out and use year that follow it: the stay
 * keeps its length (a week when the old dates give none), and the use year is
 * the check-in's year. `null` while the date is half typed.
 */
export function followCheckIn(
  checkIn: string,
  previous: { checkIn?: string; checkOut?: string },
): { checkOut: string; useYear: number } | null {
  const inMs = parse(checkIn);
  if (inMs === null) return null;
  const oldIn = previous.checkIn ? parse(previous.checkIn) : null;
  const oldOut = previous.checkOut ? parse(previous.checkOut) : null;
  const nights = oldIn !== null && oldOut !== null && oldOut > oldIn ? Math.round((oldOut - oldIn) / DAY_MS) : 7;
  return { checkOut: addDays(checkIn, nights)!, useYear: Number(checkIn.slice(0, 4)) };
}
