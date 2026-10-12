// Working hours and matching clock-ins against them.

import { localToUtcIso, addDays, localDate } from './time.js';

const pad = (n) => String(n).padStart(2, '0');

/** "9", "0930", "9:30", "9.30", "9:30pm" → "09:30" / "21:30", or null. */
function parseTime(s) {
  const m = /^(\d{1,2})(?:[:.]?(\d{2}))?\s*(am|pm)?$/i.exec(s.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2] || 0);
  const ampm = (m[3] || '').toLowerCase();
  if (mi > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ampm === 'pm' ? 12 : 0);
  } else if (h > 23) {
    return null;
  }
  return `${pad(h)}:${pad(mi)}`;
}

/**
 * Parse working hours such as "10-15", "10:00-15:00, 17:00-22:30" or "6pm-1am".
 * Blank, "off" or "-" means not working. Returns { ranges: [{ start, end }] } or { error }.
 */
export function parseRanges(text) {
  const t = String(text || '').trim();
  if (!t || /^(off|-|–)$/i.test(t)) return { ranges: [] };
  const ranges = [];
  for (const part of t.split(/[,;/\n]+/).map((x) => x.trim()).filter(Boolean)) {
    const ends = part.split(/\s*(?:-|–|—|\bto\b)\s*/i);
    const start = ends.length === 2 ? parseTime(ends[0]) : null;
    const end = ends.length === 2 ? parseTime(ends[1]) : null;
    if (!start || !end) return { error: `“${part}” isn't a time range like 10:00-15:00.` };
    if (start === end) return { error: `“${part}” starts and ends at the same time.` };
    ranges.push({ start, end });
  }
  ranges.sort((a, b) => a.start.localeCompare(b.start));
  return { ranges };
}

export const formatRanges = (rows) => rows.map((r) => `${r.start_time ?? r.start}-${r.end_time ?? r.end}`).join(', ');

/** UTC instants of a block of working hours; an end at or before the start is on the next day. */
export function slotTimes(date, start, end) {
  const startIso = localToUtcIso(date, start);
  const endIso = localToUtcIso(end <= start ? addDays(date, 1) : date, end);
  return { startIso, endIso };
}

/** Monday of the week containing the date. */
export function weekStart(date) {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

/** The person's own working hours if set, otherwise everyone's (Settings), as [{ start, end }]. */
export function workRanges(user, settings) {
  return parseRanges(user?.work_hours || settings.work_hours).ranges || [];
}

/** That day's working-hour blocks with UTC start/end (a block past midnight ends the next day). */
export function daySlots(ranges, date) {
  return ranges.map((r) => ({ work_date: date, start_time: r.start, end_time: r.end, ...slotTimes(date, r.start, r.end) }));
}

/**
 * Match a clock-in at `nowMs` to a block of working hours.
 * Returns one of:
 *   { status: 'ok' | 'late', slot, lateMin }   block found (late = past the grace period)
 *   { status: 'too_early', slot, opensAt }      more than earlyMin before the next block
 *   { status: 'none' }                          no more working hours today
 */
export function matchSlot(slots, nowMs, { earlyMin, graceMin }) {
  const open = slots.find((s) => nowMs >= Date.parse(s.startIso) - earlyMin * 60000 && nowMs <= Date.parse(s.endIso));
  if (open) {
    const lateMin = Math.floor((nowMs - Date.parse(open.startIso)) / 60000);
    return { status: lateMin > graceMin ? 'late' : 'ok', slot: open, lateMin: Math.max(0, lateMin) };
  }
  const next = slots.find((s) => Date.parse(s.startIso) - earlyMin * 60000 > nowMs && s.work_date === localDate(nowMs));
  if (next) return { status: 'too_early', slot: next, opensAt: new Date(Date.parse(next.startIso) - earlyMin * 60000).toISOString() };
  return { status: 'none' };
}

/** Whole minutes between the start of working hours and the check-in (0 if on time or early). */
export function minutesLate(shift) {
  if (!shift.sched_start) return 0;
  return Math.max(0, Math.floor((Date.parse(shift.check_in_at) - Date.parse(shift.sched_start)) / 60000));
}

/** Whole minutes between the check-out and the end of working hours (0 if they stayed until the end). */
export function minutesEarly(shift) {
  if (!shift.sched_end || !shift.check_out_at) return 0;
  return Math.max(0, Math.floor((Date.parse(shift.sched_end) - Date.parse(shift.check_out_at)) / 60000));
}
