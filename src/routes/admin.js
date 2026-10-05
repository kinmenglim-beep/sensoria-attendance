'use strict';

const express = require('express');

const {
  transaction, getSettings, setSetting, audit, addFlags, removeFlags, hasFlag,
} = require('../db');
const { hashSecret } = require('../auth');
const {
  localDate, localTime, localDateTime, localToUtcIso, addDays, addMonths, hoursBetween, formatDuration,
  prettyDate, prettyMonth, isDate, isMonth, isTime, TZ,
} = require('../time');
const { normalizeIp } = require('../verify');
const { html, statusBadge, flagList, fmtHours, fmtMoney, FLAG_LABELS } = require('../views');
const { monthReport } = require('../report');
const { toCsv } = require('../csv');

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

module.exports = function adminRoutes({ db, render, requireSupervisor }) {
  const router = express.Router();
  router.use('/admin', requireSupervisor);

  const shiftHours = (s) => (s.check_out_at ? hoursBetween(s.check_in_at, s.check_out_at) : null);
  // Auto-closed shifts need a real check-out time before they can be approved.
  const approvable = (s) => s.check_out_at && s.status !== 'approved' && !hasFlag(s.flags, 'no_checkout');

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
                  <td>${s.name}</td>
                  <td>${localTime(s.check_in_at)}${s.in_selfie ? html` <span title="Selfie taken">📷</span>` : ''}</td>
                  <td>${s.check_out_at ? localTime(s.check_out_at) : html`<span class="muted">${formatDuration(Date.now() - Date.parse(s.check_in_at))} so far</span>`}${s.check_out_at && localDate(s.check_out_at) !== s.work_date ? html` <small class="muted">(+1)</small>` : ''}</td>
                  <td class="num">${s.check_out_at ? fmtHours(shiftHours(s)) : '—'}</td>
                  <td>${flagList(s.flags) || html`<span class="ok-check" title="All checks passed">✓</span>`}</td>
                  <td>${statusBadge(s)}${s.reviewer_name ? html`<div class="muted small">${s.reviewer_name}</div>` : ''}</td>
                  <td><a href="/admin/shifts/${s.id}">View</a></td>
                </tr>`)}
            </tbody>
          </table>
        </div>
        ${selectable ? html`
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">Approve selected</button>
            <span class="muted small">Flagged shifts: open “View” to check the selfie / location before approving.</span>
          </div>` : ''}
      </form>`;
  }

  // ---------- Dashboard ----------
  router.get('/admin', (req, res) => {
    const today = localDate();
    const date = isDate(req.query.date) ? req.query.date : today;
    const workers = db.prepare("SELECT id, name, login FROM users WHERE role = 'worker' AND active = 1 ORDER BY name COLLATE NOCASE").all();
    const shifts = db.prepare(`
      SELECT s.*, u.name, r.name AS reviewer_name FROM shifts s
      JOIN users u ON u.id = s.user_id LEFT JOIN users r ON r.id = s.reviewed_by
      WHERE s.work_date = ? ORDER BY s.check_in_at
    `).all(date);

    const byUser = new Map();
    for (const s of shifts) {
      if (!byUser.has(s.user_id)) byUser.set(s.user_id, []);
      byUser.get(s.user_id).push(s);
    }
    const working = []; const done = []; const absent = [];
    for (const w of workers) {
      const list = byUser.get(w.id) || [];
      const open = list.find((s) => !s.check_out_at);
      if (!list.length) absent.push(w);
      else if (open) working.push({ w, open });
      else done.push({ w, hours: list.reduce((a, s) => a + shiftHours(s), 0), last: list[list.length - 1].check_out_at });
    }
    const pendingCount = shifts.filter((s) => s.check_out_at && s.status === 'pending').length;
    const staleOpen = db.prepare(`
      SELECT s.*, u.name FROM shifts s JOIN users u ON u.id = s.user_id
      WHERE s.check_out_at IS NULL AND s.work_date < ? ORDER BY s.check_in_at
    `).all(today);
    const otherPending = db.prepare("SELECT COUNT(*) AS n FROM shifts WHERE status = 'pending' AND check_out_at IS NOT NULL AND work_date <> ?").get(date).n;
    const back = `/admin?date=${date}`;

    render(res, {
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
              ${absent.map((w) => html`<li><span>${w.name}</span><a class="small" href="/admin/shifts/new?user_id=${w.id}&date=${date}">+ add shift</a></li>`)}
            </ul>` : html`<p class="muted">Everyone has clocked in.</p>`}
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
  router.get('/admin/pending', (req, res) => {
    const shifts = db.prepare(`
      SELECT s.*, u.name FROM shifts s JOIN users u ON u.id = s.user_id
      WHERE s.status = 'pending' AND s.check_out_at IS NOT NULL
      ORDER BY s.work_date, s.check_in_at
    `).all();
    render(res, {
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
  router.post('/admin/shifts/approve', (req, res) => {
    const ids = toIds(req.body.ids);
    const back = safeBack(req.body.back);
    if (!ids.length) return res.redirect(withMsg(back, 'Nothing selected.'));
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      UPDATE shifts SET status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = NULL
      WHERE id = ? AND check_out_at IS NOT NULL AND status <> 'approved'
        AND (',' || flags || ',') NOT LIKE '%,no_checkout,%'
    `);
    const n = transaction(db, () => {
      let count = 0;
      for (const id of ids) {
        if (stmt.run(req.user.id, now, id).changes) { audit(db, id, req.user.id, 'approve'); count++; }
      }
      return count;
    });
    res.redirect(withMsg(back, `Approved ${n} shift${n === 1 ? '' : 's'}.`));
  });

  function loadShift(id) {
    return db.prepare(`
      SELECT s.*, u.name, u.login, r.name AS reviewer_name FROM shifts s
      JOIN users u ON u.id = s.user_id LEFT JOIN users r ON r.id = s.reviewed_by
      WHERE s.id = ?
    `).get(Number(id));
  }

  router.post('/admin/shifts/:id/reject', (req, res) => {
    const shift = loadShift(req.params.id);
    if (!shift) return res.sendStatus(404);
    if (!shift.check_out_at) return res.redirect(withMsg(`/admin/shifts/${shift.id}`, 'Enter a check-out time before rejecting.'));
    const note = String(req.body.review_note || '').trim().slice(0, 300) || null;
    db.prepare("UPDATE shifts SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?")
      .run(req.user.id, new Date().toISOString(), note, shift.id);
    audit(db, shift.id, req.user.id, 'reject', note);
    res.redirect(withMsg(`/admin/shifts/${shift.id}`, 'Shift rejected.'));
  });

  router.post('/admin/shifts/:id/reset', (req, res) => {
    const shift = loadShift(req.params.id);
    if (!shift) return res.sendStatus(404);
    db.prepare("UPDATE shifts SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL, review_note = NULL WHERE id = ?").run(shift.id);
    audit(db, shift.id, req.user.id, 'reset_to_pending');
    res.redirect(withMsg(`/admin/shifts/${shift.id}`, 'Shift set back to pending.'));
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

  router.get('/admin/shifts/new', (req, res) => {
    const workers = db.prepare("SELECT id, name FROM users WHERE role = 'worker' AND active = 1 ORDER BY name COLLATE NOCASE").all();
    render(res, {
      title: 'Add shift',
      body: html`
        <div class="page-head"><h1>Add a shift manually</h1></div>
        <section class="card">
          <p class="muted">For workers who couldn't clock in themselves (no phone, flat battery…). The shift is marked “Added by supervisor”.</p>
          ${shiftForm({
            action: '/admin/shifts/new',
            workers,
            values: { user_id: req.query.user_id, work_date: isDate(req.query.date) ? req.query.date : localDate(), in_time: '', out_time: '', approve: true },
            submitLabel: 'Add shift',
          })}
        </section>`,
    });
  });

  router.post('/admin/shifts/new', (req, res) => {
    const b = req.body;
    const worker = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'worker'").get(Number(b.user_id));
    const t = parseShiftTimes(b, { requireOut: true });
    if (!worker || t.error) {
      const workers = db.prepare("SELECT id, name FROM users WHERE role = 'worker' AND active = 1 ORDER BY name COLLATE NOCASE").all();
      return render(res, {
        title: 'Add shift',
        error: t.error || 'Choose a worker.',
        body: html`<div class="page-head"><h1>Add a shift manually</h1></div>
          <section class="card">${shiftForm({ action: '/admin/shifts/new', workers, values: b, submitLabel: 'Add shift' })}</section>`,
      }, 400);
    }
    const approve = b.approve === '1';
    const now = new Date().toISOString();
    const id = transaction(db, () => {
      const r = db.prepare(`
        INSERT INTO shifts (user_id, work_date, check_in_at, check_out_at, flags, status, reviewed_by, reviewed_at)
        VALUES (?, ?, ?, ?, 'manual', ?, ?, ?)
      `).run(worker.id, t.date, t.inIso, t.outIso, approve ? 'approved' : 'pending', approve ? req.user.id : null, approve ? now : null);
      const newId = Number(r.lastInsertRowid);
      audit(db, newId, req.user.id, 'manual_add', String(b.reason || '').slice(0, 300) || null);
      if (approve) audit(db, newId, req.user.id, 'approve');
      return newId;
    });
    res.redirect(withMsg(`/admin/shifts/${id}`, 'Shift added.'));
  });

  function shiftDetail(res, shift, { error = null, values = null } = {}, status = 200) {
    const log = db.prepare(`
      SELECT a.*, u.name AS actor FROM audit a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.shift_id = ? ORDER BY a.at, a.id
    `).all(shift.id);
    const hrs = shiftHours(shift);
    const v = values || {
      work_date: shift.work_date,
      in_time: localTime(shift.check_in_at),
      out_time: shift.check_out_at && !hasFlag(shift.flags, 'no_checkout') ? localTime(shift.check_out_at) : '',
      approve: true,
    };
    render(res, {
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
            <div><span class="label">Hours</span><strong>${hrs != null ? fmtHours(hrs) : '—'}</strong></div>
            <div><span class="label">Status</span>${statusBadge(shift)}
              ${shift.reviewer_name ? html`<div class="small muted">by ${shift.reviewer_name}, ${localDateTime(shift.reviewed_at)}</div>` : ''}
              ${shift.review_note ? html`<div class="small">“${shift.review_note}”</div>` : ''}
            </div>
          </div>
          ${shift.flags ? html`<p>${flagList(shift.flags)}</p>` : ''}
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
            <p>${locationSummary(shift.in_site, shift.in_distance_m, shift.in_accuracy, shift.in_lat, shift.in_lng)}</p>
            ${shift.in_ip ? html`<p class="muted small">IP ${shift.in_ip}</p>` : ''}
            ${shift.in_selfie ? html`<img class="selfie" src="/selfies/${shift.in_selfie}" alt="Check-in selfie">` : html`<p class="muted">No selfie</p>`}
          </div>
          <div class="card">
            <h2>Check-out verification</h2>
            ${shift.check_out_at ? html`
              <p>${locationSummary(shift.out_site, shift.out_distance_m, shift.out_accuracy, shift.out_lat, shift.out_lng)}</p>
              ${shift.out_ip ? html`<p class="muted small">IP ${shift.out_ip}</p>` : ''}
              ${shift.out_selfie ? html`<img class="selfie" src="/selfies/${shift.out_selfie}" alt="Check-out selfie">` : html`<p class="muted">No selfie</p>`}
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

  router.get('/admin/shifts/:id', (req, res) => {
    const shift = loadShift(req.params.id);
    if (!shift) return res.sendStatus(404);
    shiftDetail(res, shift);
  });

  router.post('/admin/shifts/:id/edit', (req, res) => {
    const shift = loadShift(req.params.id);
    if (!shift) return res.sendStatus(404);
    const b = req.body;
    const t = parseShiftTimes(b, { requireOut: !!shift.check_out_at });
    if (t.error) return shiftDetail(res, shift, { error: t.error, values: b }, 400);

    const changes = [];
    if (t.date !== shift.work_date) changes.push(`date ${shift.work_date} → ${t.date}`);
    if (t.inIso !== shift.check_in_at) changes.push(`in ${localDateTime(shift.check_in_at)} → ${localDateTime(t.inIso)}`);
    if (t.outIso !== shift.check_out_at) changes.push(`out ${shift.check_out_at ? localDateTime(shift.check_out_at) : '—'} → ${t.outIso ? localDateTime(t.outIso) : '—'}`);
    const reason = String(b.reason || '').trim().slice(0, 300);
    const approve = b.approve === '1' && !!t.outIso && (changes.length > 0 || !hasFlag(shift.flags, 'no_checkout'));
    const now = new Date().toISOString();

    transaction(db, () => {
      if (changes.length) {
        db.prepare(`
          UPDATE shifts SET work_date = ?, check_in_at = ?, check_out_at = ?, flags = ?,
            status = 'pending', reviewed_by = NULL, reviewed_at = NULL, review_note = NULL
          WHERE id = ?
        `).run(t.date, t.inIso, t.outIso, addFlags(removeFlags(shift.flags, 'no_checkout'), 'edited'), shift.id);
        audit(db, shift.id, req.user.id, 'edit', changes.join('; ') + (reason ? ` (${reason})` : ''));
      }
      if (approve && (changes.length || shift.status !== 'approved')) {
        db.prepare("UPDATE shifts SET status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = NULL WHERE id = ?")
          .run(req.user.id, now, shift.id);
        audit(db, shift.id, req.user.id, 'approve');
      }
    });
    res.redirect(withMsg(`/admin/shifts/${shift.id}`, changes.length ? 'Shift updated.' : approve ? 'Shift approved.' : 'No changes.'));
  });

  // ---------- People ----------
  function personFields(values = {}, { isNew }) {
    return html`
      <div class="grid-2">
        <label>Full name <input name="name" value="${values.name || ''}" required maxlength="100"></label>
        <label>Phone / Staff ID (used to sign in)
          <input name="login" value="${values.login || ''}" required maxlength="50" autocapitalize="none">
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
      role: b.role === 'supervisor' ? 'supervisor' : 'worker',
      hourly_rate: b.hourly_rate === '' || b.hourly_rate === undefined ? null : Number(b.hourly_rate),
      secret: String(b.secret || ''),
    };
    if (!v.name || !v.login) return { v, error: 'Name and phone/staff ID are required.' };
    if (v.hourly_rate !== null && !(v.hourly_rate >= 0)) return { v, error: 'Hourly rate must be a positive number.' };
    if (isNew || v.secret) {
      if (v.role === 'supervisor' && v.secret.length < 8) return { v, error: 'Supervisor passwords need at least 8 characters.' };
      if (v.role === 'worker' && v.secret.length < 4) return { v, error: 'Worker PINs need at least 4 characters.' };
    }
    return { v };
  }

  function peoplePage(res, { error = null, values = {} } = {}, status = 200) {
    const people = db.prepare(`
      SELECT u.*, (SELECT MAX(check_in_at) FROM shifts WHERE user_id = u.id) AS last_seen
      FROM users u ORDER BY u.active DESC, u.role DESC, u.name COLLATE NOCASE
    `).all();
    render(res, {
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
              <thead><tr><th>Name</th><th>Sign-in ID</th><th>Role</th><th class="num">Rate</th><th>Last check-in</th><th>Status</th><th></th></tr></thead>
              <tbody>
                ${people.map((p) => html`
                  <tr class="${p.active ? '' : 'inactive'}">
                    <td>${p.name}</td><td>${p.login}</td>
                    <td>${p.role === 'supervisor' ? 'Supervisor' : 'Worker'}</td>
                    <td class="num">${p.hourly_rate != null ? fmtMoney(p.hourly_rate) : '—'}</td>
                    <td>${p.last_seen ? localDateTime(p.last_seen) : '—'}</td>
                    <td>${p.active ? 'Active' : 'Inactive'}</td>
                    <td><a href="/admin/people/${p.id}">Edit</a></td>
                  </tr>`)}
              </tbody>
            </table>
          </div>
        </section>`,
    }, status);
  }

  router.get('/admin/people', (req, res) => peoplePage(res));

  router.post('/admin/people', (req, res) => {
    const { v, error } = validatePerson(req.body, { isNew: true });
    if (error) return peoplePage(res, { error, values: v }, 400);
    try {
      db.prepare('INSERT INTO users (name, login, secret_hash, role, hourly_rate) VALUES (?, ?, ?, ?, ?)')
        .run(v.name, v.login, hashSecret(v.secret), v.role, v.hourly_rate);
    } catch (err) {
      if (/UNIQUE/.test(err.message)) return peoplePage(res, { error: 'That phone/staff ID is already in use.', values: v }, 400);
      throw err;
    }
    res.redirect(withMsg('/admin/people', `${v.name} added.`));
  });

  function personPage(res, person, { error = null, values = null } = {}, status = 200) {
    render(res, {
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
        </section>`,
    }, status);
  }

  router.get('/admin/people/:id', (req, res) => {
    const person = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!person) return res.sendStatus(404);
    personPage(res, person);
  });

  router.post('/admin/people/:id', (req, res) => {
    const person = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!person) return res.sendStatus(404);
    const { v, error } = validatePerson(req.body, { isNew: false });
    v.active = req.body.active === '1' ? 1 : 0;
    const self = person.id === req.user.id;
    if (error) return personPage(res, person, { error, values: v }, 400);
    if (self && (!v.active || v.role !== 'supervisor')) {
      return personPage(res, person, { error: "You can't deactivate yourself or remove your own supervisor role.", values: v }, 400);
    }
    if (v.role === 'supervisor' && person.role === 'worker'
      && db.prepare('SELECT 1 FROM shifts WHERE user_id = ? AND check_out_at IS NULL').get(person.id)) {
      return personPage(res, person, { error: 'This worker is still clocked in. Close their shift first.', values: v }, 400);
    }
    try {
      transaction(db, () => {
        db.prepare('UPDATE users SET name = ?, login = ?, role = ?, hourly_rate = ?, active = ? WHERE id = ?')
          .run(v.name, v.login, v.role, v.hourly_rate, v.active, person.id);
        if (v.secret) db.prepare('UPDATE users SET secret_hash = ? WHERE id = ?').run(hashSecret(v.secret), person.id);
        // Sign the person out everywhere if their access changed.
        if (!self && (v.secret || !v.active || v.role !== person.role)) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(person.id);
      });
    } catch (err) {
      if (/UNIQUE/.test(err.message)) return personPage(res, person, { error: 'That phone/staff ID is already in use.', values: v }, 400);
      throw err;
    }
    res.redirect(withMsg('/admin/people', `${v.name} saved.`));
  });

  // ---------- Settings ----------
  router.get('/admin/settings', (req, res) => {
    const s = getSettings(db);
    const sites = db.prepare('SELECT * FROM sites ORDER BY name').all();
    const opt = (name, value, label) => html`<option value="${value}" ${s[name] === value ? 'selected' : ''}>${label}</option>`;
    render(res, {
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
            <label>Selfie
              <select name="selfie">
                ${opt('selfie', 'in', 'At check-in only (recommended)')}
                ${opt('selfie', 'both', 'At check-in and check-out')}
                ${opt('selfie', 'none', 'Off')}
              </select>
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
              <span class="hint">Your current IP address is <strong>${normalizeIp(req.ip)}</strong>. Open this page while connected to the venue WiFi to see the venue’s address. Separate several with commas; IPv4 ranges like 203.0.113.0/24 and prefixes ending in * are allowed.</span>
            </label>
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

  router.post('/admin/settings', (req, res) => {
    const b = req.body;
    const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
    transaction(db, () => {
      setSetting(db, 'geofence_mode', pick(b.geofence_mode, ['off', 'flag', 'block'], 'flag'));
      setSetting(db, 'selfie', pick(b.selfie, ['none', 'in', 'both'], 'in'));
      setSetting(db, 'ip_mode', pick(b.ip_mode, ['off', 'flag', 'block'], 'off'));
      setSetting(db, 'allowed_ips', String(b.allowed_ips || '').slice(0, 2000));
    });
    res.redirect(withMsg('/admin/settings', 'Settings saved.'));
  });

  router.post('/admin/sites', (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 100);
    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);
    const radius = Math.round(Number(req.body.radius_m));
    if (!name || !(Math.abs(lat) <= 90) || !(Math.abs(lng) <= 180) || !(radius >= 20 && radius <= 5000)) {
      return res.redirect(withMsg('/admin/settings', 'Could not add site: check the name, coordinates and radius.'));
    }
    db.prepare('INSERT INTO sites (name, lat, lng, radius_m) VALUES (?, ?, ?, ?)').run(name, lat, lng, radius);
    res.redirect(withMsg('/admin/settings', `Site “${name}” added.`));
  });

  router.post('/admin/sites/:id/delete', (req, res) => {
    db.prepare('DELETE FROM sites WHERE id = ?').run(Number(req.params.id));
    res.redirect(withMsg('/admin/settings', 'Site removed.'));
  });

  // ---------- Monthly export ----------
  const monthParam = (q) => (isMonth(q) ? q : localDate().slice(0, 7));
  const dayLabel = (ym, d) => {
    const date = `${ym}-${String(d).padStart(2, '0')}`;
    const wd = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
    return `${String(d).padStart(2, '0')} ${wd}`;
  };

  router.get('/admin/export', (req, res) => {
    const ym = monthParam(req.query.month);
    const rep = monthReport(db, ym);
    render(res, {
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

  function sendCsv(res, filename, rows) {
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    });
    res.send(toCsv(rows));
  }

  router.get('/admin/export/summary.csv', (req, res) => {
    const ym = monthParam(req.query.month);
    const rep = monthReport(db, ym);
    const dayCols = Array.from({ length: rep.nDays }, (_, i) => dayLabel(ym, i + 1));
    const rows = [[
      'Month', 'Worker ID', 'Name', 'Phone / Staff ID', 'Days Worked', 'Shifts', 'Approved Hours', 'Pending Hours',
      'Rejected Hours', 'Not Clocked Out', 'Hourly Rate', 'Approved Pay', ...dayCols,
    ]];
    for (const r of rep.rows) {
      rows.push([
        ym, r.worker.id, r.worker.name, r.worker.login, r.daysWorked, r.shifts, r.approved, r.pending,
        r.rejected, r.open, r.worker.hourly_rate, r.pay, ...r.daily.map((h) => h || ''),
      ]);
    }
    const t = rep.totals;
    rows.push([ym, '', 'TOTAL', '', t.daysWorked, t.shifts, t.approved, t.pending, t.rejected, t.open, '', t.pay, ...t.daily.map((h) => h || '')]);
    sendCsv(res, `attendance-summary-${ym}.csv`, rows);
  });

  router.get('/admin/export/detail.csv', (req, res) => {
    const ym = monthParam(req.query.month);
    const rep = monthReport(db, ym);
    const rows = [[
      'Date', 'Day', 'Worker ID', 'Name', 'Phone / Staff ID', 'Check In', 'Check Out', 'Hours', 'Status',
      'Approved/Rejected By', 'Approved/Rejected At', 'Review Note', 'Worker Note',
      'Check-in Site', 'Check-in Distance (m)', 'Check-in GPS', 'Check-out Site', 'Check-out Distance (m)', 'Check-out GPS',
      'Selfie', 'Flags', 'Shift ID',
    ]];
    const gps = (lat, lng) => (lat == null ? '' : `${lat.toFixed(6)} ${lng.toFixed(6)}`);
    const shifts = [...rep.shifts].sort((a, b) => a.work_date.localeCompare(b.work_date) || a.name.localeCompare(b.name) || a.check_in_at.localeCompare(b.check_in_at));
    for (const s of shifts) {
      rows.push([
        s.work_date,
        new Date(`${s.work_date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }),
        s.user_id, s.name, s.login,
        localDateTime(s.check_in_at), localDateTime(s.check_out_at),
        s.check_out_at ? hoursBetween(s.check_in_at, s.check_out_at) : '',
        s.check_out_at ? s.status.charAt(0).toUpperCase() + s.status.slice(1) : 'Not clocked out',
        s.reviewer_name || '', localDateTime(s.reviewed_at), s.review_note || '', s.worker_note || '',
        s.in_site || '', s.in_distance_m ?? '', gps(s.in_lat, s.in_lng),
        s.out_site || '', s.out_distance_m ?? '', gps(s.out_lat, s.out_lng),
        [s.in_selfie && 'in', s.out_selfie && 'out'].filter(Boolean).join('+') || '',
        String(s.flags || '').split(',').filter(Boolean).map((f) => FLAG_LABELS[f] || f).join('; '),
        s.id,
      ]);
    }
    sendCsv(res, `attendance-detail-${ym}.csv`, rows);
  });

  return router;
};
