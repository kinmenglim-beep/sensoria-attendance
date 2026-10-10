import {
  getSettings, setSettingStmt, auditStmt, addFlags, removeFlags, hasFlag, PHOTO_KEEP_DAYS,
} from '../db.js';
import { hashSecret } from '../auth.js';
import {
  localDate, localTime, localDateTime, localToUtcIso, addDays, addMonths, hoursBetween, paidHours, roundTime, formatDuration, formatHM, ROUND_MINUTES,
  prettyDate, prettyMonth, isDate, isMonth, isTime, TZ,
} from '../time.js';
import { normalizeIp } from '../verify.js';
import { html, statusBadge, flagList, flagLabel, fmtHours, fmtMoney, clockTime } from '../views.js';
import { monthReport } from '../report.js';
import { toCsv } from '../csv.js';
import {
  deviceName, frequentDeviceChangers, recentDeviceCount, DEVICE_COLUMNS, DEVICE_JOINS,
} from '../device.js';
import {
  parseRanges, formatRanges, slotTimes, weekStart, minutesLate,
} from '../schedule.js';

const toIds = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v])
  .map(Number).filter((n) => Number.isInteger(n) && n > 0);

const safeBack = (v) => (typeof v === 'string' && /^\/admin(\/|\?|$)/.test(v) && !v.startsWith('//') ? v : '/admin');

function withMsg(url, msg) {
  return `${url}${url.includes('?') ? '&' : '?'}ok=${encodeURIComponent(msg)}`;
}

function mapLink(lat, lng) {
  if (lat == null || lng == null) return '';
  return html`<a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" rel="noopener noreferrer">map</a>`;
}

function locationSummary(site, distance, accuracy, lat, lng) {
  if (lat == null) return html`<span class="muted">No GPS</span>`;
  return html`${site ? html`${distance} m from ${site}` : 'Recorded'}${accuracy != null ? html` <span class="muted">(±${Math.round(accuracy)} m)</span>` : ''} ${mapLink(lat, lng)}`;
}

const isUnique = (err) => /UNIQUE/.test(String(err && err.message));

export function registerAdminRoutes(app, { render, form, requireSupervisor }) {
  app.use('/admin', requireSupervisor);
  app.use('/admin/*', requireSupervisor);

  // Payable hours use check-in/out rounded to the nearest quarter hour.
  const shiftHours = (s) => (s.check_out_at ? paidHours(s.check_in_at, s.check_out_at) : null);
  // Auto-closed shifts need a real check-out time before they can be approved.
  const approvable = (s) => s.check_out_at && s.status !== 'approved' && !hasFlag(s.flags, 'no_checkout');
  const activeWorkers = (db) => db.all("SELECT id, name FROM users WHERE role = 'worker' AND active = 1 ORDER BY name COLLATE NOCASE");

  /** Table of shifts with optional checkboxes for bulk approval. */
  function shiftTable(shifts, { showDate = false, back = '/admin' } = {}) {
    const selectable = shifts.some((s) => s.status === 'pending' && approvable(s));
    return html`
      <form method="post" action="/admin/shifts/approve" class="approve-form">
        <input type="hidden" name="back" value="${back}">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th class="check">${selectable ? html`<input type="checkbox" data-select-all aria-label="Select all">` : ''}</th>
                ${showDate ? html`<th>Date</th>` : ''}
                <th>Worker</th><th>In</th><th>Out</th><th class="num">Hours</th><th>Checks</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              ${shifts.map((s) => html`
                <tr>
                  <td class="check">${s.status === 'pending' && approvable(s) ? html`<input type="checkbox" name="ids" value="${s.id}" aria-label="Select shift">` : ''}</td>
                  ${showDate ? html`<td>${prettyDate(s.work_date)}</td>` : ''}
                  <td>${s.name}${s.in_device_label ? html`<div class="muted small">📱 ${deviceName(s.in_device_label, s.in_device_key)}</div>` : ''}</td>
                  <td>${clockTime(s.check_in_at)}</td>
                  <td>${s.check_out_at ? clockTime(s.check_out_at) : html`<span class="muted">${formatDuration(Date.now() - Date.parse(s.check_in_at))} so far</span>`}${s.check_out_at && localDate(s.check_out_at) !== s.work_date ? html` <small class="muted">(+1)</small>` : ''}</td>
                  <td class="num">${s.check_out_at ? fmtHours(shiftHours(s)) : '—'}</td>
                  <td>${flagList(s.flags, { lateMin: minutesLate(s) }) || html`<span class="ok-check" title="All checks passed">✓</span>`}</td>
                  <td>${statusBadge(s)}${s.reviewer_name ? html`<div class="muted small">${s.reviewer_name}</div>` : ''}</td>
                  <td><a href="/admin/shifts/${s.id}">View</a></td>
                </tr>`)}
            </tbody>
          </table>
        </div>
        ${selectable ? html`
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">Approve selected</button>
            <span class="muted small">Flagged shifts: open “View” to check the location and phone before approving.</span>
          </div>` : ''}
      </form>`;
  }

  // ---------- Dashboard ----------
  app.get('/admin', async (c) => {
    const db = c.get('db');
    const today = localDate();
    const q = c.req.query('date');
    const date = isDate(q) ? q : today;
    const workers = await activeWorkers(db);
    const shifts = await db.all(`
      SELECT s.*, u.name, r.name AS reviewer_name, ${DEVICE_COLUMNS} FROM shifts s
      JOIN users u ON u.id = s.user_id LEFT JOIN users r ON r.id = s.reviewed_by ${DEVICE_JOINS}
      WHERE s.work_date = ? ORDER BY s.check_in_at
    `, date);

    const byUser = new Map();
    for (const s of shifts) {
      if (!byUser.has(s.user_id)) byUser.set(s.user_id, []);
      byUser.get(s.user_id).push(s);
    }
    const settings = await getSettings(db);
    // With a roster for the day, "not clocked in" only lists people rostered to work; the rest are off.
    const rosterRows = settings.schedule_mode === 'off' ? [] : await db.all('SELECT * FROM roster WHERE work_date = ? ORDER BY start_time', date);
    const rostered = new Map();
    for (const r of rosterRows) {
      if (!rostered.has(r.user_id)) rostered.set(r.user_id, []);
      rostered.get(r.user_id).push(r);
    }
    const working = []; const done = []; const absent = []; const off = [];
    for (const w of workers) {
      const list = byUser.get(w.id) || [];
      const open = list.find((s) => !s.check_out_at);
      if (!list.length && rosterRows.length && !rostered.has(w.id)) off.push(w);
      else if (!list.length) absent.push({ ...w, roster: rostered.get(w.id) || [] });
      else if (open) working.push({ w, open });
      else done.push({ w, hours: list.reduce((a, s) => a + shiftHours(s), 0), last: list[list.length - 1].check_out_at });
    }
    const pendingCount = shifts.filter((s) => s.check_out_at && s.status === 'pending').length;
    const staleOpen = await db.all(`
      SELECT s.*, u.name FROM shifts s JOIN users u ON u.id = s.user_id
      WHERE s.check_out_at IS NULL AND s.work_date < ? ORDER BY s.check_in_at
    `, today);
    const otherPending = (await db.get("SELECT COUNT(*) AS n FROM shifts WHERE status = 'pending' AND check_out_at IS NOT NULL AND work_date <> ?", date)).n;
    const back = `/admin?date=${date}`;
    const graceMs = (Number(settings.late_grace_min) || 0) * 60000;
    /** "rostered 10:00-14:00", "late 12m" once the current rostered shift has started, or "missed". */
    const dueLabel = (w) => {
      if (!w.roster.length) return '';
      const times = formatRanges(w.roster);
      const slots = w.roster.map((r) => slotTimes(date, r.start_time, r.end_time));
      const current = slots.find((x) => Date.now() <= Date.parse(x.endIso));
      if (!current) return html`<span class="flag">missed</span> <span class="muted small">${times}</span>`;
      const lateMs = Date.now() - Date.parse(current.startIso);
      if (lateMs > graceMs) return html`<span class="flag">late ${formatDuration(lateMs)}</span> <span class="muted small">${times}</span>`;
      return html`<span class="muted small">rostered ${times}</span>`;
    };
    const alertCount = Number(settings.device_alert_count) || 0;
    const deviceChangers = alertCount >= 2 ? await frequentDeviceChangers(db, alertCount) : [];
    const phonesToReview = settings.device_mode === 'off' ? [] : await db.all(`
      SELECT wd.user_id, u.name, d.label, d.device_key FROM worker_devices wd
      JOIN users u ON u.id = wd.user_id JOIN devices d ON d.id = wd.device_id
      WHERE wd.status = 'pending' AND u.active = 1 ORDER BY wd.created_at
    `);

    return render(c, {
      title: 'Dashboard',
      active: 'dashboard',
      body: html`
        <div class="row-between page-head">
          <h1>${date === today ? 'Today' : prettyDate(date)}</h1>
          <form method="get" action="/admin" class="date-nav">
            <a class="btn btn-small" href="/admin?date=${addDays(date, -1)}" aria-label="Previous day">‹</a>
            <input type="date" name="date" value="${date}" data-autosubmit>
            <a class="btn btn-small" href="/admin?date=${addDays(date, 1)}" aria-label="Next day">›</a>
            ${date !== today ? html`<a class="btn btn-small" href="/admin">Today</a>` : ''}
          </form>
        </div>

        <div class="stats">
          <div class="stat stat-blue"><span class="stat-num">${working.length}</span><span class="stat-label">Working now</span></div>
          <div class="stat stat-green"><span class="stat-num">${done.length}</span><span class="stat-label">Clocked out</span></div>
          <div class="stat stat-grey"><span class="stat-num">${absent.length}</span><span class="stat-label">Not clocked in</span></div>
          <div class="stat stat-amber"><span class="stat-num">${pendingCount}</span><span class="stat-label">To approve</span></div>
        </div>

        ${staleOpen.length ? html`
          <div class="alert alert-warn">
            <strong>${staleOpen.length} worker${staleOpen.length > 1 ? 's' : ''} never clocked out on an earlier day:</strong>
            ${staleOpen.map((s, i) => html`${i ? ', ' : ' '}<a href="/admin/shifts/${s.id}">${s.name} (${prettyDate(s.work_date)})</a>`)}.
            Open the shift to enter the correct check-out time.
          </div>` : ''}
        ${deviceChangers.length ? html`
          <div class="alert alert-error">
            <strong>🚩 Frequent phone changes (last 30 days):</strong>
            ${deviceChangers.map((w, i) => html`${i ? ', ' : ' '}<a href="/admin/people/${w.id}#devices">${w.name} (${w.n} phones)</a>`)}.
            Someone else may be clocking in for them.
          </div>` : ''}
        ${phonesToReview.length ? html`
          <div class="alert alert-warn">
            <strong>📱 Unregistered phones to review:</strong>
            ${phonesToReview.map((x, i) => html`${i ? ', ' : ' '}<a href="/admin/people/${x.user_id}#devices">${x.name} — ${deviceName(x.label, x.device_key)}</a>`)}.
            Register it if the worker changed phone; otherwise check with them.
          </div>` : ''}
        ${otherPending ? html`
          <div class="alert alert-info">${otherPending} completed shift${otherPending > 1 ? 's' : ''} on other days still waiting for approval. <a href="/admin/pending">Review →</a></div>` : ''}

        <section class="card">
          <h2>Check-ins ${date === today ? 'today' : 'on this day'}</h2>
          ${shifts.length ? shiftTable(shifts, { back }) : html`<p class="muted">No check-ins yet.</p>`}
        </section>

        <section class="roster">
          <div class="card">
            <h2>Not clocked in <span class="count">${absent.length}</span></h2>
            ${absent.length ? html`<ul class="people-list">
              ${absent.map((w) => html`<li><span>${w.name} ${dueLabel(w)}</span><a class="small" href="/admin/shifts/new?user_id=${w.id}&date=${date}">+ add shift</a></li>`)}
            </ul>` : html`<p class="muted">Everyone has clocked in.</p>`}
            ${off.length ? html`<p class="muted small">Off (not rostered): ${off.map((w) => w.name).join(', ')}</p>` : ''}
          </div>
          <div class="card">
            <h2>Working now <span class="count">${working.length}</span></h2>
            ${working.length ? html`<ul class="people-list">
              ${working.map(({ w, open }) => html`<li><span>${w.name}</span><span class="muted">since ${localTime(open.check_in_at)} · ${formatDuration(Date.now() - Date.parse(open.check_in_at))}</span></li>`)}
            </ul>` : html`<p class="muted">Nobody is clocked in.</p>`}
          </div>
          <div class="card">
            <h2>Clocked out <span class="count">${done.length}</span></h2>
            ${done.length ? html`<ul class="people-list">
              ${done.map(({ w, hours, last }) => html`<li><span>${w.name}</span><span class="muted">out ${localTime(last)} · ${fmtHours(hours)} h</span></li>`)}
            </ul>` : html`<p class="muted">Nobody yet.</p>`}
          </div>
        </section>`,
    });
  });

  // ---------- All pending approvals ----------
  app.get('/admin/pending', async (c) => {
    const shifts = await c.get('db').all(`
      SELECT s.*, u.name, ${DEVICE_COLUMNS} FROM shifts s JOIN users u ON u.id = s.user_id ${DEVICE_JOINS}
      WHERE s.status = 'pending' AND s.check_out_at IS NOT NULL
      ORDER BY s.work_date, s.check_in_at
    `);
    return render(c, {
      title: 'Approvals',
      active: 'pending',
      body: html`
        <div class="page-head"><h1>Waiting for approval</h1></div>
        <section class="card">
          ${shifts.length
            ? shiftTable(shifts, { showDate: true, back: '/admin/pending' })
            : html`<p class="muted">All caught up — nothing to approve. 🎉</p>`}
        </section>`,
    });
  });

  // ---------- Approve / reject ----------
  app.post('/admin/shifts/approve', async (c) => {
    const db = c.get('db');
    const b = await form(c);
    const ids = toIds(b.ids);
    const back = safeBack(b.back);
    if (!ids.length) return c.redirect(withMsg(back, 'Nothing selected.'));
    const userId = c.get('user').id;
    const now = new Date().toISOString();
    let n = 0;
    // D1 allows at most 100 bound values per query, so approve in chunks.
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      const { rows } = await db.run(`
        UPDATE shifts SET status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = NULL
        WHERE id IN (${chunk.map(() => '?').join(',')}) AND check_out_at IS NOT NULL AND status <> 'approved'
          AND (',' || flags || ',') NOT LIKE '%,no_checkout,%'
        RETURNING id
      `, userId, now, ...chunk);
      await db.batch(rows.map((r) => auditStmt(r.id, userId, 'approve')));
      n += rows.length;
    }
    return c.redirect(withMsg(back, `Approved ${n} shift${n === 1 ? '' : 's'}.`));
  });

  function loadShift(db, id) {
    return db.get(`
      SELECT s.*, u.name, u.login, r.name AS reviewer_name, ${DEVICE_COLUMNS} FROM shifts s
      JOIN users u ON u.id = s.user_id LEFT JOIN users r ON r.id = s.reviewed_by ${DEVICE_JOINS}
      WHERE s.id = ?
    `, Number(id));
  }

  app.post('/admin/shifts/:id/reject', async (c) => {
    const db = c.get('db');
    const shift = await loadShift(db, c.req.param('id'));
    if (!shift) return c.notFound();
    if (!shift.check_out_at) return c.redirect(withMsg(`/admin/shifts/${shift.id}`, 'Enter a check-out time before rejecting.'));
    const b = await form(c);
    const note = String(b.review_note || '').trim().slice(0, 300) || null;
    const userId = c.get('user').id;
    await db.batch([
      ["UPDATE shifts SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?",
        userId, new Date().toISOString(), note, shift.id],
      auditStmt(shift.id, userId, 'reject', note),
    ]);
    return c.redirect(withMsg(`/admin/shifts/${shift.id}`, 'Shift rejected.'));
  });

  app.post('/admin/shifts/:id/reset', async (c) => {
    const db = c.get('db');
    const shift = await loadShift(db, c.req.param('id'));
    if (!shift) return c.notFound();
    await db.batch([
      ["UPDATE shifts SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL, review_note = NULL WHERE id = ?", shift.id],
      auditStmt(shift.id, c.get('user').id, 'reset_to_pending'),
    ]);
    return c.redirect(withMsg(`/admin/shifts/${shift.id}`, 'Shift set back to pending.'));
  });

  // ---------- Shift detail + edit ----------
  function shiftForm({ action, shift = null, workers = null, values, submitLabel }) {
    return html`
      <form method="post" action="${action}" class="stack">
        ${workers ? html`
          <label>Worker
            <select name="user_id" required>
              ${workers.map((w) => html`<option value="${w.id}" ${String(w.id) === String(values.user_id) ? 'selected' : ''}>${w.name}</option>`)}
            </select>
          </label>` : ''}
        <div class="grid-3">
          <label>Work date <input type="date" name="work_date" value="${values.work_date}" required></label>
          <label>Check-in <input type="time" name="in_time" value="${values.in_time}" required></label>
          <label>Check-out <input type="time" name="out_time" value="${values.out_time}" ${shift && !shift.check_out_at ? '' : 'required'}></label>
        </div>
        <p class="hint">Times are ${TZ} local time. A check-out earlier than the check-in is treated as the next day (overnight shift).</p>
        <label>Reason / note (saved in the audit log)
          <input name="reason" maxlength="300" value="${values.reason || ''}" placeholder="e.g. forgot to clock out, confirmed with worker">
        </label>
        <label class="checkbox"><input type="checkbox" name="approve" value="1" ${values.approve ? 'checked' : ''}> Approve after saving</label>
        <div><button type="submit" class="btn btn-primary">${submitLabel}</button></div>
      </form>`;
  }

  /** Parse + validate the edit/new shift form. Returns { error } or { inIso, outIso, date }. */
  function parseShiftTimes(b, { requireOut }) {
    const date = b.work_date;
    if (!isDate(date)) return { error: 'Enter a valid work date.' };
    if (!isTime(b.in_time)) return { error: 'Enter a valid check-in time.' };
    const inIso = localToUtcIso(date, b.in_time);
    let outIso = null;
    if (b.out_time) {
      if (!isTime(b.out_time)) return { error: 'Enter a valid check-out time.' };
      outIso = localToUtcIso(date, b.out_time);
      if (outIso <= inIso) outIso = localToUtcIso(addDays(date, 1), b.out_time);
    } else if (requireOut) {
      return { error: 'Enter a check-out time.' };
    }
    const soon = new Date(Date.now() + 5 * 60000).toISOString();
    if (inIso > soon || (outIso && outIso > soon)) return { error: "Times can't be in the future." };
    return { date, inIso, outIso };
  }

  app.get('/admin/shifts/new', async (c) => {
    const workers = await activeWorkers(c.get('db'));
    const qDate = c.req.query('date');
    return render(c, {
      title: 'Add shift',
      body: html`
        <div class="page-head"><h1>Add a shift manually</h1></div>
        <section class="card">
          <p class="muted">For workers who couldn't clock in themselves (no phone, flat battery…). The shift is marked “Added by supervisor”.</p>
          ${shiftForm({
            action: '/admin/shifts/new',
            workers,
            values: { user_id: c.req.query('user_id'), work_date: isDate(qDate) ? qDate : localDate(), in_time: '', out_time: '', approve: true },
            submitLabel: 'Add shift',
          })}
        </section>`,
    });
  });

  app.post('/admin/shifts/new', async (c) => {
    const db = c.get('db');
    const b = await form(c);
    const worker = await db.get("SELECT id FROM users WHERE id = ? AND role = 'worker'", Number(b.user_id));
    const t = parseShiftTimes(b, { requireOut: true });
    if (!worker || t.error) {
      const workers = await activeWorkers(db);
      return render(c, {
        title: 'Add shift',
        error: t.error || 'Choose a worker.',
        body: html`<div class="page-head"><h1>Add a shift manually</h1></div>
          <section class="card">${shiftForm({ action: '/admin/shifts/new', workers, values: b, submitLabel: 'Add shift' })}</section>`,
      }, 400);
    }
    const approve = b.approve === '1';
    const userId = c.get('user').id;
    const now = new Date().toISOString();
    const { lastId: id } = await db.run(`
      INSERT INTO shifts (user_id, work_date, check_in_at, check_out_at, flags, status, reviewed_by, reviewed_at)
      VALUES (?, ?, ?, ?, 'manual', ?, ?, ?)
    `, worker.id, t.date, t.inIso, t.outIso, approve ? 'approved' : 'pending', approve ? userId : null, approve ? now : null);
    await db.batch([
      auditStmt(id, userId, 'manual_add', String(b.reason || '').slice(0, 300) || null),
      ...(approve ? [auditStmt(id, userId, 'approve')] : []),
    ]);
    return c.redirect(withMsg(`/admin/shifts/${id}`, 'Shift added.'));
  });

  /** Device line for the shift page: name, when first seen, and other workers who used it. */
  async function deviceDetail(db, deviceId, label, key, userId) {
    if (!deviceId) return html`<p class="muted">📱 Device not recorded</p>`;
    const dev = await db.get('SELECT first_seen FROM devices WHERE id = ?', deviceId);
    const { names: others } = await db.get(`
      SELECT GROUP_CONCAT(DISTINCT u.name) AS names FROM shifts s JOIN users u ON u.id = s.user_id
      WHERE (s.in_device_id = ? OR s.out_device_id = ?) AND s.user_id <> ?
    `, deviceId, deviceId, userId);
    return html`
      <p>📱 <strong>${deviceName(label, key)}</strong><br>
        <span class="muted small">First seen ${localDateTime(dev.first_seen)}</span></p>
      ${others ? html`<p class="flag">Also used by: ${others.split(',').join(', ')}</p>` : ''}`;
  }

  async function shiftDetail(c, shift, { error = null, values = null } = {}, status = 200) {
    const db = c.get('db');
    const log = await db.all(`
      SELECT a.*, u.name AS actor FROM audit a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.shift_id = ? ORDER BY a.at, a.id
    `, shift.id);
    const inDevice = await deviceDetail(db, shift.in_device_id, shift.in_device_label, shift.in_device_key, shift.user_id);
    const outDevice = await deviceDetail(db, shift.out_device_id, shift.out_device_label, shift.out_device_key, shift.user_id);
    const hrs = shiftHours(shift);
    const photo = await db.get('SELECT id, taken_at FROM photos WHERE shift_id = ? ORDER BY taken_at DESC LIMIT 1', shift.id);
    const v = values || {
      work_date: shift.work_date,
      in_time: localTime(shift.check_in_at),
      out_time: shift.check_out_at && !hasFlag(shift.flags, 'no_checkout') ? localTime(shift.check_out_at) : '',
      approve: true,
    };
    return render(c, {
      title: `Shift · ${shift.name}`,
      error,
      body: html`
        <div class="row-between page-head">
          <h1>${shift.name} <span class="muted">· ${prettyDate(shift.work_date)}</span></h1>
          <a href="/admin?date=${shift.work_date}">← Back to day</a>
        </div>

        <section class="card">
          <div class="detail-grid">
            <div><span class="label">Check-in</span><strong>${localDateTime(shift.check_in_at)}</strong></div>
            <div><span class="label">Check-out</span><strong>${shift.check_out_at ? localDateTime(shift.check_out_at) : 'Still clocked in'}</strong></div>
            <div><span class="label">Hours (for pay)</span><strong>${hrs != null ? html`${fmtHours(hrs)} <span class="muted small">(${formatHM(hrs)})</span>` : '—'}</strong>
              ${hrs != null && ROUND_MINUTES ? html`<div class="small muted">Counted ${localTime(roundTime(shift.check_in_at))}–${localTime(roundTime(shift.check_out_at))} · actual ${formatHM(hoursBetween(shift.check_in_at, shift.check_out_at))}</div>` : ''}
            </div>
            <div><span class="label">Status</span>${statusBadge(shift)}
              ${shift.reviewer_name ? html`<div class="small muted">by ${shift.reviewer_name}, ${localDateTime(shift.reviewed_at)}</div>` : ''}
              ${shift.review_note ? html`<div class="small">“${shift.review_note}”</div>` : ''}
            </div>
          </div>
          ${shift.sched_start ? html`<p><span class="label">Rostered</span> ${localTime(shift.sched_start)}–${localTime(shift.sched_end)}${minutesLate(shift) ? html` · clocked in ${minutesLate(shift)} min after the start` : ''}</p>` : ''}
          ${shift.flags ? html`<p>${flagList(shift.flags, { lateMin: minutesLate(shift) })}</p>` : ''}
          ${shift.worker_note ? html`<p><span class="label">Worker note</span> ${shift.worker_note}</p>` : ''}

          ${hasFlag(shift.flags, 'no_checkout') ? html`<p class="alert alert-warn">This worker never clocked out. Enter the real check-out time below before approving.</p>` : ''}
          ${shift.check_out_at ? html`
            <div class="action-row">
              ${approvable(shift) ? html`
                <form method="post" action="/admin/shifts/approve">
                  <input type="hidden" name="ids" value="${shift.id}">
                  <input type="hidden" name="back" value="/admin/shifts/${shift.id}">
                  <button class="btn btn-primary" type="submit">Approve</button>
                </form>` : ''}
              ${shift.status !== 'rejected' ? html`
                <form method="post" action="/admin/shifts/${shift.id}/reject" class="inline-form">
                  <input name="review_note" maxlength="300" placeholder="Reason for rejecting (shown to worker)">
                  <button class="btn btn-danger" type="submit" data-confirm="Reject this shift?">Reject</button>
                </form>` : ''}
              ${shift.status !== 'pending' ? html`
                <form method="post" action="/admin/shifts/${shift.id}/reset">
                  <button class="btn" type="submit">Set back to pending</button>
                </form>` : ''}
            </div>` : html`<p class="alert alert-warn">This worker hasn't clocked out. Enter the check-out time below to close the shift.</p>`}
        </section>

        <section class="grid-2">
          <div class="card">
            <h2>Check-in verification</h2>
            ${photo ? html`<p><img class="selfie" src="/admin/photos/${photo.id}" alt="Selfie taken at check-in" loading="lazy"></p>` : ''}
            <p>${locationSummary(shift.in_site, shift.in_distance_m, shift.in_accuracy, shift.in_lat, shift.in_lng)}</p>
            ${inDevice}
            ${shift.in_ip ? html`<p class="muted small">IP ${shift.in_ip}</p>` : ''}
          </div>
          <div class="card">
            <h2>Check-out verification</h2>
            ${shift.check_out_at ? html`
              <p>${locationSummary(shift.out_site, shift.out_distance_m, shift.out_accuracy, shift.out_lat, shift.out_lng)}</p>
              ${outDevice}
              ${shift.out_ip ? html`<p class="muted small">IP ${shift.out_ip}</p>` : ''}
            ` : html`<p class="muted">Not clocked out yet.</p>`}
          </div>
        </section>

        <section class="card">
          <h2>${shift.check_out_at ? 'Correct times' : 'Close shift'}</h2>
          ${shiftForm({ action: `/admin/shifts/${shift.id}/edit`, shift, values: v, submitLabel: 'Save' })}
        </section>

        <section class="card">
          <h2>History</h2>
          <ul class="audit">
            ${log.map((a) => html`<li><span class="muted">${localDateTime(a.at)}</span> <strong>${a.actor || 'System'}</strong> ${a.action.replace(/_/g, ' ')}${a.detail ? html` — ${a.detail}` : ''}</li>`)}
          </ul>
        </section>`,
    }, status);
  }

  app.get('/admin/shifts/:id', async (c) => {
    const shift = await loadShift(c.get('db'), c.req.param('id'));
    if (!shift) return c.notFound();
    return shiftDetail(c, shift);
  });

  app.post('/admin/shifts/:id/edit', async (c) => {
    const db = c.get('db');
    const shift = await loadShift(db, c.req.param('id'));
    if (!shift) return c.notFound();
    const b = await form(c);
    const t = parseShiftTimes(b, { requireOut: !!shift.check_out_at });
    if (t.error) return shiftDetail(c, shift, { error: t.error, values: b }, 400);

    const changes = [];
    if (t.date !== shift.work_date) changes.push(`date ${shift.work_date} → ${t.date}`);
    if (t.inIso !== shift.check_in_at) changes.push(`in ${localDateTime(shift.check_in_at)} → ${localDateTime(t.inIso)}`);
    if (t.outIso !== shift.check_out_at) changes.push(`out ${shift.check_out_at ? localDateTime(shift.check_out_at) : '—'} → ${t.outIso ? localDateTime(t.outIso) : '—'}`);
    const reason = String(b.reason || '').trim().slice(0, 300);
    const approve = b.approve === '1' && !!t.outIso && (changes.length > 0 || !hasFlag(shift.flags, 'no_checkout'));
    const userId = c.get('user').id;
    const now = new Date().toISOString();

    const stmts = [];
    if (changes.length) {
      stmts.push([`
        UPDATE shifts SET work_date = ?, check_in_at = ?, check_out_at = ?, flags = ?,
          status = 'pending', reviewed_by = NULL, reviewed_at = NULL, review_note = NULL
        WHERE id = ?
      `, t.date, t.inIso, t.outIso, addFlags(removeFlags(shift.flags, 'no_checkout'), 'edited'), shift.id]);
      stmts.push(auditStmt(shift.id, userId, 'edit', changes.join('; ') + (reason ? ` (${reason})` : '')));
    }
    if (approve && (changes.length || shift.status !== 'approved')) {
      stmts.push(["UPDATE shifts SET status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = NULL WHERE id = ?", userId, now, shift.id]);
      stmts.push(auditStmt(shift.id, userId, 'approve'));
    }
    await db.batch(stmts);
    return c.redirect(withMsg(`/admin/shifts/${shift.id}`, changes.length ? 'Shift updated.' : approve ? 'Shift approved.' : 'No changes.'));
  });

  // ---------- People ----------
  function personFields(values = {}, { isNew }) {
    return html`
      <div class="grid-2">
        <label>Full name <input name="name" value="${values.name || ''}" required maxlength="100"></label>
        <label>Phone / Staff ID (used to sign in)
          <input name="login" value="${values.login || ''}" required maxlength="50" autocapitalize="none">
        </label>
        <label>Short name (optional, also used to sign in)
          <input name="short_name" value="${values.short_name || ''}" maxlength="12" autocapitalize="characters" placeholder="e.g. KML">
          <span class="hint">Initials or a nickname: 2–12 letters or digits, easier to type than a phone number.</span>
        </label>
        <label>Role
          <select name="role" data-role-select>
            <option value="worker" ${values.role !== 'supervisor' ? 'selected' : ''}>Worker</option>
            <option value="supervisor" ${values.role === 'supervisor' ? 'selected' : ''}>Supervisor</option>
          </select>
        </label>
        <label>Hourly rate (optional, for pay estimate)
          <input name="hourly_rate" type="number" step="0.01" min="0" value="${values.hourly_rate ?? ''}">
        </label>
        <label>${isNew ? 'PIN / password' : 'New PIN / password (leave blank to keep)'}
          <input name="secret" type="password" autocomplete="new-password" ${isNew ? 'required' : ''} minlength="4">
          <span class="hint">Workers: at least 4 digits. Supervisors: at least 8 characters.</span>
        </label>
      </div>`;
  }

  function validatePerson(b, { isNew }) {
    const v = {
      name: String(b.name || '').trim(),
      login: String(b.login || '').trim(),
      short_name: String(b.short_name || '').trim() || null,
      role: b.role === 'supervisor' ? 'supervisor' : 'worker',
      hourly_rate: b.hourly_rate === '' || b.hourly_rate === undefined ? null : Number(b.hourly_rate),
      secret: String(b.secret || ''),
    };
    if (!v.name || !v.login) return { v, error: 'Name and phone/staff ID are required.' };
    if (v.hourly_rate !== null && !(v.hourly_rate >= 0)) return { v, error: 'Hourly rate must be a positive number.' };
    if (v.short_name && !/^[A-Za-z0-9]{2,12}$/.test(v.short_name)) return { v, error: 'Short name: 2–12 letters or digits, no spaces.' };
    if (isNew || v.secret) {
      if (v.role === 'supervisor' && v.secret.length < 8) return { v, error: 'Supervisor passwords need at least 8 characters.' };
      if (v.role === 'worker' && v.secret.length < 4) return { v, error: 'Worker PINs need at least 4 characters.' };
    }
    return { v };
  }

  /** A login name or short name must not match anyone else's, or sign-in would be ambiguous. */
  async function signInClash(db, v, selfId = 0) {
    const names = [v.login, v.short_name].filter(Boolean);
    const marks = names.map(() => '?').join(',');
    const other = await db.get(
      `SELECT name FROM users WHERE id <> ? AND (login IN (${marks}) OR short_name IN (${marks})) LIMIT 1`,
      selfId, ...names, ...names,
    );
    return other ? `That phone/staff ID or short name is already used by ${other.name}.` : null;
  }

  async function peoplePage(c, { error = null, values = {} } = {}, status = 200) {
    const db = c.get('db');
    const people = await db.all(`
      SELECT u.*, (SELECT MAX(check_in_at) FROM shifts WHERE user_id = u.id) AS last_seen
      FROM users u ORDER BY u.active DESC, u.role DESC, u.name COLLATE NOCASE
    `);
    const limit = Number((await getSettings(db)).device_alert_count) || 0;
    const phones = new Map();
    for (const p of people) if (p.role === 'worker') phones.set(p.id, await recentDeviceCount(db, p.id));
    const phoneCount = (id) => {
      const n = phones.get(id);
      return limit >= 2 && n >= limit ? html`<span class="flag">🚩 ${n}</span>` : n;
    };
    return render(c, {
      title: 'People',
      active: 'people',
      error,
      body: html`
        <div class="page-head"><h1>People</h1></div>
        <section class="card">
          <h2>Add a person</h2>
          <form method="post" action="/admin/people" class="stack">
            ${personFields(values, { isNew: true })}
            <div><button class="btn btn-primary" type="submit">Add</button></div>
          </form>
          <p class="hint">Share the site link with the worker plus their phone/staff ID and PIN. On their phone they can “Add to Home Screen” so it opens like an app.</p>
        </section>
        <section class="card">
          <div class="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Sign-in ID</th><th>Role</th><th class="num">Rate</th><th>Last check-in</th><th class="num">Phones (30 days)</th><th>Status</th><th></th></tr></thead>
              <tbody>
                ${people.map((p) => html`
                  <tr class="${p.active ? '' : 'inactive'}">
                    <td>${p.name}</td><td>${p.login}${p.short_name ? html` <span class="muted">· ${p.short_name}</span>` : ''}</td>
                    <td>${p.role === 'supervisor' ? 'Supervisor' : 'Worker'}</td>
                    <td class="num">${p.hourly_rate != null ? fmtMoney(p.hourly_rate) : '—'}</td>
                    <td>${p.last_seen ? localDateTime(p.last_seen) : '—'}</td>
                    <td class="num">${p.role === 'worker' ? phoneCount(p.id) : ''}</td>
                    <td>${p.active ? 'Active' : 'Inactive'}</td>
                    <td><a href="/admin/people/${p.id}">Edit</a></td>
                  </tr>`)}
              </tbody>
            </table>
          </div>
        </section>`,
    }, status);
  }

  app.get('/admin/people', (c) => peoplePage(c));

  app.post('/admin/people', async (c) => {
    const { v, error } = validatePerson(await form(c), { isNew: true });
    if (error) return peoplePage(c, { error, values: v }, 400);
    const clash = await signInClash(c.get('db'), v);
    if (clash) return peoplePage(c, { error: clash, values: v }, 400);
    try {
      await c.get('db').run('INSERT INTO users (name, login, short_name, secret_hash, role, hourly_rate) VALUES (?, ?, ?, ?, ?, ?)',
        v.name, v.login, v.short_name, await hashSecret(v.secret), v.role, v.hourly_rate);
    } catch (err) {
      if (isUnique(err)) return peoplePage(c, { error: 'That phone/staff ID or short name is already in use.', values: v }, 400);
      throw err;
    }
    return c.redirect(withMsg('/admin/people', `${v.name} added.`));
  });

  async function devicesCard(db, person) {
    const used = '(s.in_device_id = d.id OR s.out_device_id = d.id)';
    const devices = await db.all(`
      SELECT d.id, d.label, d.device_key, wd.status, wd.reviewed_at, r.name AS reviewer,
        (SELECT MIN(s.check_in_at) FROM shifts s WHERE s.user_id = ?1 AND ${used}) AS first_used,
        (SELECT MAX(s.check_in_at) FROM shifts s WHERE s.user_id = ?1 AND ${used}) AS last_used,
        (SELECT COUNT(*) FROM shifts s WHERE s.user_id = ?1 AND ${used}) AS shifts,
        (SELECT GROUP_CONCAT(DISTINCT u2.name) FROM shifts s JOIN users u2 ON u2.id = s.user_id
          WHERE ${used} AND s.user_id <> ?1) AS others
      FROM devices d
      LEFT JOIN worker_devices wd ON wd.device_id = d.id AND wd.user_id = ?1
      LEFT JOIN users r ON r.id = wd.reviewed_by
      WHERE wd.user_id IS NOT NULL OR EXISTS (SELECT 1 FROM shifts s WHERE s.user_id = ?1 AND ${used})
      ORDER BY wd.status = 'approved' DESC, last_used DESC
    `, person.id);
    const n = await recentDeviceCount(db, person.id);
    const limit = Number((await getSettings(db)).device_alert_count) || 0;
    const statusLabel = (d) => {
      if (d.status === 'approved') return html`<span class="badge badge-approved">Registered</span>${d.reviewer ? html`<div class="muted small">by ${d.reviewer}</div>` : html`<div class="muted small">first phone used</div>`}`;
      if (d.status === 'pending') return html`<span class="badge badge-pending">To review</span>`;
      return html`<span class="badge badge-rejected">Not registered</span>`;
    };
    const action = (d, act, label, cls = 'btn btn-small') => html`
      <form method="post" action="/admin/people/${person.id}/devices/${d.id}">
        <input type="hidden" name="action" value="${act}">
        <button class="${cls}" type="submit">${label}</button>
      </form>`;
    return html`
      <section class="card" id="devices">
        <div class="row-between">
          <h2>Phones</h2>
          <span class="${limit >= 2 && n >= limit ? 'flag' : 'muted'}">${n} different phone${n === 1 ? '' : 's'} in the last 30 days</span>
        </div>
        ${devices.length ? html`
          <div class="table-wrap"><table>
            <thead><tr><th>Device</th><th>Status</th><th>Used</th><th>Also used by</th><th></th></tr></thead>
            <tbody>${devices.map((d) => html`
              <tr>
                <td>📱 ${deviceName(d.label, d.device_key)}</td>
                <td>${statusLabel(d)}</td>
                <td>${d.shifts ? html`${d.shifts} shift${d.shifts === 1 ? '' : 's'}<div class="muted small">${localDate(d.first_used) === localDate(d.last_used) ? localDateTime(d.last_used) : html`${prettyDate(localDate(d.first_used))} – ${prettyDate(localDate(d.last_used))}`}</div>` : html`<span class="muted">Blocked attempt only</span>`}</td>
                <td>${d.others ? html`<span class="flag">${d.others.split(',').join(', ')}</span>` : html`<span class="muted">—</span>`}</td>
                <td><div class="action-row tight">
                  ${d.status !== 'approved' ? action(d, 'approve', 'Register') : action(d, 'remove', 'Unregister', 'btn-link danger')}
                  ${d.status === 'pending' ? action(d, 'dismiss', 'Ignore', 'btn-link') : ''}
                </div></td>
              </tr>`)}
            </tbody>
          </table></div>
          <p class="hint">Only supervisors can see this. The first phone a worker uses is registered automatically; check-ins from any other phone are flagged.
            When a worker genuinely gets a new phone, tap <strong>Register</strong> (and unregister the old one).
            A one-off new phone can be innocent (cleared browser data, private browsing, a different browser), but frequent changes or a phone shared with another worker are red flags.</p>`
        : html`<p class="muted">No check-ins yet.</p>`}
      </section>`;
  }

  async function personPage(c, person, { error = null, values = null } = {}, status = 200) {
    const devices = person.role === 'worker' ? await devicesCard(c.get('db'), person) : '';
    return render(c, {
      title: `Edit ${person.name}`,
      active: 'people',
      error,
      body: html`
        <div class="row-between page-head"><h1>${person.name}</h1><a href="/admin/people">← All people</a></div>
        <section class="card">
          <form method="post" action="/admin/people/${person.id}" class="stack">
            ${personFields(values || person, { isNew: false })}
            <label class="checkbox"><input type="checkbox" name="active" value="1" ${(values ? values.active : person.active) ? 'checked' : ''}> Active (can sign in and appears on the dashboard)</label>
            <div><button class="btn btn-primary" type="submit">Save</button></div>
          </form>
        </section>
        ${devices}`,
    }, status);
  }

  app.post('/admin/people/:id/devices/:deviceId', async (c) => {
    const db = c.get('db');
    const userId = Number(c.req.param('id'));
    const deviceId = Number(c.req.param('deviceId'));
    const person = await db.get("SELECT id, name FROM users WHERE id = ? AND role = 'worker'", userId);
    const device = await db.get('SELECT id FROM devices WHERE id = ?', deviceId);
    if (!person || !device) return c.notFound();
    const b = await form(c);
    const status = { approve: 'approved', dismiss: 'dismissed', remove: 'dismissed' }[b.action];
    if (!status) return c.text('Bad request', 400);
    const now = new Date().toISOString();
    await db.run(`
      INSERT INTO worker_devices (user_id, device_id, status, created_at, reviewed_by, reviewed_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, device_id) DO UPDATE SET status = excluded.status, reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at
    `, userId, deviceId, status, now, c.get('user').id, now);
    const msg = { approve: 'Phone registered.', dismiss: 'Phone kept unregistered — check-ins from it stay flagged.', remove: 'Phone unregistered.' }[b.action];
    return c.redirect(withMsg(`/admin/people/${userId}`, msg) + '#devices');
  });

  app.get('/admin/people/:id', async (c) => {
    const person = await c.get('db').get('SELECT * FROM users WHERE id = ?', Number(c.req.param('id')));
    if (!person) return c.notFound();
    return personPage(c, person);
  });

  app.post('/admin/people/:id', async (c) => {
    const db = c.get('db');
    const person = await db.get('SELECT * FROM users WHERE id = ?', Number(c.req.param('id')));
    if (!person) return c.notFound();
    const b = await form(c);
    const { v, error } = validatePerson(b, { isNew: false });
    v.active = b.active === '1' ? 1 : 0;
    const self = person.id === c.get('user').id;
    if (error) return personPage(c, person, { error, values: v }, 400);
    const clash = await signInClash(db, v, person.id);
    if (clash) return personPage(c, person, { error: clash, values: v }, 400);
    if (self && (!v.active || v.role !== 'supervisor')) {
      return personPage(c, person, { error: "You can't deactivate yourself or remove your own supervisor role.", values: v }, 400);
    }
    if (v.role === 'supervisor' && person.role === 'worker'
      && await db.get('SELECT 1 AS x FROM shifts WHERE user_id = ? AND check_out_at IS NULL', person.id)) {
      return personPage(c, person, { error: 'This worker is still clocked in. Close their shift first.', values: v }, 400);
    }
    const stmts = [['UPDATE users SET name = ?, login = ?, short_name = ?, role = ?, hourly_rate = ?, active = ? WHERE id = ?',
      v.name, v.login, v.short_name, v.role, v.hourly_rate, v.active, person.id]];
    if (v.secret) stmts.push(['UPDATE users SET secret_hash = ? WHERE id = ?', await hashSecret(v.secret), person.id]);
    // Sign the person out everywhere if their access changed.
    if (!self && (v.secret || !v.active || v.role !== person.role)) stmts.push(['DELETE FROM sessions WHERE user_id = ?', person.id]);
    try {
      await db.batch(stmts);
    } catch (err) {
      if (isUnique(err)) return personPage(c, person, { error: 'That phone/staff ID or short name is already in use.', values: v }, 400);
      throw err;
    }
    return c.redirect(withMsg('/admin/people', `${v.name} saved.`));
  });

  // ---------- Selfies ----------
  app.get('/admin/photos/:id', async (c) => {
    const photo = await c.get('db').get('SELECT data FROM photos WHERE id = ?', Number(c.req.param('id')));
    if (!photo) return c.notFound();
    const bytes = Uint8Array.from(atob(photo.data), (ch) => ch.charCodeAt(0));
    return c.body(bytes, 200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
  });

  // ---------- Roster ----------
  const dayHead = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

  async function rosterPage(c, week, { error = null, values = null } = {}, status = 200) {
    const db = c.get('db');
    const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
    const workers = await activeWorkers(db);
    const rows = await db.all('SELECT * FROM roster WHERE work_date BETWEEN ? AND ? ORDER BY start_time', days[0], days[6]);
    const cell = (uid, d) => {
      if (values) return values[`r_${uid}_${d}`] ?? '';
      return formatRanges(rows.filter((r) => r.user_id === uid && r.work_date === d));
    };
    const perDay = days.map((d) => new Set(rows.filter((r) => r.work_date === d).map((r) => r.user_id)).size);
    const today = localDate();
    const mode = (await getSettings(db)).schedule_mode;
    return render(c, {
      title: 'Roster',
      active: 'roster',
      error,
      body: html`
        <div class="row-between page-head">
          <h1>Roster</h1>
          <div class="month-nav">
            <a class="btn btn-small" href="/admin/roster?week=${addDays(week, -7)}" aria-label="Previous week">‹</a>
            <strong>Week of ${prettyDate(week)}</strong>
            <a class="btn btn-small" href="/admin/roster?week=${addDays(week, 7)}" aria-label="Next week">›</a>
          </div>
        </div>
        ${mode === 'off' ? html`<div class="alert alert-warn">Roster checks are off, so clock-ins aren't compared with this roster. Turn them on in <a href="/admin/settings">Settings</a>.</div>` : ''}
        <section class="card">
          <form method="post" action="/admin/roster" class="stack">
            <input type="hidden" name="week" value="${week}">
            <div class="table-wrap">
              <table class="roster-table">
                <thead><tr><th>Worker</th>${days.map((d, i) => html`<th class="${d === today ? 'today' : ''}">${dayHead(d)}<div class="muted small">${perDay[i]} rostered</div></th>`)}</tr></thead>
                <tbody>
                  ${workers.map((w) => html`
                    <tr>
                      <td>${w.name}</td>
                      ${days.map((d) => html`<td class="${d === today ? 'today' : ''}"><input name="r_${w.id}_${d}" value="${cell(w.id, d)}" aria-label="${w.name} ${dayHead(d)}" placeholder="off" autocomplete="off"></td>`)}
                    </tr>`)}
                </tbody>
              </table>
            </div>
            <p class="hint">Type the hours, e.g. <strong>10-15</strong>, <strong>10:00-15:00</strong> or <strong>6pm-11pm</strong>. Split shift: <strong>10-14, 17-22</strong>. Past midnight: <strong>18:00-01:00</strong>. Leave blank for a day off.</p>
            <div class="action-row">
              <button class="btn btn-primary" type="submit">Save roster</button>
            </div>
          </form>
          <form method="post" action="/admin/roster/copy" class="action-row">
            <input type="hidden" name="week" value="${week}">
            <button class="btn" type="submit" data-confirm="Replace this week's roster with last week's?">Copy last week</button>
          </form>
        </section>`,
    }, status);
  }

  const weekParam = (q) => weekStart(isDate(q) ? q : localDate());

  app.get('/admin/roster', (c) => rosterPage(c, weekParam(c.req.query('week'))));

  app.post('/admin/roster', async (c) => {
    const db = c.get('db');
    const b = await form(c);
    const week = weekParam(b.week);
    const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
    const workers = await activeWorkers(db);
    const stmts = [];
    for (const w of workers) {
      if (!days.some((d) => `r_${w.id}_${d}` in b)) continue; // not on the form (added since it was opened)
      stmts.push(['DELETE FROM roster WHERE user_id = ? AND work_date BETWEEN ? AND ?', w.id, days[0], days[6]]);
      for (const d of days) {
        const parsed = parseRanges(b[`r_${w.id}_${d}`]);
        if (parsed.error) return rosterPage(c, week, { error: `${w.name}, ${dayHead(d)}: ${parsed.error}`, values: b }, 400);
        for (const r of parsed.ranges) {
          stmts.push(['INSERT INTO roster (user_id, work_date, start_time, end_time) VALUES (?, ?, ?, ?)', w.id, d, r.start, r.end]);
        }
      }
    }
    await db.batch(stmts);
    return c.redirect(withMsg(`/admin/roster?week=${week}`, 'Roster saved.'));
  });

  app.post('/admin/roster/copy', async (c) => {
    const db = c.get('db');
    const week = weekParam((await form(c)).week);
    const from = addDays(week, -7);
    await db.batch([
      ['DELETE FROM roster WHERE work_date BETWEEN ? AND ?', week, addDays(week, 6)],
      [`INSERT INTO roster (user_id, work_date, start_time, end_time)
        SELECT r.user_id, date(r.work_date, '+7 days'), r.start_time, r.end_time FROM roster r
        JOIN users u ON u.id = r.user_id AND u.active = 1
        WHERE r.work_date BETWEEN ? AND ?`, from, addDays(from, 6)],
    ]);
    return c.redirect(withMsg(`/admin/roster?week=${week}`, 'Copied last week’s roster.'));
  });

  // ---------- Settings ----------
  app.get('/admin/settings', async (c) => {
    const db = c.get('db');
    const s = await getSettings(db);
    const sites = await db.all('SELECT * FROM sites ORDER BY name');
    const opt = (name, value, label) => html`<option value="${value}" ${s[name] === value ? 'selected' : ''}>${label}</option>`;
    return render(c, {
      title: 'Settings',
      active: 'settings',
      scripts: ['/settings.js'],
      body: html`
        <div class="page-head"><h1>Settings</h1></div>

        <section class="card">
          <h2>Check-in verification</h2>
          <form method="post" action="/admin/settings" class="stack">
            <label>GPS location
              <select name="geofence_mode">
                ${opt('geofence_mode', 'flag', 'Record location, flag if outside a work site (recommended)')}
                ${opt('geofence_mode', 'block', 'Must be at a work site to clock in/out')}
                ${opt('geofence_mode', 'off', 'Off — don’t ask for location')}
              </select>
            </label>
            <label>Phone check
              <select name="device_mode">
                ${opt('device_mode', 'flag', 'Flag check-ins from a phone that isn’t registered to the worker (recommended)')}
                ${opt('device_mode', 'block', 'Only allow the worker’s registered phone')}
                ${opt('device_mode', 'off', 'Off — record the device only')}
              </select>
              <span class="hint">The first phone a worker uses is registered automatically. Register a new phone on the worker’s page under People.</span>
            </label>
            <label>Alert when a worker uses this many different phones in 30 days
              <input type="number" name="device_alert_count" min="2" max="20" value="${s.device_alert_count}">
            </label>
            <label>Selfie at clock-in
              <select name="selfie_mode">
                ${opt('selfie_mode', 'off', 'Off')}
                ${opt('selfie_mode', 'flag', 'Ask for a selfie; flag if skipped')}
                ${opt('selfie_mode', 'block', 'Selfie required to clock in')}
              </select>
              <span class="hint">Photos are small (about 30 KB), visible only to supervisors on the shift page, and deleted after ${PHOTO_KEEP_DAYS} days.</span>
            </label>
            <label>Venue WiFi (public IP address)
              <select name="ip_mode">
                ${opt('ip_mode', 'off', 'Off')}
                ${opt('ip_mode', 'flag', 'Flag check-ins not from the venue network')}
                ${opt('ip_mode', 'block', 'Must be on the venue network')}
              </select>
            </label>
            <label>Allowed venue IP addresses
              <textarea name="allowed_ips" rows="2" placeholder="e.g. 203.0.113.25, 198.51.100.0/24">${s.allowed_ips}</textarea>
              <span class="hint">Your current IP address is <strong>${normalizeIp(c.get('ip'))}</strong>. Open this page while connected to the venue WiFi to see the venue’s address. Separate several with commas; IPv4 ranges like 203.0.113.0/24 and prefixes ending in * are allowed.</span>
            </label>
            <h3>Roster and lateness</h3>
            <label>Compare clock-ins with the roster
              <select name="schedule_mode">
                ${opt('schedule_mode', 'off', 'Off — no roster')}
                ${opt('schedule_mode', 'flag', 'Flag late, too-early and not-rostered clock-ins (recommended)')}
                ${opt('schedule_mode', 'block', 'Flag lateness; only allow clock-in during rostered shifts')}
              </select>
              <span class="hint">Fill in who works when on the <a href="/admin/roster">Roster</a> page. Late arrivals are always allowed, just flagged.</span>
            </label>
            <div class="grid-2">
              <label>Late after (minutes past the rostered start)
                <input type="number" name="late_grace_min" min="0" max="60" value="${s.late_grace_min}">
              </label>
              <label>Clock-in opens (minutes before the rostered start)
                <input type="number" name="early_clockin_min" min="0" max="240" value="${s.early_clockin_min}">
              </label>
            </div>
            <div><button class="btn btn-primary" type="submit">Save settings</button></div>
          </form>
        </section>

        <section class="card">
          <h2>Work sites (GPS geofence)</h2>
          ${sites.length ? html`
            <div class="table-wrap"><table>
              <thead><tr><th>Name</th><th>Location</th><th class="num">Radius</th><th></th></tr></thead>
              <tbody>${sites.map((x) => html`
                <tr><td>${x.name}</td><td>${x.lat.toFixed(5)}, ${x.lng.toFixed(5)} ${mapLink(x.lat, x.lng)}</td><td class="num">${x.radius_m} m</td>
                  <td><form method="post" action="/admin/sites/${x.id}/delete"><button class="btn-link danger" type="submit" data-confirm="Remove this site?">Remove</button></form></td></tr>`)}
              </tbody></table></div>` : html`<p class="muted">No sites yet — locations are recorded but not checked against anywhere.</p>`}
          <h3>Add a site</h3>
          <form method="post" action="/admin/sites" class="stack" id="site-form">
            <div class="grid-4">
              <label>Name <input name="name" required maxlength="100" placeholder="Main venue"></label>
              <label>Latitude <input name="lat" required inputmode="decimal" data-lat></label>
              <label>Longitude <input name="lng" required inputmode="decimal" data-lng></label>
              <label>Radius (m) <input name="radius_m" type="number" min="20" max="5000" value="150" required></label>
            </div>
            <p class="hint">Stand at the venue and tap “Use my current location”, or copy the coordinates from Google Maps (right-click → the numbers at the top). 100–200 m works well; GPS indoors can be off by 50 m or more.</p>
            <div class="action-row">
              <button type="button" class="btn" data-use-location>Use my current location</button>
              <button class="btn btn-primary" type="submit">Add site</button>
            </div>
            <p class="form-status" data-form-status></p>
          </form>
        </section>`,
    });
  });

  app.post('/admin/settings', async (c) => {
    const b = await form(c);
    const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
    const alertCount = Math.round(Number(b.device_alert_count));
    const minutes = (v, max, fallback) => {
      const n = Math.round(Number(v));
      return v !== '' && n >= 0 && n <= max ? n : fallback;
    };
    await c.get('db').batch([
      setSettingStmt('geofence_mode', pick(b.geofence_mode, ['off', 'flag', 'block'], 'flag')),
      setSettingStmt('ip_mode', pick(b.ip_mode, ['off', 'flag', 'block'], 'off')),
      setSettingStmt('allowed_ips', String(b.allowed_ips || '').slice(0, 2000)),
      setSettingStmt('device_mode', pick(b.device_mode, ['off', 'flag', 'block'], 'flag')),
      setSettingStmt('device_alert_count', alertCount >= 2 && alertCount <= 20 ? alertCount : 3),
      setSettingStmt('selfie_mode', pick(b.selfie_mode, ['off', 'flag', 'block'], 'off')),
      setSettingStmt('schedule_mode', pick(b.schedule_mode, ['off', 'flag', 'block'], 'off')),
      setSettingStmt('late_grace_min', minutes(b.late_grace_min, 60, 5)),
      setSettingStmt('early_clockin_min', minutes(b.early_clockin_min, 240, 30)),
    ]);
    return c.redirect(withMsg('/admin/settings', 'Settings saved.'));
  });

  app.post('/admin/sites', async (c) => {
    const b = await form(c);
    const name = String(b.name || '').trim().slice(0, 100);
    const lat = Number(b.lat);
    const lng = Number(b.lng);
    const radius = Math.round(Number(b.radius_m));
    if (!name || !(Math.abs(lat) <= 90) || !(Math.abs(lng) <= 180) || !(radius >= 20 && radius <= 5000)) {
      return c.redirect(withMsg('/admin/settings', 'Could not add site: check the name, coordinates and radius.'));
    }
    await c.get('db').run('INSERT INTO sites (name, lat, lng, radius_m) VALUES (?, ?, ?, ?)', name, lat, lng, radius);
    return c.redirect(withMsg('/admin/settings', `Site “${name}” added.`));
  });

  app.post('/admin/sites/:id/delete', async (c) => {
    await c.get('db').run('DELETE FROM sites WHERE id = ?', Number(c.req.param('id')));
    return c.redirect(withMsg('/admin/settings', 'Site removed.'));
  });

  // ---------- Monthly export ----------
  const monthParam = (q) => (isMonth(q) ? q : localDate().slice(0, 7));
  const dayLabel = (ym, d) => {
    const date = `${ym}-${String(d).padStart(2, '0')}`;
    const wd = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
    return `${String(d).padStart(2, '0')} ${wd}`;
  };

  app.get('/admin/export', async (c) => {
    const ym = monthParam(c.req.query('month'));
    const rep = await monthReport(c.get('db'), ym);
    return render(c, {
      title: 'Monthly export',
      active: 'export',
      body: html`
        <div class="row-between page-head">
          <h1>Monthly summary</h1>
          <div class="month-nav">
            <a class="btn btn-small" href="/admin/export?month=${addMonths(ym, -1)}">‹</a>
            <strong>${prettyMonth(ym)}</strong>
            <a class="btn btn-small" href="/admin/export?month=${addMonths(ym, 1)}">›</a>
          </div>
        </div>

        ${rep.totals.pending || rep.totals.open ? html`
          <div class="alert alert-warn">
            ${rep.totals.pending ? html`${fmtHours(rep.totals.pending)} h still <a href="/admin/pending">pending approval</a>. ` : ''}
            ${rep.totals.open ? html`${rep.totals.open} shift(s) not clocked out yet. ` : ''}
            Only <strong>approved</strong> hours are counted as payable.
          </div>` : ''}

        <section class="card">
          <div class="action-row">
            <a class="btn btn-primary" href="/admin/export/summary.csv?month=${ym}">⬇ Summary CSV (one row per worker)</a>
            <a class="btn" href="/admin/export/detail.csv?month=${ym}">⬇ Detailed CSV (every shift, with approvals)</a>
          </div>
          <p class="hint">The summary has each worker’s totals plus approved hours for every day of the month. The detailed file lists each check-in/out with who approved it and when.</p>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Worker</th><th>Sign-in ID</th><th class="num">Days</th><th class="num">Shifts</th><th class="num">Approved h</th><th class="num">Pending h</th><th class="num">Rejected h</th><th class="num">Rate</th><th class="num">Pay</th></tr></thead>
              <tbody>
                ${rep.rows.map((r) => html`
                  <tr>
                    <td>${r.worker.name}</td><td>${r.worker.login}</td>
                    <td class="num">${r.daysWorked}</td><td class="num">${r.shifts}</td>
                    <td class="num"><strong>${fmtHours(r.approved)}</strong></td>
                    <td class="num">${r.pending ? fmtHours(r.pending) : '—'}</td>
                    <td class="num">${r.rejected ? fmtHours(r.rejected) : '—'}</td>
                    <td class="num">${r.worker.hourly_rate != null ? fmtMoney(r.worker.hourly_rate) : '—'}</td>
                    <td class="num">${fmtMoney(r.pay)}</td>
                  </tr>`)}
              </tbody>
              <tfoot>
                <tr><th colspan="2">Total</th><th class="num">${rep.totals.daysWorked}</th><th class="num">${rep.totals.shifts}</th>
                  <th class="num">${fmtHours(rep.totals.approved)}</th><th class="num">${fmtHours(rep.totals.pending)}</th>
                  <th class="num">${fmtHours(rep.totals.rejected)}</th><th></th><th class="num">${fmtMoney(rep.totals.pay)}</th></tr>
              </tfoot>
            </table>
          </div>
        </section>`,
    });
  });

  function sendCsv(c, filename, rows) {
    return c.body(toCsv(rows), 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    });
  }

  app.get('/admin/export/summary.csv', async (c) => {
    const ym = monthParam(c.req.query('month'));
    const rep = await monthReport(c.get('db'), ym);
    const withRoster = (await getSettings(c.get('db'))).schedule_mode !== 'off';
    const dayCols = Array.from({ length: rep.nDays }, (_, i) => dayLabel(ym, i + 1));
    const rows = [[
      'Month', 'Worker ID', 'Name', 'Phone / Staff ID', 'Days Worked', 'Shifts', 'Approved Hours', 'Pending Hours',
      'Rejected Hours', 'Not Clocked Out', 'Hourly Rate', 'Approved Pay', ...(withRoster ? ['Times Late', 'Minutes Late'] : []), ...dayCols,
    ]];
    for (const r of rep.rows) {
      rows.push([
        ym, r.worker.id, r.worker.name, r.worker.login, r.daysWorked, r.shifts, r.approved, r.pending,
        r.rejected, r.open, r.worker.hourly_rate, r.pay, ...(withRoster ? [r.late, r.lateMin] : []), ...r.daily.map((h) => h || ''),
      ]);
    }
    const t = rep.totals;
    rows.push([ym, '', 'TOTAL', '', t.daysWorked, t.shifts, t.approved, t.pending, t.rejected, t.open, '', t.pay,
      ...(withRoster ? [t.late, t.lateMin] : []), ...t.daily.map((h) => h || '')]);
    return sendCsv(c, `attendance-summary-${ym}.csv`, rows);
  });

  app.get('/admin/export/detail.csv', async (c) => {
    const ym = monthParam(c.req.query('month'));
    const rep = await monthReport(c.get('db'), ym);
    const withRoster = (await getSettings(c.get('db'))).schedule_mode !== 'off';
    const rows = [[
      'Date', 'Day', 'Worker ID', 'Name', 'Phone / Staff ID', 'Check In', 'Check Out',
      'Check In (rounded)', 'Check Out (rounded)', 'Hours', 'Actual Hours', 'Status',
      'Approved/Rejected By', 'Approved/Rejected At', 'Review Note', 'Worker Note',
      'Check-in Site', 'Check-in Distance (m)', 'Check-in GPS', 'Check-out Site', 'Check-out Distance (m)', 'Check-out GPS',
      'Check-in Device', 'Check-out Device', 'Flags', 'Shift ID',
      ...(withRoster ? ['Rostered Start', 'Rostered End', 'Minutes Late'] : []),
    ]];
    const gps = (lat, lng) => (lat == null ? '' : `${lat.toFixed(6)} ${lng.toFixed(6)}`);
    const shifts = [...rep.shifts].sort((a, b) => a.work_date.localeCompare(b.work_date) || a.name.localeCompare(b.name) || a.check_in_at.localeCompare(b.check_in_at));
    for (const s of shifts) {
      rows.push([
        s.work_date,
        new Date(`${s.work_date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }),
        s.user_id, s.name, s.login,
        localDateTime(s.check_in_at), localDateTime(s.check_out_at),
        localDateTime(roundTime(s.check_in_at)), localDateTime(roundTime(s.check_out_at)),
        s.check_out_at ? paidHours(s.check_in_at, s.check_out_at) : '',
        s.check_out_at ? hoursBetween(s.check_in_at, s.check_out_at) : '',
        s.check_out_at ? s.status.charAt(0).toUpperCase() + s.status.slice(1) : 'Not clocked out',
        s.reviewer_name || '', localDateTime(s.reviewed_at), s.review_note || '', s.worker_note || '',
        s.in_site || '', s.in_distance_m ?? '', gps(s.in_lat, s.in_lng),
        s.out_site || '', s.out_distance_m ?? '', gps(s.out_lat, s.out_lng),
        deviceName(s.in_device_label, s.in_device_key) || '', deviceName(s.out_device_label, s.out_device_key) || '',
        String(s.flags || '').split(',').filter(Boolean).map((f) => flagLabel(f, { lateMin: minutesLate(s) })).join('; '),
        s.id,
        ...(withRoster ? [localDateTime(s.sched_start), localDateTime(s.sched_end), hasFlag(s.flags, 'in:late') ? minutesLate(s) : ''] : []),
      ]);
    }
    return sendCsv(c, `attendance-detail-${ym}.csv`, rows);
  });
}
