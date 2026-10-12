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

test('times round to the nearest quarter hour for pay', () => {
  const at = (hhmm, ss = '00') => new Date(`${time.localToUtcIso('2026-10-05', hhmm).slice(0, 17)}${ss}.000Z`).toISOString();
  // The example from the brief: 1:13pm → 1:15pm, 3:24pm → 3:30pm = 2h 15m.
  assert.equal(time.localTime(time.roundTime(at('13:13'))), '13:15');
  assert.equal(time.localTime(time.roundTime(at('15:24'))), '15:30');
  assert.equal(time.paidHours(at('13:13'), at('15:24')), 2.25);
  assert.equal(time.formatHM(2.25), '2h 15m');
  // :07 rounds down, :08 rounds up; seconds are ignored (what you see is what counts).
  assert.equal(time.localTime(time.roundTime(at('09:07', '59'))), '09:00');
  assert.equal(time.localTime(time.roundTime(at('09:08'))), '09:15');
  assert.equal(time.localTime(time.roundTime(at('23:53'))), '00:00');
  // Rounding can be turned off.
  time.setRounding(0);
  assert.equal(time.paidHours(at('13:13'), at('15:24')), 2.18);
  time.setRounding(undefined);
  assert.equal(time.ROUND_MINUTES, 15);
});

test('roster cells parse into time ranges', async () => {
  const { parseRanges, formatRanges, weekStart, slotTimes } = await import('../src/schedule.js');
  assert.deepEqual(parseRanges('10-15').ranges, [{ start: '10:00', end: '15:00' }]);
  assert.deepEqual(parseRanges('17:00-22:30, 10:00 - 14:00').ranges,
    [{ start: '10:00', end: '14:00' }, { start: '17:00', end: '22:30' }]);
  assert.deepEqual(parseRanges('6pm to 1am').ranges, [{ start: '18:00', end: '01:00' }]);
  assert.deepEqual(parseRanges('930-1430').ranges, [{ start: '09:30', end: '14:30' }]);
  assert.deepEqual(parseRanges('12pm-12am').ranges, [{ start: '12:00', end: '00:00' }]);
  for (const blank of ['', ' ', 'off', 'OFF', '-']) assert.deepEqual(parseRanges(blank).ranges, []);
  for (const bad of ['10', '25-26', '10-10', 'lunch', '13pm-2pm', '10:75-12']) assert.ok(parseRanges(bad).error, bad);
  assert.equal(formatRanges(parseRanges('10-14, 17-22').ranges), '10:00-14:00, 17:00-22:00');
  assert.equal(weekStart('2026-10-10'), '2026-10-05'); // Saturday → Monday
  assert.equal(weekStart('2026-10-05'), '2026-10-05');
  assert.equal(weekStart('2026-10-11'), '2026-10-05'); // Sunday
  // A shift past midnight ends the next day.
  assert.deepEqual(slotTimes('2026-10-05', '18:00', '01:00'),
    { startIso: '2026-10-05T10:00:00.000Z', endIso: '2026-10-05T17:00:00.000Z' });
});

test('clock-ins are matched to the rostered shift', async () => {
  const { matchSlot, slotTimes } = await import('../src/schedule.js');
  const slot = (date, start, end) => ({ work_date: date, start_time: start, end_time: end, ...slotTimes(date, start, end) });
  const slots = [slot('2026-10-05', '10:00', '14:00'), slot('2026-10-05', '17:00', '22:00')];
  const at = (hhmm) => Date.parse(time.localToUtcIso('2026-10-05', hhmm));
  const opts = { earlyMin: 30, graceMin: 5 };
  assert.equal(matchSlot(slots, at('09:40'), opts).status, 'ok');
  assert.equal(matchSlot(slots, at('10:05'), opts).status, 'ok');
  assert.deepEqual(
    (({ status, lateMin }) => ({ status, lateMin }))(matchSlot(slots, at('10:12'), opts)),
    { status: 'late', lateMin: 12 },
  );
  const early = matchSlot(slots, at('09:00'), opts);
  assert.equal(early.status, 'too_early');
  assert.equal(time.localTime(early.opensAt), '09:30');
  // Between the split shifts: the dinner shift isn't open yet.
  assert.equal(matchSlot(slots, at('15:00'), opts).status, 'too_early');
  assert.equal(matchSlot(slots, at('16:45'), opts).slot.start_time, '17:00');
  assert.equal(matchSlot(slots, at('22:30'), opts).status, 'none');
  assert.equal(matchSlot([], at('10:00'), opts).status, 'none');
});
