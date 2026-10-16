import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { NodeDb } from '../src/db-node.js';
import { localDate, setTimeZone } from '../src/time.js';

setTimeZone('Asia/Kuala_Lumpur');

/** A fresh app on an in-memory database, plus a cookie-keeping client factory. */
function makeApp() {
  const db = new NodeDb(':memory:');
  const app = createApp({ dbFor: () => db, getIp: () => '127.0.0.1' });
  function client({ userAgent = 'test-agent' } = {}) {
    const jar = new Map();
    return async function req(method, url, { form, json } = {}) {
      const headers = { origin: 'http://localhost', 'user-agent': userAgent };
      let body;
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
      if (json) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
      const res = await app.request(url, { method, headers, body });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        const v = pair.slice(i + 1);
        if (v && !/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)) jar.set(pair.slice(0, i), v); else jar.delete(pair.slice(0, i));
      }
      const text = await res.text();
      return { status: res.status, location: res.headers.get('location'), text, headers: res.headers };
    };
  }
  return { app, db, client };
}

test('end-to-end: setup, clock in/out, approve, export', async () => {
  const { app, db, client } = makeApp();
  const sup = client();
  const wkr = client();

  // First run redirects to setup.
  assert.equal((await sup('GET', '/login')).location, '/setup');
  let r = await sup('POST', '/setup', { form: { name: 'Sam Supervisor', login: 'sam', secret: 'supersecret' } });
  assert.equal(r.status, 302);

  // Add a worker and a site.
  r = await sup('POST', '/admin/people', { form: { name: 'Wei Worker', login: '0123456789', role: 'worker', secret: '1234', hourly_rate: '12.5' } });
  assert.equal(r.status, 302);
  r = await sup('POST', '/admin/people', { form: { name: 'Absent Ann', login: 'ann', role: 'worker', secret: '9999' } });
  assert.equal(r.status, 302);
  r = await sup('POST', '/admin/sites', { form: { name: 'Venue', lat: '3.139', lng: '101.6869', radius_m: '150' } });
  assert.equal(r.status, 302);

  // Cross-site posts are blocked.
  const evil = await app.request('/admin/sites', { method: 'POST', headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);

  // Worker signs in (wrong PIN first).
  r = await wkr('POST', '/login', { form: { login: '0123456789', secret: '0000' } });
  assert.equal(r.status, 401);
  r = await wkr('POST', '/login', { form: { login: '0123456789', secret: '1234' } });
  assert.equal(r.location, '/');
  r = await wkr('GET', '/');
  assert.match(r.text, /not clocked in/);

  r = await wkr('POST', '/api/clock', { json: { action: 'in', lat: 3.1391, lng: 101.6869, accuracy: 10 } });
  assert.equal(r.status, 200, r.text);
  r = await wkr('POST', '/api/clock', { json: { action: 'in', lat: 3.1391, lng: 101.6869 } });
  assert.equal(r.status, 409);

  // Supervisor sees who is working / absent.
  r = await sup('GET', '/admin');
  assert.match(r.text, /Working now/);
  assert.match(r.text, /Absent Ann/);

  // Clock out far away -> flagged, not blocked (default "flag" mode).
  r = await wkr('POST', '/api/clock', { json: { action: 'out', lat: 3.2, lng: 101.7, accuracy: 10 } });
  assert.equal(r.status, 200, r.text);

  const shift = (await db.get('SELECT * FROM shifts'));
  assert.equal(shift.flags, 'out:outside_area');
  assert.equal(shift.in_site, 'Venue');
  // Workers can't reach admin pages.
  assert.equal((await wkr('GET', '/admin')).location, '/');

  // Supervisor corrects times (8h shift) and approves.
  const today = localDate();
  r = await sup('POST', `/admin/shifts/${shift.id}/edit`, { form: { work_date: today, in_time: '00:00', out_time: '00:00', approve: '1', reason: 'test' } });
  // out <= in on same day is treated as overnight, which would be in the future → rejected
  assert.equal(r.status, 400);
  const yesterday = new Date(Date.now() - 86400000);
  const yDate = localDate(yesterday);
  r = await sup('POST', `/admin/shifts/${shift.id}/edit`, { form: { work_date: yDate, in_time: '08:53', out_time: '17:07', reason: 'fixed' } });
  assert.equal(r.status, 302);
  r = await sup('POST', '/admin/shifts/approve', { form: { ids: String(shift.id), back: '/admin/pending' } });
  assert.match(r.location, /Approved%201%20shift/);

  // Worker summary shows approver.
  r = await wkr('GET', `/me?month=${yDate.slice(0, 7)}`);
  assert.match(r.text, /Sam Supervisor/);
  assert.match(r.text, /8\.00/);

  // Manual shift for the absent worker, left pending.
  const ann = (await db.get("SELECT id FROM users WHERE login = 'ann'"));
  r = await sup('POST', '/admin/shifts/new', { form: { user_id: String(ann.id), work_date: yDate, in_time: '10:00', out_time: '14:30' } });
  assert.equal(r.status, 302);

  // Exports.
  const ym = yDate.slice(0, 7);
  r = await sup('GET', `/admin/export/summary.csv?month=${ym}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  const lines = r.text.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines.length, 4); // header, 2 workers, total
  const wei = lines.find((l) => l.includes('Wei Worker')).split(',');
  assert.equal(wei[6], '8'); // approved hours
  assert.equal(wei[11], '100'); // 8h * 12.5
  const annRow = lines.find((l) => l.includes('Absent Ann')).split(',');
  assert.equal(annRow[6], '0');
  assert.equal(annRow[7], '4.5'); // pending

  r = await sup('GET', `/admin/export/detail.csv?month=${ym}`);
  assert.match(r.text, /Approved,Sam Supervisor/);
  // Actual and rounded times, rounded hours and actual hours.
  assert.match(r.text, /08:53,\d{4}-\d{2}-\d{2} 17:07,\d{4}-\d{2}-\d{2} 09:00,\d{4}-\d{2}-\d{2} 17:00,8,8\.23,Approved/);
  assert.match(r.text, /Added by supervisor/);
  assert.match(r.text, /Checked out outside area; Times edited/);

  // Pages render without errors.
  for (const url of ['/admin', '/admin/pending', '/admin/export', '/admin/people', '/admin/settings', `/admin/shifts/${shift.id}`, '/admin/shifts/new']) {
    assert.equal((await sup('GET', url)).status, 200, url);
  }
});

test('block mode rejects check-ins outside the geofence', async () => {
  const { app, db, client } = makeApp();
  const sup = client();
  const wkr = client();
  await sup('POST', '/setup', { form: { name: 'S', login: 's', secret: 'password1' } });
  await sup('POST', '/admin/people', { form: { name: 'W', login: 'w', role: 'worker', secret: '1111' } });
  await sup('POST', '/admin/sites', { form: { name: 'Venue', lat: '3.139', lng: '101.6869', radius_m: '100' } });
  await sup('POST', '/admin/settings', { form: { geofence_mode: 'block', ip_mode: 'off', allowed_ips: '' } });
  await wkr('POST', '/login', { form: { login: 'w', secret: '1111' } });

  let r = await wkr('POST', '/api/clock', { json: { action: 'in' } });
  assert.equal(r.status, 400);
  r = await wkr('POST', '/api/clock', { json: { action: 'in', lat: 3.2, lng: 101.7, accuracy: 5 } });
  assert.equal(r.status, 403);
  r = await wkr('POST', '/api/clock', { json: { action: 'in', lat: 3.1391, lng: 101.6869, accuracy: 5 } });
  assert.equal(r.status, 200);
});

test('require mode needs a location but only flags clock-ins outside the area', async () => {
  const { client } = makeApp();
  const sup = client();
  const wkr = client();
  await sup('POST', '/setup', { form: { name: 'S', login: 's', secret: 'password1' } });
  await sup('POST', '/admin/people', { form: { name: 'W', login: 'w', role: 'worker', secret: '1111' } });
  await sup('POST', '/admin/sites', { form: { name: 'Venue', lat: '3.139', lng: '101.6869', radius_m: '100' } });
  await sup('POST', '/admin/settings', { form: { geofence_mode: 'require', ip_mode: 'off', allowed_ips: '' } });
  await wkr('POST', '/login', { form: { login: 'w', secret: '1111' } });
  let r = await wkr('GET', '/');
  assert.match(r.text, /data-location="require"/);
  assert.match(r.text, /Location is required to clock in/);

  r = await wkr('POST', '/api/clock', { json: { action: 'in' } });
  assert.equal(r.status, 400);
  assert.match(r.text, /Location is required/);
  r = await wkr('POST', '/api/clock', { json: { action: 'in', lat: 3.2, lng: 101.7, accuracy: 5 } });
  assert.equal(r.status, 200, r.text);
  r = await wkr('POST', '/api/clock', { json: { action: 'out' } });
  assert.equal(r.status, 400); // clocking out needs a location too
  r = await wkr('POST', '/api/clock', { json: { action: 'out', lat: 3.1391, lng: 101.6869, accuracy: 5 } });
  assert.equal(r.status, 200, r.text);
});

test('login is locked after repeated failures', async () => {
  const { app, db, client } = makeApp();
  const c = client();
  await c('POST', '/setup', { form: { name: 'S', login: 's', secret: 'password1' } });
  const anon = client();
  for (let i = 0; i < 5; i++) await anon('POST', '/login', { form: { login: 's', secret: 'wrong' } });
  const r = await anon('POST', '/login', { form: { login: 's', secret: 'password1' } });
  assert.equal(r.status, 429);
});

test('a forgotten clock-out is auto-closed and must be fixed before approval', async () => {
  const { app, db, client } = makeApp();
  const sup = client();
  const wkr = client();
  await sup('POST', '/setup', { form: { name: 'S', login: 's', secret: 'password1' } });
  await sup('POST', '/admin/settings', { form: { geofence_mode: 'off', ip_mode: 'off', allowed_ips: '' } });
  await sup('POST', '/admin/people', { form: { name: 'W', login: 'w', role: 'worker', secret: '1111' } });
  await wkr('POST', '/login', { form: { login: 'w', secret: '1111' } });
  assert.equal((await wkr('POST', '/api/clock', { json: { action: 'in' } })).status, 200);

  // Pretend the check-in was 20 hours ago and they never clocked out.
  const old = new Date(Date.now() - 20 * 3600000).toISOString();
  (await db.run('UPDATE shifts SET check_in_at = ?, work_date = ?', old, localDate(old)));

  let r = await wkr('GET', '/');
  assert.match(r.text, /didn't clock out/);
  assert.match(r.text, /Clock IN/);
  assert.equal((await wkr('POST', '/api/clock', { json: { action: 'in' } })).status, 200);

  const forgotten = (await db.get('SELECT * FROM shifts ORDER BY id LIMIT 1'));
  assert.equal(forgotten.flags, 'no_checkout');
  assert.equal(forgotten.check_out_at, forgotten.check_in_at);

  // Bulk approve skips it; supervisor must enter the real time first.
  await sup('POST', '/admin/shifts/approve', { form: { ids: String(forgotten.id) } });
  assert.equal((await db.get('SELECT status FROM shifts WHERE id = ?', forgotten.id)).status, 'pending');
  r = await sup('POST', `/admin/shifts/${forgotten.id}/edit`, { form: { work_date: forgotten.work_date, in_time: '', out_time: '' } });
  assert.equal(r.status, 400);
  const { localTime } = await import('../src/time.js');
  const outLocal = localTime(new Date(Date.parse(old) + 6 * 3600000));
  r = await sup('POST', `/admin/shifts/${forgotten.id}/edit`, {
    form: { work_date: forgotten.work_date, in_time: localTime(old), out_time: outLocal, approve: '1' },
  });
  assert.equal(r.status, 302);
  const fixed = (await db.get('SELECT * FROM shifts WHERE id = ?', forgotten.id));
  assert.equal(fixed.status, 'approved');
  assert.equal(fixed.flags, 'edited');
  assert.equal(Math.round((Date.parse(fixed.check_out_at) - Date.parse(fixed.check_in_at)) / 3600000), 6);
});

test('devices: registered phone, shared and changed devices are flagged for supervisors only', async () => {
  const { app, db, client } = makeApp();
  const flagsOf = async (id) => (await db.get('SELECT flags FROM shifts WHERE id = ?', id)).flags;
  const lastId = async () => (await db.get('SELECT MAX(id) AS id FROM shifts')).id;

  const sup = client();
  await sup('POST', '/setup', { form: { name: 'S', login: 's', secret: 'password1' } });
  await sup('POST', '/admin/settings', { form: { geofence_mode: 'off', ip_mode: 'off', allowed_ips: '', device_mode: 'flag', device_alert_count: '3' } });
  await sup('POST', '/admin/people', { form: { name: 'Alice', login: 'alice', role: 'worker', secret: '1111' } });
  await sup('POST', '/admin/people', { form: { name: 'Bob', login: 'bob', role: 'worker', secret: '2222' } });
  const aliceId = (await db.get("SELECT id FROM users WHERE login = 'alice'")).id;

  const iphoneUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  const alicePhone = client({ userAgent: iphoneUa });
  await alicePhone('POST', '/login', { form: { login: 'alice', secret: '1111' } });

  // First ever check-in registers the phone automatically: no flag.
  let r = await alicePhone('POST', '/api/clock', { json: { action: 'in' } });
  assert.equal(r.status, 200);
  assert.ok(JSON.parse(r.text).deviceKey);
  await alicePhone('POST', '/api/clock', { json: { action: 'out' } });
  assert.equal((await flagsOf(await lastId())), '');
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM worker_devices WHERE user_id = ? AND status = 'approved'", aliceId)).n, 1);

  // Same phone again: still no flag.
  await alicePhone('POST', '/api/clock', { json: { action: 'in' } });
  assert.equal((await flagsOf(await lastId())), '');

  // Clocking out from another phone.
  const otherPhone = client({ userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-A515F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36' });
  await otherPhone('POST', '/login', { form: { login: 'alice', secret: '1111' } });
  r = await otherPhone('POST', '/api/clock', { json: { action: 'out' } });
  assert.equal(r.status, 200);
  assert.equal((await flagsOf(await lastId())), 'out:unregistered_device,out:device_changed');

  // The supervisor dashboard lists it as a phone to review.
  r = await sup('GET', '/admin');
  assert.match(r.text, /Unregistered phones to review/);
  assert.match(r.text, /Alice — SM-A515F · Android 13 · Chrome/);

  // Bob signs in on Alice's phone (the device cookie survives log-out).
  await alicePhone('POST', '/logout');
  await alicePhone('POST', '/login', { form: { login: 'bob', secret: '2222' } });
  r = await alicePhone('POST', '/api/clock', { json: { action: 'in' } });
  assert.equal(r.status, 200);
  assert.doesNotMatch(JSON.parse(r.text).message, /device|phone/i);
  const bobShift = await lastId();
  // It's Bob's first phone so it registers for him, but it's shared with Alice.
  assert.equal((await flagsOf(bobShift)), 'in:shared_device');
  await alicePhone('POST', '/api/clock', { json: { action: 'out' } });

  // The device key also works from localStorage if the cookie was lost.
  const aliceKey = (await db.get('SELECT device_key FROM devices WHERE label LIKE ?', 'iPhone%')).device_key;
  const fresh = client({ userAgent: iphoneUa });
  await fresh('POST', '/login', { form: { login: 'alice', secret: '1111' } });
  await fresh('POST', '/api/clock', { json: { action: 'in', deviceKey: aliceKey } });
  assert.equal((await flagsOf(await lastId())), 'in:shared_device');
  await fresh('POST', '/api/clock', { json: { action: 'out' } });

  // Supervisor sees the device and who else used it.
  r = await sup('GET', `/admin/shifts/${bobShift}`);
  assert.match(r.text, /iPhone · iOS 17\.5 · Safari #/);
  assert.match(r.text, /Also used by: Alice/);
  r = await sup('GET', `/admin/people/${aliceId}`);
  assert.match(r.text, /Registered/);
  assert.match(r.text, /To review/);
  assert.match(r.text, /2 different phones in the last 30 days/);
  r = await sup('GET', `/admin/export/detail.csv?month=${localDate().slice(0, 7)}`);
  assert.match(r.text, /Check-in Device/);
  assert.match(r.text, /Device also used by another worker/);

  // Supervisor registers Alice's new Android phone: no more flag from it.
  const android = (await db.get('SELECT id FROM devices WHERE label LIKE ?', 'SM-A515F%')).id;
  r = await sup('POST', `/admin/people/${aliceId}/devices/${android}`, { form: { action: 'approve' } });
  assert.equal(r.status, 302);
  await otherPhone('POST', '/api/clock', { json: { action: 'in' } });
  assert.equal((await flagsOf(await lastId())), '');
  await otherPhone('POST', '/api/clock', { json: { action: 'out' } });

  // A third phone within 30 days trips the "many phones" alert.
  const thirdPhone = client({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36' });
  await thirdPhone('POST', '/login', { form: { login: 'alice', secret: '1111' } });
  await thirdPhone('POST', '/api/clock', { json: { action: 'in' } });
  assert.equal((await flagsOf(await lastId())), 'in:unregistered_device,in:many_devices');
  r = await sup('GET', '/admin');
  assert.match(r.text, /Frequent phone changes/);
  assert.match(r.text, /Alice \(3 phones\)/);
  r = await sup('GET', '/admin/people');
  assert.match(r.text, /🚩 3/);
  await thirdPhone('POST', '/api/clock', { json: { action: 'out' } });

  // Strict mode: only registered phones can clock in.
  await sup('POST', '/admin/settings', { form: { geofence_mode: 'off', ip_mode: 'off', allowed_ips: '', device_mode: 'block', device_alert_count: '3' } });
  r = await thirdPhone('POST', '/api/clock', { json: { action: 'in' } });
  assert.equal(r.status, 403);
  assert.match(JSON.parse(r.text).error, /isn't registered/);
  r = await otherPhone('POST', '/api/clock', { json: { action: 'in' } });
  assert.equal(r.status, 200);

  // Workers never see device info.
  r = await otherPhone('GET', '/me');
  assert.doesNotMatch(r.text, /iPhone|📱|registered|device also used|different device|many different/i);
  r = await otherPhone('GET', '/');
  assert.doesNotMatch(r.text, /iPhone|📱|registered|device also used|different device|many different/i);
});

test('bulk approval handles more shifts than one database query allows', async () => {
  const { db, client } = makeApp();
  const sup = client();
  await sup('POST', '/setup', { form: { name: 'S', login: 's', secret: 'password1' } });
  await sup('POST', '/admin/people', { form: { name: 'W', login: 'w', role: 'worker', secret: '1111' } });
  const { id: wid } = await db.get("SELECT id FROM users WHERE login = 'w'");
  const stmts = [];
  for (let i = 0; i < 150; i++) {
    const d = new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString();
    stmts.push(['INSERT INTO shifts (user_id, work_date, check_in_at, check_out_at) VALUES (?, ?, ?, ?)', wid, d.slice(0, 10), d, d]);
  }
  await db.batch(stmts);
  const ids = (await db.all('SELECT id FROM shifts')).map((r) => String(r.id));
  const body = new URLSearchParams([['back', '/admin/pending'], ...ids.map((id) => ['ids', id])]);
  const r = await sup('POST', '/admin/shifts/approve', { form: body });
  assert.match(r.location, /Approved%20150%20shifts/);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM audit WHERE action = 'approve'")).n, 150);
});

/** Supervisor + one worker, GPS off; returns clients and the worker's id. */
async function restaurant(settings = {}) {
  const ctx = makeApp();
  const sup = ctx.client();
  const wkr = ctx.client();
  await sup('POST', '/setup', { form: { name: 'Boss', login: 'boss', secret: 'password1' } });
  await sup('POST', '/admin/settings', { form: { geofence_mode: 'off', ip_mode: 'off', allowed_ips: '', device_mode: 'flag', ...settings } });
  await sup('POST', '/admin/people', { form: { name: 'Lim Kin Meng', login: '0123456789', short_name: 'KML', role: 'worker', secret: '1234' } });
  const { id } = await ctx.db.get("SELECT id FROM users WHERE login = '0123456789'");
  return { ...ctx, sup, wkr, uid: id };
}

test('working hours: late arrival, early leave, and a break counted once', async () => {
  const { localTime } = await import('../src/time.js');
  const start = new Date(Date.now() - 20 * 60000);
  const end = new Date(start.getTime() + 4 * 3600000);
  const { sup, wkr, db } = await restaurant({ attendance_mode: 'on', work_hours: `${localTime(start)}-${localTime(end)}`, late_grace_min: '5' });
  await wkr('POST', '/login', { form: { login: 'KML', secret: '1234' } });
  let r = await wkr('GET', '/');
  assert.match(r.text, /Working hours: <strong>/);
  assert.match(r.text, /Days off this week: \d of 1/);

  r = await wkr('POST', '/api/clock', { json: { action: 'in' } });
  assert.match(JSON.parse(r.text).message, /You're (20|21) min late/);
  await wkr('POST', '/api/clock', { json: { action: 'out' } });
  let first = await db.get('SELECT * FROM shifts ORDER BY id LIMIT 1');
  assert.equal(first.flags, 'in:late,out:left_early');
  assert.ok(first.sched_start && first.sched_end);
  r = await sup('GET', '/admin');
  assert.match(r.text, /Late (20|21) min/);
  assert.match(r.text, /Left \d+ min early/);

  // Back from a break: not late again, and the earlier clock-out wasn't leaving early after all.
  r = await wkr('POST', '/api/clock', { json: { action: 'in' } });
  assert.doesNotMatch(JSON.parse(r.text).message, /late/);
  first = await db.get('SELECT * FROM shifts ORDER BY id LIMIT 1');
  assert.equal(first.flags, 'in:late');
  assert.equal((await db.get('SELECT flags FROM shifts ORDER BY id DESC LIMIT 1')).flags, '');

  r = await sup('GET', '/admin/attendance');
  assert.equal(r.status, 200);
  assert.match(r.text, /href="\/admin\/attendance"/); // menu link once the record is on
  // The pay export is unchanged.
  r = await sup('GET', `/admin/export/summary.csv?month=${localDate().slice(0, 7)}`);
  assert.doesNotMatch(r.text, /Late/);
});

test('working hours: everyone’s in Settings, or a person’s own', async () => {
  const { sup, db, uid } = await restaurant({ attendance_mode: 'on', work_hours: '10-22' });
  assert.equal((await db.get("SELECT value FROM settings WHERE key = 'work_hours'")).value, '10:00-22:00');
  let r = await sup('POST', '/admin/settings', { form: { attendance_mode: 'on', work_hours: 'lunch', days_off_per_week: '1', late_grace_min: '5' } });
  assert.match(decodeURIComponent(r.location), /not the working hours/);
  assert.equal((await db.get("SELECT value FROM settings WHERE key = 'work_hours'")).value, '10:00-22:00');

  const person = { name: 'Lim Kin Meng', login: '0123456789', short_name: 'KML', role: 'worker', active: '1' };
  r = await sup('POST', `/admin/people/${uid}`, { form: { ...person, work_hours: 'evening' } });
  assert.equal(r.status, 400);
  r = await sup('POST', `/admin/people/${uid}`, { form: { ...person, work_hours: '5pm-11pm' } });
  assert.equal(r.status, 302);
  assert.equal((await db.get('SELECT work_hours FROM users WHERE id = ?', uid)).work_hours, '17:00-23:00');
  r = await sup('POST', `/admin/people/${uid}`, { form: { ...person, work_hours: '' } });
  assert.equal((await db.get('SELECT work_hours FROM users WHERE id = ?', uid)).work_hours, null);
});

test('attendance record: days off, extra days off, late and early', async () => {
  const { sup, db, uid } = await restaurant({ attendance_mode: 'on', work_hours: '10:00-22:00', days_off_per_week: '1', late_grace_min: '5' });
  await sup('POST', '/admin/people', { form: { name: 'Siti', login: '0198887777', short_name: 'SITI', role: 'worker', secret: '5678' } });
  const siti = (await db.get("SELECT id FROM users WHERE short_name = 'SITI'")).id;
  const { addDays, localToUtcIso } = await import('../src/time.js');
  const { slotTimes, weekStart } = await import('../src/schedule.js');
  const { attendanceReport } = await import('../src/attendance.js');
  const { getSettings } = await import('../src/db.js');

  // Last week, Monday to Sunday; both people were added before it.
  const mon = addDays(weekStart(localDate()), -7);
  const day = (i) => addDays(mon, i);
  await db.run('UPDATE users SET created_at = ?', localToUtcIso(addDays(mon, -30), '00:00'));
  const shift = (user, d, inT, outT) => {
    const t = slotTimes(d, '10:00', '22:00');
    return db.run('INSERT INTO shifts (user_id, work_date, check_in_at, check_out_at, sched_start, sched_end) VALUES (?, ?, ?, ?, ?, ?)',
      user, d, localToUtcIso(d, inT), localToUtcIso(d, outT), t.startIso, t.endIso);
  };
  // Lim: late Monday, a break and an early finish Tuesday, off Saturday and Sunday (one too many).
  await shift(uid, day(0), '10:12', '22:00');
  await shift(uid, day(1), '10:00', '15:00');
  await shift(uid, day(1), '15:30', '21:30');
  await shift(uid, day(2), '09:55', '22:03');
  await shift(uid, day(3), '10:00', '22:00');
  await shift(uid, day(4), '10:04', '21:56');
  // Siti: off Wednesday only.
  for (const i of [0, 1, 3, 4, 5, 6]) await shift(siti, day(i), '09:58', '22:01');

  const weekIncidents = async (settingsOverride = {}) => {
    const settings = { ...(await getSettings(db)), ...settingsOverride };
    const months = [...new Set([mon.slice(0, 7), day(6).slice(0, 7)])];
    const all = [];
    for (const ym of months) all.push(...(await attendanceReport(db, ym, settings)).incidents);
    return all.filter((x) => x.work_date >= mon && x.work_date <= day(6))
      .map((x) => `${x.name}|${x.work_date === mon ? 'Mon' : x.work_date === day(1) ? 'Tue' : x.work_date === day(6) ? 'Sun' : x.work_date}|${x.type}|${x.minutes ?? ''}`);
  };
  assert.deepEqual(await weekIncidents(), ['Lim Kin Meng|Mon|late|12', 'Lim Kin Meng|Tue|early|30', 'Lim Kin Meng|Sun|extra_off|']);
  // Two days off allowed: no extra day off.
  assert.deepEqual(await weekIncidents({ days_off_per_week: '2' }), ['Lim Kin Meng|Mon|late|12', 'Lim Kin Meng|Tue|early|30']);

  // The page and CSV.
  let r = await sup('GET', `/admin/attendance?month=${mon.slice(0, 7)}`);
  assert.match(r.text, /Extra day off/);
  assert.match(r.text, /in 10:12/);
  r = await sup('GET', `/admin/attendance.csv?month=${day(6).slice(0, 7)}`);
  assert.match(r.text, new RegExp(`${day(6)},Sun,Lim Kin Meng,KML,,Extra day off,,,,,`));
  r = await sup('GET', `/admin/attendance?month=${mon.slice(0, 7)}&user=${siti}`);
  assert.match(r.text, /Attendance <span class="muted">· Siti/);
  assert.doesNotMatch(r.text, /Lim Kin Meng/);

  // Lim forgot to clock in on Saturday: a supervisor adds the shift, and Saturday counts as worked.
  r = await sup('POST', '/admin/shifts/new', { form: { user_id: String(uid), work_date: day(5), in_time: '10:30', out_time: '22:00' } });
  assert.equal(r.status, 302);
  const sat = day(5) === mon ? 'Mon' : day(5);
  assert.deepEqual(await weekIncidents(), ['Lim Kin Meng|Mon|late|12', 'Lim Kin Meng|Tue|early|30', `Lim Kin Meng|${sat}|late|30`]);
});

test('outlets: clock-ins are filed under the nearest outlet and each can be viewed separately', async () => {
  const { localTime } = await import('../src/time.js');
  const at = (mins) => localTime(new Date(Date.now() + mins * 60000));
  // Everyone's hours started 30 min ago; KL's own hours start in 10 min.
  const { sup, db, client, uid } = await restaurant({
    geofence_mode: 'flag', attendance_mode: 'on', work_hours: `${at(-30)}-${at(240)}`, late_grace_min: '5',
  });
  await sup('POST', '/admin/sites', { form: { name: 'PJ', lat: '3.1073', lng: '101.6067', radius_m: '150' } });
  let r = await sup('POST', '/admin/sites', { form: { name: 'KL', lat: '3.1478', lng: '101.7110', radius_m: '150', work_hours: 'lunch' } });
  assert.match(decodeURIComponent(r.location), /Could not add site: working hours/);
  await sup('POST', '/admin/sites', { form: { name: 'KL', lat: '3.1478', lng: '101.7110', radius_m: '150', work_hours: `${at(10)}-${at(300)}` } });
  await sup('POST', '/admin/people', { form: { name: 'Siti', login: '0198887777', short_name: 'SITI', role: 'worker', secret: '5678' } });

  const lim = client();
  const siti = client();
  await lim('POST', '/login', { form: { login: 'KML', secret: '1234' } });
  await siti('POST', '/login', { form: { login: 'SITI', secret: '5678' } });
  r = await lim('POST', '/api/clock', { json: { action: 'in', lat: 3.1074, lng: 101.6068, accuracy: 10 } });
  assert.match(JSON.parse(r.text).message, /Clocked in at PJ at .* You're (30|31) min late/);
  r = await siti('POST', '/api/clock', { json: { action: 'in', lat: 3.1479, lng: 101.7111, accuracy: 10 } });
  assert.match(JSON.parse(r.text).message, /Clocked in at KL at/);
  assert.doesNotMatch(JSON.parse(r.text).message, /late/); // KL's own hours haven't started
  assert.deepEqual((await db.all('SELECT in_site, flags FROM shifts ORDER BY id')).map((x) => `${x.in_site}:${x.flags}`), ['PJ:in:late', 'KL:']);

  // Dashboard: all outlets, then each one.
  r = await sup('GET', '/admin');
  assert.match(r.text, /All outlets/);
  assert.match(r.text, /<th>Outlet<\/th>/);
  r = await sup('GET', '/admin?outlet=PJ');
  assert.match(r.text, /Check-ins today at PJ/);
  assert.match(r.text, /Lim Kin Meng/);
  assert.doesNotMatch(r.text, /Siti/);
  r = await sup('GET', '/admin?outlet=Nowhere'); // unknown outlet: everything
  assert.match(r.text, /Siti/);

  // Attendance per outlet.
  await lim('POST', '/api/clock', { json: { action: 'out', lat: 3.1074, lng: 101.6068 } });
  const ym = localDate().slice(0, 7);
  r = await sup('GET', `/admin/attendance?month=${ym}&outlet=PJ`);
  assert.match(r.text, /Attendance <span class="muted">· PJ/);
  assert.match(r.text, /Lim Kin Meng/);
  assert.doesNotMatch(r.text, /Siti/);
  r = await sup('GET', `/admin/attendance.csv?month=${ym}`);
  assert.match(r.text, /Lim Kin Meng,KML,PJ,Late,/);
  r = await sup('GET', `/admin/attendance.csv?month=${ym}&outlet=KL`);
  assert.match(r.headers.get('content-disposition'), /attendance-record-\d{4}-\d{2}-KL\.csv/);
  assert.doesNotMatch(r.text, /Lim Kin Meng,KML,PJ/);

  // Pay export per outlet.
  r = await sup('GET', `/admin/export/summary.csv?month=${ym}&outlet=KL`);
  assert.match(r.text, /Siti/);
  assert.doesNotMatch(r.text, /Lim Kin Meng/);
  r = await sup('GET', `/admin/export?month=${ym}&outlet=PJ`);
  assert.match(r.text, /summary\.csv\?month=\d{4}-\d{2}&amp;outlet=PJ/);

  // A shift added by hand is filed under the chosen outlet and uses its hours.
  const { addDays } = await import('../src/time.js');
  const yesterday = addDays(localDate(), -1);
  r = await sup('POST', '/admin/shifts/new', { form: { user_id: String(uid), outlet: 'KL', work_date: yesterday, in_time: '12:00', out_time: '13:00' } });
  assert.equal(r.status, 302);
  assert.equal((await db.get('SELECT in_site FROM shifts ORDER BY id DESC LIMIT 1')).in_site, 'KL');

  // Outlet hours can be changed or cleared.
  const kl = await db.get("SELECT id FROM sites WHERE name = 'KL'");
  await sup('POST', `/admin/sites/${kl.id}/hours`, { form: { work_hours: '' } });
  assert.equal((await db.get('SELECT work_hours FROM sites WHERE id = ?', kl.id)).work_hours, null);
});

test('selfie: required, stored with the shift and shown to supervisors only', async () => {
  const { sup, wkr, db } = await restaurant({ selfie_mode: 'block' });
  await wkr('POST', '/login', { form: { login: 'KML', secret: '1234' } });
  let r = await wkr('GET', '/');
  assert.match(r.text, /Tap to take a selfie/);
  r = await wkr('POST', '/api/clock', { json: { action: 'in' } });
  assert.equal(r.status, 400);
  r = await wkr('POST', '/api/clock', { json: { action: 'in', selfie: 'data:image/png;base64,AAAA' } });
  assert.equal(r.status, 400);

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  r = await wkr('POST', '/api/clock', { json: { action: 'in', selfie: `data:image/jpeg;base64,${jpeg.toString('base64')}` } });
  assert.equal(r.status, 200, r.text);
  const photo = await db.get('SELECT * FROM photos');
  const shift = await db.get('SELECT * FROM shifts');
  assert.equal(photo.shift_id, shift.id);
  // Old photos are pruned.
  await db.run('INSERT INTO photos (shift_id, kind, data, taken_at) VALUES (?, ?, ?, ?)', shift.id, 'in', 'AAAA', '2020-01-01T00:00:00Z');

  r = await sup('GET', `/admin/shifts/${shift.id}`);
  assert.match(r.text, new RegExp(`src="/admin/photos/${photo.id}"`));
  const img = await sup('GET', `/admin/photos/${photo.id}`);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.equal((await wkr('GET', `/admin/photos/${photo.id}`)).status, 302);

  await wkr('POST', '/api/clock', { json: { action: 'out' } });
  await wkr('POST', '/api/clock', { json: { action: 'in', selfie: `data:image/jpeg;base64,${jpeg.toString('base64')}` } });
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM photos')).n, 2);

  // "Ask" mode lets them skip it, flagged.
  await sup('POST', '/admin/settings', { form: { geofence_mode: 'off', ip_mode: 'off', selfie_mode: 'flag' } });
  await wkr('POST', '/api/clock', { json: { action: 'out' } });
  r = await wkr('POST', '/api/clock', { json: { action: 'in' } });
  assert.equal(r.status, 200);
  assert.equal((await db.get('SELECT flags FROM shifts ORDER BY id DESC LIMIT 1')).flags, 'in:no_selfie');
});

test('older databases gain the new columns', async () => {
  const { ensureSchema } = await import('../src/db.js');
  const db = new NodeDb(':memory:');
  await ensureSchema(db);
  await db.run('DROP INDEX users_short_name');
  await db.run('ALTER TABLE users DROP COLUMN short_name');
  await db.run('ALTER TABLE shifts DROP COLUMN sched_start');
  await db.run('ALTER TABLE shifts DROP COLUMN sched_end');
  await ensureSchema(db);
  await ensureSchema(db); // idempotent
  const cols = (t) => db.all(`PRAGMA table_info(${t})`).then((rows) => rows.map((r) => r.name));
  assert.ok((await cols('users')).includes('short_name'));
  assert.ok((await cols('shifts')).includes('sched_end'));
});

test('APP_NAME sets the name shown in the app', async () => {
  process.env.APP_NAME = 'Makan Place';
  try {
    const { client } = makeApp();
    const r = await client()('GET', '/setup');
    assert.match(r.text, /<title>First-time setup · Makan Place<\/title>/);
  } finally {
    delete process.env.APP_NAME;
  }
});
