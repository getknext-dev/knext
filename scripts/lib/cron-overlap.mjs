// #1301 review round 1 — cron collision detection must compare the same UTC
// MINUTE-OF-DAY two crons actually fire on, not their literal strings. A
// string comparison passes `17 3 * * 0` against `17 3 * * *` (the day-of-week
// `*` INCLUDES Sunday, so they DO collide), `17 03 * * *` against
// `17 3 * * *` (same integer hour, different literal), and two IDENTICAL
// crons declared twice within one file (a string-collision check keyed by
// "shared by more than one FILE" never compares two entries in the SAME
// file against each other).
//
// This repo's crons are all `M H * * D` (minute hour * * day-of-week) — day-
// of-month and month are always `*`. parseCron() fails closed on anything
// else rather than guessing.

/**
 * @typedef {{ minute: number, hour: number, daysOfWeek: Set<number> }} ParsedCron
 */

/** @param {string} cron @returns {ParsedCron} */
export function parseCron(cron) {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`parseCron: expected 5 fields "M H * * D", got "${cron}"`);
  }
  const [minuteRaw, hourRaw, dayOfMonth, month, dayOfWeekRaw] = parts;
  if (dayOfMonth !== '*' || month !== '*') {
    throw new Error(
      `parseCron: day-of-month and month must be "*" (this repo's crons never set them) — got "${cron}"`,
    );
  }
  const minute = Number(minuteRaw);
  const hour = Number(hourRaw);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error(`parseCron: minute must be an integer 0-59, got "${minuteRaw}" in "${cron}"`);
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`parseCron: hour must be an integer 0-23, got "${hourRaw}" in "${cron}"`);
  }
  const daysOfWeek =
    dayOfWeekRaw === '*'
      ? new Set([0, 1, 2, 3, 4, 5, 6])
      : new Set(
          dayOfWeekRaw.split(',').map((d) => {
            const n = Number(d);
            if (!Number.isInteger(n) || n < 0 || n > 6) {
              throw new Error(`parseCron: day-of-week must be 0-6 or "*", got "${d}" in "${cron}"`);
            }
            return n;
          }),
        );
  return { minute, hour, daysOfWeek };
}

/** Do two crons fire in the same UTC minute-of-day on at least one shared day-of-week? */
export function cronsOverlap(a, b) {
  const pa = parseCron(a);
  const pb = parseCron(b);
  if (pa.minute !== pb.minute || pa.hour !== pb.hour) return false;
  for (const d of pa.daysOfWeek) {
    if (pb.daysOfWeek.has(d)) return true;
  }
  return false;
}

/**
 * @param {{ file: string, cron: string }[]} entries
 * @returns {{ a: { file: string, cron: string }, b: { file: string, cron: string } }[]}
 */
export function findOverlappingPairs(entries) {
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (cronsOverlap(entries[i].cron, entries[j].cron)) {
        out.push({ a: entries[i], b: entries[j] });
      }
    }
  }
  return out;
}
