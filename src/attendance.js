// Attendance record against fixed working hours: late arrivals, early leaves and
// extra days off. There is no roster: any day without a clock-in is a day off, and
// each person may take `days_off_per_week` of those per week (Monday to Sunday).
// Lateness uses the actual (or supervisor-corrected) times, and clocking out and in
// again for a break within the working hours counts once.

import { addDays, daysInMonth, localDate } from './time.js';
import { workRanges, daySlots, weekStart } from './schedule.js';
import { hasFlag } from './db.js';

/** Days in [from, to] (inclusive) when the person didn't clock in, ignoring days before they were added. */
export function daysOff(workedDates, from, to, createdAt) {
  const start = createdAt && localDate(createdAt) > from ? localDate(createdAt) : from;
  const out = [];
  for (let d = start; d <= to; d = addDays(d, 1)) if (!workedDates.has(d)) out.push(d);
  return out;
}

/** Whether all of the day's working hours are over (the day can no longer be worked). */
const dayOver = (slots, now) => !slots.length || Date.parse(slots[slots.length - 1].endIso) <= now;

/**
 * @returns {{ rows, incidents, totals }}
 *   rows:      per worker { worker, worked, off, extraOff, late, lateMin, early, earlyMin, missed }
 *   incidents: [{ type: 'late'|'early'|'missed'|'extra_off', user_id, name, work_date, outlet, schedStart, schedEnd, actual, minutes, shiftId }]
 * With `outlet`, only what happened at that outlet (where people clocked in); days off are
 * about the person, not an outlet, so they are left out.
 */
export async function attendanceReport(db, ym, settings, { userId = null, outlet = null } = {}) {
  const from = `${ym}-01`;
  const last = `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`;
  const today = localDate();
  const to = last < today ? last : today;
  const now = Date.now();
  const graceMs = (Number(settings.late_grace_min) || 0) * 60000;
  const allowance = Number(settings.days_off_per_week) || 0;

  const workers = await db.all(`
    SELECT id, name, short_name, work_hours, created_at FROM users
    WHERE role = 'worker' AND (active = 1 OR id IN (SELECT user_id FROM shifts WHERE work_date BETWEEN ? AND ?))
    ${userId ? 'AND id = ?' : ''} ORDER BY name COLLATE NOCASE
  `, from, last, ...(userId ? [userId] : []));
  const rows = workers.map((w) => ({ worker: w, worked: 0, off: 0, extraOff: 0, late: 0, lateMin: 0, early: 0, earlyMin: 0, missed: 0 }));
  const incidents = [];
  if (from > today) return { rows, incidents, totals: totalsOf(rows) };

  // Whole weeks, so a day off at the end of last month counts towards this month's first week.
  const weekFrom = weekStart(from);
  const shifts = await db.all(`
    SELECT id, user_id, work_date, check_in_at, check_out_at, sched_start, sched_end, flags, in_site FROM shifts
    WHERE work_date BETWEEN ? AND ? ORDER BY check_in_at
  `, addDays(weekFrom, -1), to);
  const inMonth = (d) => d >= from && d <= to;
  const sites = new Map((await db.all('SELECT name, work_hours FROM sites')).map((x) => [x.name, x]));

  for (const row of rows) {
    const w = row.worker;
    const mine = shifts.filter((s) => s.user_id === w.id);
    const worked = new Set(mine.map((s) => s.work_date));
    const ranges = workRanges(w, settings);
    const add = (type, date, sched, actual, minutes, shiftId, at = null) => incidents.push({
      type, user_id: w.id, name: w.name, work_date: date, outlet: at,
      schedStart: sched?.startIso ?? null, schedEnd: sched?.endIso ?? null, actual, minutes, shiftId,
    });

    // Days off, week by week; the ones beyond the allowance are extra days off.
    for (let wk = weekFrom; !outlet && wk <= to; wk = addDays(wk, 7)) {
      const end = addDays(wk, 6) < to ? addDays(wk, 6) : to;
      const offs = daysOff(worked, wk, end, w.created_at)
        .filter((d) => dayOver(daySlots(ranges, d), now));
      offs.forEach((d, i) => {
        if (!inMonth(d)) return;
        row.off += 1;
        if (i >= allowance) {
          row.extraOff += 1;
          add('extra_off', d, null, null, null, null);
        }
      });
    }

    // Days worked: late arrival, early leave, and any block of a split shift missed entirely.
    for (const d of [...worked].filter(inMonth).sort()) {
      const dayShifts = mine.filter((s) => s.work_date === d);
      if (outlet && !dayShifts.some((s) => s.in_site === outlet)) continue;
      row.worked += 1;
      // The outlet they clocked in at that day decides the working hours, if it has its own.
      const dayOutlet = dayShifts[0].in_site;
      for (const slot of daySlots(workRanges(w, settings, sites.get(dayOutlet)), d)) {
        const during = mine.filter((s) => s.check_in_at < slot.endIso && (s.check_out_at || new Date(now).toISOString()) > slot.startIso);
        const at = during[0]?.in_site ?? dayOutlet;
        if (outlet && at !== outlet) continue;
        if (!during.length) {
          if (Date.parse(slot.endIso) <= now) {
            row.missed += 1;
            add('missed', d, slot, null, null, null, at);
          }
          continue;
        }
        const first = during[0];
        // Prefer the hours saved with the shift at clock-in (when they are for this block), so later
        // changes to the working hours don't rewrite history.
        const ownBlock = (x) => x.sched_start && Date.parse(x.sched_start) >= Date.parse(slot.startIso) - 3 * 3600000
          && x.sched_start < slot.endIso;
        const start = ownBlock(first) ? first.sched_start : slot.startIso;
        const lateMs = Date.parse(first.check_in_at) - Date.parse(start);
        if (lateMs > graceMs) {
          const minutes = Math.floor(lateMs / 60000);
          row.late += 1;
          row.lateMin += minutes;
          add('late', d, slot, first.check_in_at, minutes, first.id, at);
        }
        // Early leave only once they've clocked out for good (nothing open or forgotten).
        const lastShift = during[during.length - 1];
        if (during.every((s) => s.check_out_at && !hasFlag(s.flags, 'no_checkout'))) {
          const end = ownBlock(lastShift) ? lastShift.sched_end : slot.endIso;
          const earlyMs = Date.parse(end) - Date.parse(lastShift.check_out_at);
          if (earlyMs > graceMs) {
            const minutes = Math.floor(earlyMs / 60000);
            row.early += 1;
            row.earlyMin += minutes;
            add('early', d, slot, lastShift.check_out_at, minutes, lastShift.id, at);
          }
        }
      }
    }
  }

  incidents.sort((a, b) => a.work_date.localeCompare(b.work_date) || a.name.localeCompare(b.name)
    || String(a.schedStart).localeCompare(String(b.schedStart)));
  const shown = outlet ? rows.filter((r) => r.worked) : rows;
  return { rows: shown, incidents, totals: totalsOf(shown) };
}

function totalsOf(rows) {
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  return {
    worked: sum('worked'), off: sum('off'), extraOff: sum('extraOff'), missed: sum('missed'),
    late: sum('late'), lateMin: sum('lateMin'), early: sum('early'), earlyMin: sum('earlyMin'),
  };
}
