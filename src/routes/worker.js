'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { transaction, getSettings, audit, addFlags } = require('../db');
const {
  TZ, localDate, localTime, addMonths, hoursBetween, formatDuration, prettyDate, prettyMonth, isMonth,
} = require('../time');
const { checkGeofence, normalizeIp, parseAllowList, ipAllowed } = require('../verify');
const { html, statusBadge, flagList, fmtHours, fmtMoney } = require('../views');
const { round2 } = require('../report');

const MAX_SELFIE_BYTES = 2 * 1024 * 1024;
// An open shift older than this is treated as "forgot to clock out".
const MAX_SHIFT_HOURS = Number(process.env.MAX_SHIFT_HOURS) || 16;
const isStale = (shift) => !!shift && Date.now() - Date.parse(shift.check_in_at) > MAX_SHIFT_HOURS * 3600000;

function decodeSelfie(dataUrl) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 100 || buf.length > MAX_SELFIE_BYTES) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  return buf;
}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

module.exports = function workerRoutes({ db, selfieDir, render, requireWorker }) {
  const router = express.Router();

  // ---------- Clock in / out page ----------
  router.get('/', requireWorker, (req, res) => {
    const uid = req.user.id;
    const s = getSettings(db);
    let open = db.prepare('SELECT * FROM shifts WHERE user_id = ? AND check_out_at IS NULL').get(uid);
    const forgotten = isStale(open) ? open : null;
    if (forgotten) open = null;
    const today = localDate();
    const todays = db.prepare('SELECT * FROM shifts WHERE user_id = ? AND work_date = ? ORDER BY check_in_at').all(uid, today);
    const action = open ? 'out' : 'in';
    const needSelfie = s.selfie === 'both' || (s.selfie === 'in' && action === 'in');
    const workedToday = todays.reduce((a, x) => a + (x.check_out_at ? hoursBetween(x.check_in_at, x.check_out_at) : 0), 0);

    render(res, {
      title: 'Clock in/out',
      active: 'home',
      scripts: ['/checkin.js'],
      body: html`
        <section class="card clock-card ${open ? 'is-in' : 'is-out'}">
          <p class="muted">Hi ${req.user.name} · ${prettyDate(today)}</p>
          ${forgotten ? html`<div class="alert alert-warn">You didn't clock out after your shift on ${prettyDate(forgotten.work_date)} (in at ${localTime(forgotten.check_in_at)}). Please tell your supervisor what time you finished.</div>` : ''}
          ${open
            ? html`<h1 class="clock-status">You're clocked in</h1>
                   <p class="clock-since">since <strong>${localTime(open.check_in_at)}</strong>
                     · <span data-elapsed-since="${open.check_in_at}">${formatDuration(Date.now() - Date.parse(open.check_in_at))}</span></p>`
            : html`<h1 class="clock-status">You're not clocked in</h1>
                   <p class="clock-since" data-clock="${TZ}"></p>`}

          <form id="clock-form" class="stack" data-action="${action}" data-location="${s.geofence_mode}" data-selfie="${needSelfie ? '1' : '0'}">
            ${needSelfie ? html`
              <label class="selfie-picker">
                <input type="file" name="selfie" accept="image/*" capture="user" hidden>
                <span class="selfie-preview" data-selfie-preview>
                  <span class="selfie-placeholder">📷<br>Tap to take a selfie</span>
                </span>
              </label>` : ''}
            <label>Note (optional)
              <input name="note" maxlength="200" placeholder="${open ? 'e.g. left early, approved by Ali' : 'e.g. covering for Siti'}">
            </label>
            <button type="submit" class="btn btn-huge ${open ? 'btn-danger' : 'btn-primary'}">
              ${open ? 'Clock OUT' : 'Clock IN'}
            </button>
            <p class="form-status" data-form-status role="status" aria-live="polite"></p>
            ${s.geofence_mode !== 'off' ? html`<p class="hint">Your location is recorded when you clock ${action}. Please allow location access if asked.</p>` : ''}
          </form>
        </section>

        <section class="card">
          <div class="row-between">
            <h2>Today</h2>
            <span class="muted">${fmtHours(workedToday)} h completed</span>
          </div>
          ${todays.length ? html`
            <ul class="shift-list">
              ${todays.map((x) => html`
                <li>
                  <span>${localTime(x.check_in_at)} → ${x.check_out_at ? localTime(x.check_out_at) : '…'}</span>
                  <span>${x.check_out_at ? html`${fmtHours(hoursBetween(x.check_in_at, x.check_out_at))} h ` : ''}${statusBadge(x)}</span>
                </li>`)}
            </ul>` : html`<p class="muted">No shifts yet today.</p>`}
          <p><a href="/me">See all my hours →</a></p>
        </section>`,
    });
  });

  // ---------- Clock API ----------
  router.post('/api/clock', requireWorker, (req, res) => {
    const uid = req.user.id;
    const action = req.body.action;
    if (action !== 'in' && action !== 'out') return res.status(400).json({ error: 'Invalid action.' });
    const s = getSettings(db);
    let open = db.prepare('SELECT * FROM shifts WHERE user_id = ? AND check_out_at IS NULL').get(uid);
    const forgotten = isStale(open) ? open : null;
    if (forgotten) open = null;
    if (action === 'in' && open) return res.status(409).json({ error: `You're already clocked in since ${localTime(open.check_in_at)}.` });
    if (action === 'out' && !open) return res.status(409).json({ error: "You're not clocked in." });

    const p = action; // flag prefix
    const flags = [];
    const loc = { lat: null, lng: null, accuracy: null, site: null, distance: null };

    // 1. GPS geofence
    if (s.geofence_mode !== 'off') {
      const lat = num(req.body.lat);
      const lng = num(req.body.lng);
      if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        if (s.geofence_mode === 'block') {
          return res.status(400).json({ error: 'Location is required. Please turn on location / allow access for this site and try again.' });
        }
        flags.push(`${p}:no_location`);
      } else {
        Object.assign(loc, { lat, lng, accuracy: num(req.body.accuracy) });
        const sites = db.prepare('SELECT * FROM sites').all();
        const geo = checkGeofence(lat, lng, loc.accuracy, sites);
        if (geo) {
          loc.site = geo.site.name;
          loc.distance = geo.distance;
          if (!geo.inside) {
            if (s.geofence_mode === 'block') {
              return res.status(403).json({ error: `You seem to be about ${geo.distance} m from ${geo.site.name}. Please clock ${action} at the venue.` });
            }
            flags.push(`${p}:outside_area`);
          }
        }
      }
    }

    // 2. Venue network (WiFi public IP)
    const ip = normalizeIp(req.ip);
    const allowList = parseAllowList(s.allowed_ips);
    if (s.ip_mode !== 'off' && allowList.length && !ipAllowed(ip, allowList)) {
      if (s.ip_mode === 'block') return res.status(403).json({ error: 'Please connect to the venue WiFi and try again.' });
      flags.push(`${p}:off_network`);
    }

    // 3. Selfie
    const needSelfie = s.selfie === 'both' || (s.selfie === 'in' && action === 'in');
    let selfieBuf = null;
    if (req.body.selfie) {
      selfieBuf = decodeSelfie(req.body.selfie);
      if (!selfieBuf) return res.status(400).json({ error: 'The photo could not be read. Please take it again.' });
    }
    if (needSelfie && !selfieBuf) return res.status(400).json({ error: 'Please take a selfie first.' });
    let selfieFile = null;
    if (selfieBuf) {
      selfieFile = `${crypto.randomBytes(16).toString('hex')}.jpg`;
      fs.writeFileSync(path.join(selfieDir, selfieFile), selfieBuf);
    }

    const note = String(req.body.note || '').trim().slice(0, 200) || null;
    const now = new Date().toISOString();

    try {
      if (action === 'in') {
        const id = transaction(db, () => {
          if (forgotten) {
          // Close the forgotten shift at 0 h and flag it so the supervisor enters the real time.
            db.prepare('UPDATE shifts SET check_out_at = check_in_at, flags = ? WHERE id = ? AND check_out_at IS NULL')
              .run(addFlags(forgotten.flags, 'no_checkout'), forgotten.id);
            audit(db, forgotten.id, null, 'auto_closed', 'Worker never clocked out; a supervisor needs to enter the check-out time');
          }
          const r = db.prepare(`
            INSERT INTO shifts (user_id, work_date, check_in_at, in_lat, in_lng, in_accuracy, in_site, in_distance_m, in_selfie, in_ip, flags, worker_note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(uid, localDate(now), now, loc.lat, loc.lng, loc.accuracy, loc.site, loc.distance, selfieFile, ip, addFlags('', ...flags), note);
          return Number(r.lastInsertRowid);
        });
        audit(db, id, uid, 'clock_in');
        return res.json({ ok: true, message: `Clocked in at ${localTime(now)}.${flags.length ? ' Your supervisor will review the location.' : ''}` });
      }

      const workerNote = [open.worker_note, note].filter(Boolean).join(' / ') || null;
      db.prepare(`
        UPDATE shifts SET check_out_at = ?, out_lat = ?, out_lng = ?, out_accuracy = ?, out_site = ?, out_distance_m = ?,
          out_selfie = ?, out_ip = ?, flags = ?, worker_note = ?
        WHERE id = ? AND check_out_at IS NULL
      `).run(now, loc.lat, loc.lng, loc.accuracy, loc.site, loc.distance, selfieFile, ip, addFlags(open.flags, ...flags), workerNote, open.id);
      audit(db, open.id, uid, 'clock_out');
      const hrs = hoursBetween(open.check_in_at, now);
      return res.json({ ok: true, message: `Clocked out at ${localTime(now)} — ${fmtHours(hrs)} h. Waiting for supervisor approval.` });
    } catch (err) {
      if (selfieFile) fs.rmSync(path.join(selfieDir, selfieFile), { force: true });
      if (/UNIQUE/.test(err.message)) return res.status(409).json({ error: "You're already clocked in." });
      throw err;
    }
  });

  // ---------- My hours ----------
  router.get('/me', requireWorker, (req, res) => {
    const ym = isMonth(req.query.month) ? req.query.month : localDate().slice(0, 7);
    const shifts = db.prepare(`
      SELECT s.*, r.name AS reviewer_name FROM shifts s LEFT JOIN users r ON r.id = s.reviewed_by
      WHERE s.user_id = ? AND s.work_date LIKE ? ORDER BY s.check_in_at DESC
    `).all(req.user.id, `${ym}-%`);
    let approved = 0; let pending = 0;
    for (const x of shifts) {
      if (!x.check_out_at) continue;
      const h = hoursBetween(x.check_in_at, x.check_out_at);
      if (x.status === 'approved') approved += h; else if (x.status === 'pending') pending += h;
    }
    const rate = req.user.hourly_rate;

    render(res, {
      title: 'My hours',
      active: 'me',
      body: html`
        <div class="row-between page-head">
          <h1>My hours</h1>
          <div class="month-nav">
            <a class="btn btn-small" href="/me?month=${addMonths(ym, -1)}">‹</a>
            <strong>${prettyMonth(ym)}</strong>
            <a class="btn btn-small" href="/me?month=${addMonths(ym, 1)}">›</a>
          </div>
        </div>
        <div class="stats">
          <div class="stat"><span class="stat-num">${fmtHours(approved)}</span><span class="stat-label">Approved hours</span></div>
          <div class="stat"><span class="stat-num">${fmtHours(pending)}</span><span class="stat-label">Waiting approval</span></div>
          <div class="stat"><span class="stat-num">${shifts.length}</span><span class="stat-label">Shifts</span></div>
          ${rate != null ? html`<div class="stat"><span class="stat-num">${fmtMoney(round2(approved * rate))}</span><span class="stat-label">Est. pay (approved)</span></div>` : ''}
        </div>
        <section class="card">
          ${shifts.length ? html`
          <ul class="history">
            ${shifts.map((x) => html`
              <li>
                <div class="row-between">
                  <strong>${prettyDate(x.work_date)}</strong>
                  <span>${x.check_out_at ? html`<strong>${fmtHours(hoursBetween(x.check_in_at, x.check_out_at))} h</strong> ` : ''}${statusBadge(x)}</span>
                </div>
                <div>In ${localTime(x.check_in_at)} → Out ${x.check_out_at ? localTime(x.check_out_at) : '—'}${x.check_out_at && localDate(x.check_out_at) !== x.work_date ? html` <small class="muted">(next day)</small>` : ''}</div>
                ${x.reviewer_name ? html`<div class="muted small">${x.status === 'approved' ? 'Approved' : 'Rejected'} by ${x.reviewer_name} · ${prettyDate(localDate(x.reviewed_at))} ${localTime(x.reviewed_at)}</div>` : ''}
                ${x.review_note ? html`<div class="small">“${x.review_note}”</div>` : ''}
                ${x.flags ? html`<div>${flagList(x.flags)}</div>` : ''}
              </li>`)}
          </ul>` : html`<p class="muted">No shifts this month.</p>`}
        </section>`,
    });
  });

  return router;
};
