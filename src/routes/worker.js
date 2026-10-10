import { getSettings, auditStmt, addFlags, PHOTO_KEEP_DAYS } from '../db.js';
import { envVar } from '../env.js';
import {
  TZ, localDate, localTime, roundTime, addDays, addMonths, paidHours, formatDuration, formatHM, prettyDate, prettyMonth, isMonth,
} from '../time.js';
import { checkGeofence, normalizeIp, parseAllowList, ipAllowed } from '../verify.js';
import { html, statusBadge, flagList, fmtHours, fmtMoney, clockTime } from '../views.js';
import { round2 } from '../report.js';
import { resolveDevice, checkRegistration, recentDeviceCount } from '../device.js';
import { rosterSlots, matchSlot, minutesLate } from '../schedule.js';

// Selfies arrive as a small JPEG data URL (the phone shrinks the photo before upload).
const SELFIE_RE = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/;
const SELFIE_MAX_CHARS = 400000;
const parseSelfie = (v) => (typeof v === 'string' && v.length <= SELFIE_MAX_CHARS ? SELFIE_RE.exec(v)?.[1] ?? null : null);

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export function registerWorkerRoutes(app, { render, requireWorker }) {
  // An open shift older than this is treated as "forgot to clock out".
  const maxShiftHours = (c) => Number(envVar(c, 'MAX_SHIFT_HOURS')) || 16;
  const isStale = (c, shift) => !!shift && Date.now() - Date.parse(shift.check_in_at) > maxShiftHours(c) * 3600000;

  async function openShift(c, db, uid) {
    const open = await db.get('SELECT * FROM shifts WHERE user_id = ? AND check_out_at IS NULL', uid);
    return isStale(c, open) ? { open: null, forgotten: open } : { open, forgotten: null };
  }

  // ---------- Clock in / out page ----------
  app.get('/', requireWorker, async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const s = await getSettings(db);
    const { open, forgotten } = await openShift(c, db, user.id);
    const today = localDate();
    const todays = await db.all('SELECT * FROM shifts WHERE user_id = ? AND work_date = ? ORDER BY check_in_at', user.id, today);
    const action = open ? 'out' : 'in';
    const workedToday = todays.reduce((a, x) => a + (x.check_out_at ? paidHours(x.check_in_at, x.check_out_at) : 0), 0);
    const roster = s.schedule_mode !== 'off' ? await rosterSlots(db, user.id, today, addDays(today, 6)) : [];
    const todaysRoster = roster.filter((r) => r.work_date === today);
    const askSelfie = !open && s.selfie_mode !== 'off';

    return render(c, {
      title: 'Clock in/out',
      active: 'home',
      scripts: ['/checkin.js'],
      body: html`
        <section class="card clock-card ${open ? 'is-in' : 'is-out'}">
          <p class="muted">Hi ${user.name} · ${prettyDate(today)}</p>
          ${forgotten ? html`<div class="alert alert-warn">You didn't clock out after your shift on ${prettyDate(forgotten.work_date)} (in at ${localTime(forgotten.check_in_at)}). Please tell your supervisor what time you finished.</div>` : ''}
          ${open
            ? html`<h1 class="clock-status">You're clocked in</h1>
                   <p class="clock-since">since <strong>${localTime(open.check_in_at)}</strong>
                     · <span data-elapsed-since="${open.check_in_at}">${formatDuration(Date.now() - Date.parse(open.check_in_at))}</span></p>`
            : html`<h1 class="clock-status">You're not clocked in</h1>
                   <p class="clock-since" data-clock="${TZ}"></p>`}
          ${s.schedule_mode !== 'off' ? html`<p class="roster-today">${todaysRoster.length
            ? html`Today's shift: <strong>${todaysRoster.map((r) => `${r.start_time}–${r.end_time}`).join(', ')}</strong>`
            : html`<span class="muted">You're not on the roster today.</span>`}</p>` : ''}

          <form id="clock-form" class="stack" data-action="${action}" data-location="${s.geofence_mode}" data-selfie="${askSelfie ? s.selfie_mode : 'off'}">
            ${askSelfie ? html`
              <label class="selfie-picker">
                <span class="selfie-preview" data-selfie-preview><span class="selfie-placeholder">📷<br>Tap to take a selfie${s.selfie_mode === 'block' ? '' : html`<br><small>(optional)</small>`}</span></span>
                <input type="file" name="selfie" accept="image/*" capture="user" class="visually-hidden">
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
                  <span>${clockTime(x.check_in_at)} → ${x.check_out_at ? clockTime(x.check_out_at) : '…'}</span>
                  <span>${x.check_out_at ? html`${fmtHours(paidHours(x.check_in_at, x.check_out_at))} h ` : ''}${statusBadge(x)}</span>
                </li>`)}
            </ul>` : html`<p class="muted">No shifts yet today.</p>`}
          <p><a href="/me">See all my hours →</a></p>
        </section>
        ${roster.length ? html`
          <section class="card">
            <h2>My roster</h2>
            <ul class="shift-list">
              ${Array.from({ length: 7 }, (_, i) => addDays(today, i)).map((d) => {
                const day = roster.filter((r) => r.work_date === d);
                return html`<li><span>${dayName(d, today)}</span><span>${day.length ? day.map((r) => `${r.start_time}–${r.end_time}`).join(', ') : html`<span class="muted">Off</span>`}</span></li>`;
              })}
            </ul>
          </section>` : ''}`,
    });
  });

  // ---------- Clock API ----------
  app.post('/api/clock', requireWorker, async (c) => {
    const db = c.get('db');
    const uid = c.get('user').id;
    let body;
    try { body = await c.req.json(); } catch { body = {}; }
    if (!body || typeof body !== 'object') body = {};
    const action = body.action;
    if (action !== 'in' && action !== 'out') return c.json({ error: 'Invalid action.' }, 400);
    const s = await getSettings(db);
    const { open, forgotten } = await openShift(c, db, uid);
    if (action === 'in' && open) return c.json({ error: `You're already clocked in since ${localTime(open.check_in_at)}.` }, 409);
    if (action === 'out' && !open) return c.json({ error: "You're not clocked in." }, 409);

    const p = action; // flag prefix
    const flags = [];

    // 0. Selfie at clock-in
    let selfie = null;
    if (action === 'in' && s.selfie_mode !== 'off') {
      selfie = parseSelfie(body.selfie);
      if (!selfie) {
        if (s.selfie_mode === 'block') return c.json({ error: 'Please take a selfie first (tap the camera box).' }, 400);
        flags.push('in:no_selfie');
      }
    }
    const loc = { lat: null, lng: null, accuracy: null, site: null, distance: null };

    // 1. GPS geofence
    if (s.geofence_mode !== 'off') {
      const lat = num(body.lat);
      const lng = num(body.lng);
      if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        if (s.geofence_mode === 'block') {
          return c.json({ error: 'Location is required. Please turn on location / allow access for this site and try again.' }, 400);
        }
        flags.push(`${p}:no_location`);
      } else {
        Object.assign(loc, { lat, lng, accuracy: num(body.accuracy) });
        const geo = checkGeofence(lat, lng, loc.accuracy, await db.all('SELECT * FROM sites'));
        if (geo) {
          loc.site = geo.site.name;
          loc.distance = geo.distance;
          if (!geo.inside) {
            if (s.geofence_mode === 'block') {
              return c.json({ error: `You seem to be about ${geo.distance} m from ${geo.site.name}. Please clock ${action} at the venue.` }, 403);
            }
            flags.push(`${p}:outside_area`);
          }
        }
      }
    }

    // 2. Venue network (WiFi public IP)
    const ip = normalizeIp(c.get('ip'));
    const allowList = parseAllowList(s.allowed_ips);
    if (s.ip_mode !== 'off' && allowList.length && !ipAllowed(ip, allowList)) {
      if (s.ip_mode === 'block') return c.json({ error: 'Please connect to the venue WiFi and try again.' }, 403);
      flags.push(`${p}:off_network`);
    }

    // 3. Roster: late, too early, not rostered. Being late never blocks; it is only flagged.
    let sched = { start: null, end: null };
    let lateMin = 0;
    if (action === 'in' && s.schedule_mode !== 'off') {
      const today = localDate();
      const slots = await rosterSlots(db, uid, addDays(today, -1), today);
      const m = matchSlot(slots, Date.now(), { earlyMin: Number(s.early_clockin_min) || 0, graceMin: Number(s.late_grace_min) || 0 });
      if (m.status === 'none' || m.status === 'too_early') {
        if (s.schedule_mode === 'block') {
          return c.json({
            error: m.status === 'none'
              ? "You're not on the roster right now. Please check with your manager."
              : `Your shift starts at ${localTime(m.slot.startIso)}. You can clock in from ${localTime(m.opensAt)}.`,
          }, 403);
        }
        flags.push(m.status === 'none' ? 'in:unscheduled' : 'in:too_early');
      }
      if (m.slot) {
        sched = { start: m.slot.startIso, end: m.slot.endIso };
        // Coming back from a break within the same rostered shift isn't late again.
        const again = await db.get('SELECT 1 AS x FROM shifts WHERE user_id = ? AND sched_start = ? LIMIT 1', uid, sched.start);
        if (m.status === 'late' && !again) {
          flags.push('in:late');
          lateMin = m.lateMin;
        }
      }
    }
    if (action === 'out' && open.sched_end && s.schedule_mode !== 'off'
      && Date.now() < Date.parse(open.sched_end) - (Number(s.late_grace_min) || 0) * 60000) {
      flags.push('out:left_early');
    }

    // 4. Device: the worker's registered phone, phones shared between workers, frequent phone changes.
    const device = await resolveDevice(c, db, body, { secure: c.get('secure') });
    if (s.device_mode !== 'off') {
      const { registered } = await checkRegistration(db, uid, device.id);
      if (!registered) {
        if (s.device_mode === 'block') {
          return c.json({ error: "This phone isn't registered to you. Please use your usual phone, or ask your supervisor to approve this one." }, 403);
        }
        flags.push(`${p}:unregistered_device`);
      }
    }
    const alertCount = Number(s.device_alert_count) || 0;
    if (alertCount >= 2 && (await recentDeviceCount(db, uid, device.id)) >= alertCount) flags.push(`${p}:many_devices`);
    if (await db.get('SELECT 1 AS x FROM shifts WHERE user_id <> ? AND (in_device_id = ? OR out_device_id = ?) LIMIT 1', uid, device.id, device.id)) {
      flags.push(`${p}:shared_device`);
    }
    if (action === 'out' && open.in_device_id && open.in_device_id !== device.id) flags.push('out:device_changed');
    if (action === 'out' && open.in_device_id === device.id) {
      // Same phone as check-in: don't repeat device flags already raised at check-in.
      const inFlags = String(open.flags || '').split(',');
      for (let i = flags.length - 1; i >= 0; i--) {
        if (/device/.test(flags[i]) && inFlags.includes(flags[i].replace(/^out:/, 'in:'))) flags.splice(i, 1);
      }
    }

    const note = String(body.note || '').trim().slice(0, 200) || null;
    const now = new Date().toISOString();

    try {
      if (action === 'in') {
        const stmts = [];
        if (forgotten) {
          // Close the forgotten shift at 0 h and flag it so the supervisor enters the real time.
          stmts.push(['UPDATE shifts SET check_out_at = check_in_at, flags = ? WHERE id = ? AND check_out_at IS NULL',
            addFlags(forgotten.flags, 'no_checkout'), forgotten.id]);
          stmts.push(auditStmt(forgotten.id, null, 'auto_closed', 'Worker never clocked out; a supervisor needs to enter the check-out time'));
        }
        stmts.push([`
          INSERT INTO shifts (user_id, work_date, check_in_at, in_lat, in_lng, in_accuracy, in_site, in_distance_m, in_ip, in_device_id,
            sched_start, sched_end, flags, worker_note)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, uid, localDate(now), now, loc.lat, loc.lng, loc.accuracy, loc.site, loc.distance, ip, device.id,
        sched.start, sched.end, addFlags('', ...flags), note]);
        const results = await db.batch(stmts);
        const shiftId = results[results.length - 1].lastId;
        const after = [auditStmt(shiftId, uid, 'clock_in')];
        if (selfie) {
          after.push(['INSERT INTO photos (shift_id, kind, data, taken_at) VALUES (?, ?, ?, ?)', shiftId, 'in', selfie, now]);
          after.push(['DELETE FROM photos WHERE taken_at < ?', new Date(Date.now() - PHOTO_KEEP_DAYS * 86400000).toISOString()]);
        }
        await db.batch(after);
        // Device flags are for supervisors only, so only location/network issues are mentioned here.
        const reviewNeeded = flags.some((f) => /no_location|outside_area|off_network/.test(f));
        const timing = lateMin ? ` You're ${lateMin} min late.` : flags.includes('in:unscheduled') ? " You're not on the roster now." : '';
        return c.json({ ok: true, deviceKey: device.device_key, message: `Clocked in at ${localTime(now)}.${timing}${reviewNeeded ? ' Your supervisor will review the location.' : ''}` });
      }

      const workerNote = [open.worker_note, note].filter(Boolean).join(' / ') || null;
      await db.batch([
        [`UPDATE shifts SET check_out_at = ?, out_lat = ?, out_lng = ?, out_accuracy = ?, out_site = ?, out_distance_m = ?,
            out_ip = ?, out_device_id = ?, flags = ?, worker_note = ?
          WHERE id = ? AND check_out_at IS NULL`,
        now, loc.lat, loc.lng, loc.accuracy, loc.site, loc.distance, ip, device.id, addFlags(open.flags, ...flags), workerNote, open.id],
        auditStmt(open.id, uid, 'clock_out'),
      ]);
      const hrs = paidHours(open.check_in_at, now);
      return c.json({ ok: true, deviceKey: device.device_key, message: `Clocked out at ${localTime(now)} — ${formatHM(hrs)} counted (${localTime(roundTime(open.check_in_at))}–${localTime(roundTime(now))}). Waiting for supervisor approval.` });
    } catch (err) {
      if (/UNIQUE/.test(err.message)) return c.json({ error: "You're already clocked in." }, 409);
      throw err;
    }
  });

  // ---------- My hours ----------
  app.get('/me', requireWorker, async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const q = c.req.query('month');
    const ym = isMonth(q) ? q : localDate().slice(0, 7);
    const shifts = await db.all(`
      SELECT s.*, r.name AS reviewer_name FROM shifts s LEFT JOIN users r ON r.id = s.reviewed_by
      WHERE s.user_id = ? AND s.work_date LIKE ? ORDER BY s.check_in_at DESC
    `, user.id, `${ym}-%`);
    let approved = 0; let pending = 0;
    for (const x of shifts) {
      if (!x.check_out_at) continue;
      const h = paidHours(x.check_in_at, x.check_out_at);
      if (x.status === 'approved') approved += h; else if (x.status === 'pending') pending += h;
    }
    const rate = user.hourly_rate;

    return render(c, {
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
                  <span>${x.check_out_at ? html`<strong>${fmtHours(paidHours(x.check_in_at, x.check_out_at))} h</strong> ` : ''}${statusBadge(x)}</span>
                </div>
                <div>In ${clockTime(x.check_in_at)} → Out ${x.check_out_at ? clockTime(x.check_out_at) : '—'}${x.check_out_at && localDate(x.check_out_at) !== x.work_date ? html` <small class="muted">(next day)</small>` : ''}</div>
                ${x.reviewer_name ? html`<div class="muted small">${x.status === 'approved' ? 'Approved' : 'Rejected'} by ${x.reviewer_name} · ${prettyDate(localDate(x.reviewed_at))} ${localTime(x.reviewed_at)}</div>` : ''}
                ${x.review_note ? html`<div class="small">“${x.review_note}”</div>` : ''}
                ${flagList(x.flags, { forWorker: true, lateMin: minutesLate(x) })}
              </li>`)}
          </ul>` : html`<p class="muted">No shifts this month.</p>`}
        </section>`,
    });
  });
}

/** "Today", "Tomorrow" or "Mon 12 Oct". */
function dayName(date, today) {
  if (date === today) return 'Today';
  if (date === addDays(today, 1)) return 'Tomorrow';
  return prettyDate(date).replace(/ \d{4}$/, '');
}
