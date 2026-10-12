// Attendance record against the roster: late arrivals, early leaves and no-shows.
// Worked out from the actual clock times (not the flags), so supervisor corrections
// count, and clocking out/in for a break within a rostered shift is one attendance.

import { addDays, daysInMonth, localDate } from './time.js';
import { effectiveRoster, slotTimes } from './schedule.js';
import { hasFlag } from './db.js';

/**
 * @returns {{ rows, incidents, totals }}
 *   rows:      per worker { worker, rostered, attended, absent, late, lateMin, early, earlyMin }
 *   incidents: [{ type: 'late'|'early'|'absent', user_id, name, work_date, schedStart, schedEnd, actual, minutes, shiftId }]
 */
export async function attendanceReport(db, ym, { graceMin = 0, userId = null } = {}) {
  const from = `${ym}-01`;
  const last = `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`;
  const today = localDate();
  const to = last < today ? last : today;
  const now = Date.now();
  const graceMs = graceMin * 60000;

  const workers = await db.all(`
    SELECT id, name, short_name FROM users
    WHERE role = 'worker' AND (active = 1 OR id IN (SELECT user_id FROM shifts WHERE work_date BETWEEN ? AND ?))
    ${userId ? 'AND id = ?' : ''} ORDER BY name COLLATE NOCASE
  `, from, last, ...(userId ? [userId] : []));
  const byId = new Map(workers.map((w) => [w.id, {
    worker: w, rostered: 0, attended: 0, absent: 0, late: 0, lateMin: 0, early: 0, earlyMin: 0,
  }]));
  const incidents = [];
  if (from > today) return { rows: [...byId.values()], incidents, totals: totalsOf([...byId.values()]) };

  // Clock-ins matched to a rostered shift, grouped per worker + rostered start.
  const shifts = await db.all(`
    SELECT id, user_id, check_in_at, check_out_at, sched_start, sched_end, flags FROM shifts
    WHERE sched_start IS NOT NULL AND work_date BETWEEN ? AND ? ORDER BY check_in_at
  `, addDays(from, -1), to);
  const groups = new Map();
  for (const s of shifts) {
    const key = `${s.user_id}|${s.sched_start}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  for (const [key, list] of groups) {
    const first = list[0];
    const date = localDate(first.sched_start);
    const row = byId.get(first.user_id);
    if (!row || date < from || date > to) continue;
    row.rostered += 1;
    row.attended += 1;
    const lateMs = Date.parse(first.check_in_at) - Date.parse(first.sched_start);
    if (lateMs > graceMs) {
      const minutes = Math.floor(lateMs / 60000);
      row.late += 1;
      row.lateMin += minutes;
      incidents.push(incident('late', row.worker, date, first, first.check_in_at, minutes, first.id));
    }
    // Early leave: only once they have clocked out for good (none still open, none forgotten).
    const lastShift = list[list.length - 1];
    if (list.every((s) => s.check_out_at && !hasFlag(s.flags, 'no_checkout'))) {
      const earlyMs = Date.parse(first.sched_end) - Date.parse(lastShift.check_out_at);
      if (earlyMs > graceMs) {
        const minutes = Math.floor(earlyMs / 60000);
        row.early += 1;
        row.earlyMin += minutes;
        incidents.push(incident('early', row.worker, date, first, lastShift.check_out_at, minutes, lastShift.id));
      }
    }
    groups.set(key, true);
  }

  // Rostered shifts that are over with no clock-in at all.
  for (const r of await effectiveRoster(db, from, to, userId)) {
    const row = byId.get(r.user_id);
    if (!row) continue;
    const t = slotTimes(r.work_date, r.start_time, r.end_time);
    if (groups.has(`${r.user_id}|${t.startIso}`) || Date.parse(t.endIso) > now) continue;
    row.rostered += 1;
    row.absent += 1;
    incidents.push(incident('absent', row.worker, r.work_date, { sched_start: t.startIso, sched_end: t.endIso }, null, null, null));
  }

  incidents.sort((a, b) => a.schedStart.localeCompare(b.schedStart) || a.name.localeCompare(b.name));
  const rows = [...byId.values()];
  return { rows, incidents, totals: totalsOf(rows) };
}

function incident(type, worker, date, sched, actual, minutes, shiftId) {
  return {
    type, user_id: worker.id, name: worker.name, work_date: date,
    schedStart: sched.sched_start, schedEnd: sched.sched_end, actual, minutes, shiftId,
  };
}

function totalsOf(rows) {
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  return {
    rostered: sum('rostered'), attended: sum('attended'), absent: sum('absent'),
    late: sum('late'), lateMin: sum('lateMin'), early: sum('early'), earlyMin: sum('earlyMin'),
  };
}
