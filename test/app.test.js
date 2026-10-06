'use strict';

process.env.APP_TZ = 'Asia/Kuala_Lumpur';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../src/app');
const { localDate } = require('../src/time');

// A tiny tiny JPEG-looking payload (valid SOI marker, padded).
const SELFIE = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]).toString('base64');

function client(base, { userAgent = 'test-agent' } = {}) {
  const jar = new Map();
  return async function req(method, url, { form, json } = {}) {
    const headers = { origin: base, 'user-agent': userAgent };
    let body;
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    if (json) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
    const res = await fetch(base + url, { method, headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const v = pair.slice(i + 1);
      if (v && !/Expires=Thu, 01 Jan 1970/i.test(c)) jar.set(pair.slice(0, i), v); else jar.delete(pair.slice(0, i));
    }
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), text, headers: res.headers };
  };
}

test('end-to-end: setup, clock in/out, approve, export', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-'));
  const app = createApp({ dbPath: path.join(dir, 'test.db'), dataDir: dir });
  const server = app.listen(0);
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const sup = client(base);
  const wkr = client(base);

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
  // Selfies are off by default; turn them on to exercise that path.
  await sup('POST', '/admin/settings', { form: { geofence_mode: 'flag', selfie: 'in', ip_mode: 'off', allowed_ips: '' } });

  // Cross-site posts are blocked.
  const evil = await fetch(base + '/admin/sites', { method: 'POST', headers: { origin: 'https://evil.example' }, redirect: 'manual' });
  assert.equal(evil.status, 403);

  // Worker signs in (wrong PIN first).
  r = await wkr('POST', '/login', { form: { login: '0123456789', secret: '0000' } });
  assert.equal(r.status, 401);
  r = await wkr('POST', '/login', { form: { login: '0123456789', secret: '1234' } });
  assert.equal(r.location, '/');
  r = await wkr('GET', '/');
  assert.match(r.text, /not clocked in/);

  // Selfie required at check-in when enabled.
  r = await wkr('POST', '/api/clock', { json: { action: 'in', lat: 3.1391, lng: 101.6869, accuracy: 10 } });
  assert.equal(r.status, 400);
  r = await wkr('POST', '/api/clock', { json: { action: 'in', lat: 3.1391, lng: 101.6869, accuracy: 10, selfie: SELFIE } });
  assert.equal(r.status, 200, r.text);
  r = await wkr('POST', '/api/clock', { json: { action: 'in', lat: 3.1391, lng: 101.6869, selfie: SELFIE } });
  assert.equal(r.status, 409);

  // Supervisor sees who is working / absent.
  r = await sup('GET', '/admin');
  assert.match(r.text, /Working now/);
  assert.match(r.text, /Absent Ann/);

  // Clock out far away -> flagged, not blocked (default "flag" mode).
  r = await wkr('POST', '/api/clock', { json: { action: 'out', lat: 3.2, lng: 101.7, accuracy: 10 } });
  assert.equal(r.status, 200, r.text);

  const db = app.locals.db;
  const shift = db.prepare('SELECT * FROM shifts').get();
  assert.equal(shift.flags, 'out:outside_area');
  assert.equal(shift.in_site, 'Venue');
  assert.ok(shift.in_selfie);

  // Worker can view their own selfie; another person's file path is 404.
  assert.equal((await wkr('GET', `/selfies/${shift.in_selfie}`)).status, 200);
  assert.equal((await wkr('GET', '/selfies/' + 'a'.repeat(32) + '.jpg')).status, 404);
  // Workers can't reach admin pages.
  assert.equal((await wkr('GET', '/admin')).location, '/');

  // Supervisor corrects times (8h shift) and approves.
  const today = localDate();
  r = await sup('POST', `/admin/shifts/${shift.id}/edit`, { form: { work_date: today, in_time: '00:00', out_time: '00:00', approve: '1', reason: 'test' } });
  // out <= in on same day is treated as overnight, which would be in the future → rejected
  assert.equal(r.status, 400);
  const yesterday = new Date(Date.now() - 86400000);
  const yDate = localDate(yesterday);
  r = await sup('POST', `/admin/shifts/${shift.id}/edit`, { form: { work_date: yDate, in_time: '09:00', out_time: '17:00', reason: 'fixed' } });
  assert.equal(r.status, 302);
  r = await sup('POST', '/admin/shifts/approve', { form: { ids: String(shift.id), back: '/admin/pending' } });
  assert.match(r.location, /Approved%201%20shift/);

  // Worker summary shows approver.
  r = await wkr('GET', `/me?month=${yDate.slice(0, 7)}`);
  assert.match(r.text, /Sam Supervisor/);
  assert.match(r.text, /8\.00/);

  // Manual shift for the absent worker, left pending.
  const ann = db.prepare("SELECT id FROM users WHERE login = 'ann'").get();
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
  assert.match(r.text, /Added by supervisor/);
  assert.match(r.text, /Checked out outside area; Times edited/);

  // Pages render without errors.
  for (const url of ['/admin', '/admin/pending', '/admin/export', '/admin/people', '/admin/settings', `/admin/shifts/${shift.id}`, '/admin/shifts/new']) {
    assert.equal((await sup('GET', url)).status, 200, url);
  }
});

test('block mode rejects check-ins outside the geofence', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-'));
  const app = createApp({ dbPath: path.join(dir, 'test.db'), dataDir: dir });
  const server = app.listen(0);
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const sup = client(base);
  const wkr = client(base);
  await sup('POST', '/setup', { form: { name: 'S', login: 's', secret: 'password1' } });
  await sup('POST', '/admin/people', { form: { name: 'W', login: 'w', role: 'worker', secret: '1111' } });
  await sup('POST', '/admin/sites', { form: { name: 'Venue', lat: '3.139', lng: '101.6869', radius_m: '100' } });
  await sup('POST', '/admin/settings', { form: { geofence_mode: 'block', selfie: 'none', ip_mode: 'off', allowed_ips: '' } });
  await wkr('POST', '/login', { form: { login: 'w', secret: '1111' } });

  let r = await wkr('POST', '/api/clock', { json: { action: 'in' } });
  assert.equal(r.status, 400);
  r = await wkr('POST', '/api/clock', { json: { action: 'in', lat: 3.2, lng: 101.7, accuracy: 5 } });
  assert.equal(r.status, 403);
  r = await wkr('POST', '/api/clock', { json: { action: 'in', lat: 3.1391, lng: 101.6869, accuracy: 5 } });
  assert.equal(r.status, 200);
});

test('login is locked after repeated failures', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-'));
  const app = createApp({ dbPath: path.join(dir, 'test.db'), dataDir: dir });
  const server = app.listen(0);
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const c = client(base);
  await c('POST', '/setup', { form: { name: 'S', login: 's', secret: 'password1' } });
  const anon = client(base);
  for (let i = 0; i < 5; i++) await anon('POST', '/login', { form: { login: 's', secret: 'wrong' } });
  const r = await anon('POST', '/login', { form: { login: 's', secret: 'password1' } });
  assert.equal(r.status, 429);
});

test('a forgotten clock-out is auto-closed and must be fixed before approval', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-'));
  const app = createApp({ dbPath: path.join(dir, 'test.db'), dataDir: dir });
  const server = app.listen(0);
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const sup = client(base);
  const wkr = client(base);
  await sup('POST', '/setup', { form: { name: 'S', login: 's', secret: 'password1' } });
  await sup('POST', '/admin/settings', { form: { geofence_mode: 'off', selfie: 'none', ip_mode: 'off', allowed_ips: '' } });
  await sup('POST', '/admin/people', { form: { name: 'W', login: 'w', role: 'worker', secret: '1111' } });
  await wkr('POST', '/login', { form: { login: 'w', secret: '1111' } });
  assert.equal((await wkr('POST', '/api/clock', { json: { action: 'in' } })).status, 200);

  // Pretend the check-in was 20 hours ago and they never clocked out.
  const db = app.locals.db;
  const old = new Date(Date.now() - 20 * 3600000).toISOString();
  db.prepare('UPDATE shifts SET check_in_at = ?, work_date = ?').run(old, localDate(old));

  let r = await wkr('GET', '/');
  assert.match(r.text, /didn't clock out/);
  assert.match(r.text, /Clock IN/);
  assert.equal((await wkr('POST', '/api/clock', { json: { action: 'in' } })).status, 200);

  const forgotten = db.prepare('SELECT * FROM shifts ORDER BY id LIMIT 1').get();
  assert.equal(forgotten.flags, 'no_checkout');
  assert.equal(forgotten.check_out_at, forgotten.check_in_at);

  // Bulk approve skips it; supervisor must enter the real time first.
  await sup('POST', '/admin/shifts/approve', { form: { ids: String(forgotten.id) } });
  assert.equal(db.prepare('SELECT status FROM shifts WHERE id = ?').get(forgotten.id).status, 'pending');
  r = await sup('POST', `/admin/shifts/${forgotten.id}/edit`, { form: { work_date: forgotten.work_date, in_time: '', out_time: '' } });
  assert.equal(r.status, 400);
  const { localTime } = require('../src/time');
  const outLocal = localTime(new Date(Date.parse(old) + 6 * 3600000));
  r = await sup('POST', `/admin/shifts/${forgotten.id}/edit`, {
    form: { work_date: forgotten.work_date, in_time: localTime(old), out_time: outLocal, approve: '1' },
  });
  assert.equal(r.status, 302);
  const fixed = db.prepare('SELECT * FROM shifts WHERE id = ?').get(forgotten.id);
  assert.equal(fixed.status, 'approved');
  assert.equal(fixed.flags, 'edited');
  assert.equal(Math.round((Date.parse(fixed.check_out_at) - Date.parse(fixed.check_in_at)) / 3600000), 6);
});

test('devices: new, shared and changed devices are flagged for supervisors only', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-'));
  const app = createApp({ dbPath: path.join(dir, 'test.db'), dataDir: dir });
  const server = app.listen(0);
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const db = app.locals.db;
  const flagsOf = (id) => db.prepare('SELECT flags FROM shifts WHERE id = ?').get(id).flags;
  const lastId = () => db.prepare('SELECT MAX(id) AS id FROM shifts').get().id;

  const sup = client(base);
  await sup('POST', '/setup', { form: { name: 'S', login: 's', secret: 'password1' } });
  await sup('POST', '/admin/settings', { form: { geofence_mode: 'off', selfie: 'none', ip_mode: 'off', allowed_ips: '' } });
  await sup('POST', '/admin/people', { form: { name: 'Alice', login: 'alice', role: 'worker', secret: '1111' } });
  await sup('POST', '/admin/people', { form: { name: 'Bob', login: 'bob', role: 'worker', secret: '2222' } });

  const iphoneUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  const alicePhone = client(base, { userAgent: iphoneUa });
  await alicePhone('POST', '/login', { form: { login: 'alice', secret: '1111' } });

  // First ever check-in: nothing to compare against, so no flag.
  let r = await alicePhone('POST', '/api/clock', { json: { action: 'in' } });
  assert.equal(r.status, 200);
  assert.ok(JSON.parse(r.text).deviceKey);
  await alicePhone('POST', '/api/clock', { json: { action: 'out' } });
  assert.equal(flagsOf(lastId()), '');

  // Same phone again: still no flag.
  await alicePhone('POST', '/api/clock', { json: { action: 'in' } });
  assert.equal(flagsOf(lastId()), '');

  // Clocking out from another phone.
  const otherPhone = client(base, { userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-A515F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36' });
  await otherPhone('POST', '/login', { form: { login: 'alice', secret: '1111' } });
  r = await otherPhone('POST', '/api/clock', { json: { action: 'out' } });
  assert.equal(r.status, 200);
  assert.equal(flagsOf(lastId()), 'out:new_device,out:device_changed');

  // Bob signs in on Alice's phone (the device cookie survives log-out).
  await alicePhone('POST', '/logout');
  await alicePhone('POST', '/login', { form: { login: 'bob', secret: '2222' } });
  r = await alicePhone('POST', '/api/clock', { json: { action: 'in' } });
  assert.equal(r.status, 200);
  assert.doesNotMatch(JSON.parse(r.text).message, /device/i);
  const bobShift = lastId();
  assert.equal(flagsOf(bobShift), 'in:shared_device');

  // The device key also works from localStorage if the cookie was lost.
  const aliceKey = db.prepare('SELECT device_key FROM devices WHERE label LIKE ?').get('iPhone%').device_key;
  const fresh = client(base, { userAgent: iphoneUa });
  await fresh('POST', '/login', { form: { login: 'alice', secret: '1111' } });
  await fresh('POST', '/api/clock', { json: { action: 'in', deviceKey: aliceKey } });
  assert.equal(flagsOf(lastId()), 'in:shared_device');

  // Supervisor sees the device and who else used it.
  r = await sup('GET', `/admin/shifts/${bobShift}`);
  assert.match(r.text, /iPhone · iOS 17\.5 · Safari #/);
  assert.match(r.text, /Also used by: Alice/);
  r = await sup('GET', '/admin/people/' + db.prepare("SELECT id FROM users WHERE login = 'alice'").get().id);
  assert.match(r.text, /Devices used/);
  assert.match(r.text, /SM-A515F · Android 13 · Chrome/);
  r = await sup('GET', `/admin/export/detail.csv?month=${localDate().slice(0, 7)}`);
  assert.match(r.text, /Check-in Device/);
  assert.match(r.text, /Device also used by another worker/);

  // Workers never see device info.
  r = await alicePhone('GET', '/me');
  assert.doesNotMatch(r.text, /iPhone|📱|new device|device also used|different device/i);
  r = await alicePhone('GET', '/');
  assert.doesNotMatch(r.text, /iPhone|📱|new device|device also used|different device/i);
});
