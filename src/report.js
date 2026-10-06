'use strict';

const { daysInMonth, hoursBetween } = require('./time');
const { DEVICE_COLUMNS, DEVICE_JOINS } = require('./device');

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Monthly roll-up per worker. Only approved hours count towards pay;
 * pending / rejected / still-open shifts are reported separately so
 * management can see what is outstanding.
 */
function monthReport(db, ym) {
  const like = `${ym}-%`;
  const nDays = daysInMonth(ym);

  const shifts = db.prepare(`
    SELECT s.*, u.name, u.login, u.hourly_rate, r.name AS reviewer_name, ${DEVICE_COLUMNS}
    FROM shifts s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN users r ON r.id = s.reviewed_by
    ${DEVICE_JOINS}
    WHERE s.work_date LIKE ?
    ORDER BY u.name COLLATE NOCASE, s.check_in_at
  `).all(like);

  const workers = db.prepare(`
    SELECT id, name, login, hourly_rate FROM users
    WHERE (role = 'worker' AND active = 1) OR id IN (SELECT user_id FROM shifts WHERE work_date LIKE ?)
    ORDER BY name COLLATE NOCASE
  `).all(like);

  const byId = new Map();
  for (const w of workers) {
    byId.set(w.id, {
      worker: w, daily: new Array(nDays).fill(0), dates: new Set(),
      shifts: 0, approved: 0, pending: 0, rejected: 0, open: 0, flagged: 0,
    });
  }

  for (const s of shifts) {
    const row = byId.get(s.user_id);
    if (!row) continue;
    row.shifts += 1;
    if (s.flags) row.flagged += 1;
    if (!s.check_out_at) { row.open += 1; continue; }
    const hrs = hoursBetween(s.check_in_at, s.check_out_at);
    if (s.status === 'approved') {
      row.approved += hrs;
      row.daily[Number(s.work_date.slice(8, 10)) - 1] += hrs;
      row.dates.add(s.work_date);
    } else if (s.status === 'pending') {
      row.pending += hrs;
    } else {
      row.rejected += hrs;
    }
  }

  const rows = [...byId.values()].map((r) => ({
    ...r,
    daysWorked: r.dates.size,
    approved: round2(r.approved),
    pending: round2(r.pending),
    rejected: round2(r.rejected),
    daily: r.daily.map(round2),
    pay: r.worker.hourly_rate != null ? round2(r.approved * r.worker.hourly_rate) : null,
  }));

  const totals = {
    shifts: rows.reduce((a, r) => a + r.shifts, 0),
    daysWorked: rows.reduce((a, r) => a + r.daysWorked, 0),
    approved: round2(rows.reduce((a, r) => a + r.approved, 0)),
    pending: round2(rows.reduce((a, r) => a + r.pending, 0)),
    rejected: round2(rows.reduce((a, r) => a + r.rejected, 0)),
    open: rows.reduce((a, r) => a + r.open, 0),
    pay: round2(rows.reduce((a, r) => a + (r.pay || 0), 0)),
    daily: Array.from({ length: nDays }, (_, i) => round2(rows.reduce((a, r) => a + r.daily[i], 0))),
  };

  return { ym, nDays, rows, totals, shifts };
}

module.exports = { monthReport, round2 };
