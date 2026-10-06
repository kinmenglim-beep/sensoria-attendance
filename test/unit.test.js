import test from 'node:test';
import assert from 'node:assert/strict';

import * as time from '../src/time.js';
import { checkGeofence, ipAllowed, distanceMeters } from '../src/verify.js';
import { toCsv } from '../src/csv.js';
import { html } from '../src/views.js';
import { describeDevice } from '../src/device.js';
import { hashSecret, verifySecret } from '../src/auth.js';

time.setTimeZone('Asia/Kuala_Lumpur');

test('local time conversions use the app time zone', () => {
  assert.equal(time.localToUtcIso('2026-10-05', '09:00'), '2026-10-05T01:00:00.000Z');
  assert.equal(time.localDate('2026-10-04T17:30:00.000Z'), '2026-10-05');
  assert.equal(time.localTime('2026-10-04T17:30:00.000Z'), '01:30');
  assert.equal(time.hoursBetween('2026-10-05T01:00:00Z', '2026-10-05T09:30:00Z'), 8.5);
  assert.equal(time.daysInMonth('2026-02'), 28);
  assert.equal(time.addMonths('2026-12', 1), '2027-01');
  assert.equal(time.addDays('2026-10-31', 1), '2026-11-01');
});

test('geofence uses radius plus capped GPS accuracy', () => {
  const site = { name: 'Venue', lat: 3.1390, lng: 101.6869, radius_m: 100 };
  const near = checkGeofence(3.1395, 101.6869, 10, [site]); // ~55 m
  assert.equal(near.inside, true);
  const far = checkGeofence(3.1500, 101.6869, 10, [site]); // ~1.2 km
  assert.equal(far.inside, false);
  const vague = checkGeofence(3.1500, 101.6869, 5000, [site]); // accuracy capped at 100 m
  assert.equal(vague.inside, false);
  assert.equal(checkGeofence(0, 0, 0, []), null);
  assert.ok(Math.abs(distanceMeters(0, 0, 0, 1) - 111195) < 10);
});

test('ip allow list supports exact, CIDR and prefix entries', () => {
  assert.ok(ipAllowed('::ffff:203.0.113.25', ['203.0.113.25']));
  assert.ok(ipAllowed('198.51.100.77', ['198.51.100.0/24']));
  assert.ok(!ipAllowed('198.51.101.77', ['198.51.100.0/24']));
  assert.ok(ipAllowed('2001:db8:1:2::abcd', ['2001:db8:1:2:*']));
  assert.ok(!ipAllowed('10.0.0.1', []));
});

test('csv escapes quotes, commas and formula injection', () => {
  const out = toCsv([['a,b', 'say "hi"', '=SUM(A1)', 1.5, null]]);
  assert.equal(out, '﻿"a,b","say ""hi""",\'=SUM(A1),1.5,\r\n');
});

test('html template escapes interpolated values', () => {
  assert.equal(html`<p>${'<script>'}</p>`.toString(), '<p>&lt;script&gt;</p>');
  assert.equal(html`<p>${html`<b>ok</b>`}</p>`.toString(), '<p><b>ok</b></p>');
});

test('device descriptions from user agents and client hints', () => {
  assert.equal(
    describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'),
    'iPhone · iOS 17.5 · Safari',
  );
  // Chrome on Android hides the model ("K"); client hints fill it in.
  const reduced = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  assert.equal(describeDevice(reduced), 'Android 10 · Chrome');
  assert.equal(describeDevice(reduced, { model: 'SM-S918B', platformVersion: '14.0.0' }), 'SM-S918B · Android 14 · Chrome');
  assert.equal(
    describeDevice('Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-A515F) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0 Mobile Safari/537.36', { standalone: true }),
    'SAMSUNG SM-A515F · Android 13 · Samsung Internet (home-screen app)',
  );
});

test('PIN/password hashing round-trips and rejects wrong secrets', async () => {
  const h = await hashSecret('1234');
  assert.match(h, /^pbkdf2\$\d+\$/);
  assert.equal(await verifySecret('1234', h), true);
  assert.equal(await verifySecret('1235', h), false);
  assert.equal(await verifySecret('1234', 'garbage'), false);
});
