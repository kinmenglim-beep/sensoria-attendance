// Roster (rostered working hours) and matching clock-ins against it.

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
 * Parse a roster cell such as "10-15", "10:00-15:00, 17:00-22:30" or "6pm-1am".
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

/** UTC instants of a rostered shift; an end at or before the start is on the next day. */
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

// A roster row with this start_time means "off that day", overriding the usual hours.
export const OFF = 'off';

/** 0 = Monday … 6 = Sunday. */
export function weekdayIndex(date) {
  const [y, m, d] = date.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/**
 * Who works when between two dates (inclusive): roster rows for a specific date win,
 * otherwise each active worker's usual weekly hours apply. Optionally for one worker.
 * Returns [{ user_id, work_date, start_time, end_time, override }] sorted by date and start.
 */
export async function effectiveRoster(db, fromDate, toDate, userId = null) {
  const only = userId ? ' AND user_id = ?' : '';
  const params = userId ? [userId] : [];
  const specific = await db.all(
    `SELECT user_id, work_date, start_time, end_time FROM roster WHERE work_date BETWEEN ? AND ?${only}`,
    fromDate, toDate, ...params,
  );
  const usual = await db.all(`
    SELECT h.user_id, h.weekday, h.start_time, h.end_time FROM usual_hours h JOIN users u ON u.id = h.user_id
    WHERE u.active = 1 AND u.role = 'worker'${only.replace('user_id', 'h.user_id')}
  `, ...params);
  const overridden = new Set(specific.map((r) => `${r.user_id}|${r.work_date}`));
  const out = specific.filter((r) => r.start_time !== OFF).map((r) => ({ ...r, override: true }));
  for (let d = fromDate; d <= toDate; d = addDays(d, 1)) {
    const wd = weekdayIndex(d);
    for (const u of usual) {
      if (u.weekday === wd && !overridden.has(`${u.user_id}|${d}`)) {
        out.push({ user_id: u.user_id, work_date: d, start_time: u.start_time, end_time: u.end_time, override: false });
      }
    }
  }
  return out.sort((a, b) => a.work_date.localeCompare(b.work_date) || a.start_time.localeCompare(b.start_time));
}

/** One worker's rostered shifts between two dates (inclusive), with UTC start/end. */
export async function rosterSlots(db, userId, fromDate, toDate) {
  const rows = await effectiveRoster(db, fromDate, toDate, userId);
  return rows.map((r) => ({ ...r, ...slotTimes(r.work_date, r.start_time, r.end_time) }));
}

/**
 * Match a clock-in at `nowMs` to the worker's roster.
 * Returns one of:
 *   { status: 'ok' | 'late', slot, lateMin }   rostered shift found (late = past the grace period)
 *   { status: 'too_early', slot, opensAt }      next rostered shift hasn't opened for clock-in yet
 *   { status: 'none' }                          nothing rostered for the rest of today
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

/** Whole minutes between the rostered start and the check-in (0 if on time or early). */
export function minutesLate(shift) {
  if (!shift.sched_start) return 0;
  return Math.max(0, Math.floor((Date.parse(shift.check_in_at) - Date.parse(shift.sched_start)) / 60000));
}

/** Whole minutes between the check-out and the rostered end (0 if they stayed until the end). */
export function minutesEarly(shift) {
  if (!shift.sched_end || !shift.check_out_at) return 0;
  return Math.max(0, Math.floor((Date.parse(shift.sched_end) - Date.parse(shift.check_out_at)) / 60000));
}
