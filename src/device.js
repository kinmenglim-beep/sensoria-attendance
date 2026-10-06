// Device identification. Browsers don't reveal a phone's real name, so each
// browser gets a random, long-lived device key (cookie + localStorage copy)
// and a readable description built from the user agent / client hints.

import { getCookie, setCookie } from 'hono/cookie';
import { randomToken } from './auth.js';

const COOKIE = 'did';
const KEY_RE = /^[A-Za-z0-9_-]{22,64}$/;
// Browsers cap cookie lifetime at 400 days; it is refreshed on every clock in/out.
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;
export const DEVICE_WINDOW_DAYS = 30;

const clean = (v, max = 60) => String(v || '').replace(/[^\x20-\x7E]/g, '').trim().slice(0, max);
const windowStart = () => new Date(Date.now() - DEVICE_WINDOW_DAYS * 86400000).toISOString();

function browserName(ua) {
  if (/SamsungBrowser\//.test(ua)) return 'Samsung Internet';
  if (/EdgA?\/|Edg\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/CriOS\//.test(ua)) return 'Chrome';
  if (/FxiOS\/|Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Browser';
}

/** e.g. "iPhone · iOS 17.5 · Safari" or "SM-A515F · Android 13 · Chrome". */
export function describeDevice(userAgent, hints = {}) {
  const ua = String(userAgent || '');
  let model = '';
  let os = '';
  let m;
  if (/iPhone/.test(ua)) {
    model = 'iPhone';
    m = /OS (\d+)[_.](\d+)/.exec(ua);
    os = m ? `iOS ${m[1]}.${m[2]}` : 'iOS';
  } else if (/iPad/.test(ua)) {
    model = 'iPad';
    m = /OS (\d+)[_.](\d+)/.exec(ua);
    os = m ? `iPadOS ${m[1]}.${m[2]}` : 'iPadOS';
  } else if ((m = /Android ([\d.]+)/.exec(ua))) {
    os = `Android ${m[1]}`;
    const mm = /Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?\)/.exec(ua);
    if (mm && mm[1].trim() !== 'K') model = mm[1].trim();
    const pv = clean(hints.platformVersion, 20);
    if (pv) os = `Android ${pv.split('.')[0]}`;
  } else if (/Windows NT/.test(ua)) {
    os = 'Windows';
  } else if (/Macintosh/.test(ua)) {
    os = 'Mac';
  } else if (/CrOS/.test(ua)) {
    os = 'ChromeOS';
  } else if (/Linux/.test(ua)) {
    os = 'Linux';
  }
  const hintModel = clean(hints.model);
  if (hintModel) model = hintModel;
  const label = [model, os || 'Unknown device', browserName(ua)].filter(Boolean).join(' · ');
  return hints.standalone ? `${label} (home-screen app)` : label;
}

/**
 * Find or register the device making this request and make sure it carries
 * the device cookie. Returns the devices row.
 */
export async function resolveDevice(c, db, body, { secure }) {
  const cookieKey = getCookie(c, COOKIE);
  let key = KEY_RE.test(cookieKey || '') ? cookieKey : null;
  if (!key && KEY_RE.test(String(body.deviceKey || ''))) key = String(body.deviceKey);
  if (!key) key = randomToken(18);
  setCookie(c, COOKIE, key, { httpOnly: true, sameSite: 'Lax', secure, maxAge: COOKIE_MAX_AGE_S, path: '/' });
  const ua = clean(c.req.header('user-agent'), 400);
  const label = describeDevice(ua, { model: body.deviceModel, platformVersion: body.platformVersion, standalone: body.standalone === true });
  const now = new Date().toISOString();
  const [, found] = await db.batch([
    [`INSERT INTO devices (device_key, label, user_agent, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(device_key) DO UPDATE SET label = excluded.label, user_agent = excluded.user_agent, last_seen = excluded.last_seen`,
    key, label, ua, now, now],
    ['SELECT * FROM devices WHERE device_key = ?', key],
  ]);
  return found.rows[0];
}

/**
 * Check the device against the worker's registered phone(s). The first phone a
 * worker ever uses is registered automatically; any other phone is recorded as
 * 'pending' for a supervisor to review. Returns { registered, autoRegistered }.
 */
export async function checkRegistration(db, userId, deviceId) {
  const now = new Date().toISOString();
  const rows = await db.all('SELECT device_id, status FROM worker_devices WHERE user_id = ?', userId);
  const approved = rows.filter((r) => r.status === 'approved').map((r) => r.device_id);
  if (approved.includes(deviceId)) return { registered: true, autoRegistered: false };
  if (!approved.length) {
    await db.run(`
      INSERT INTO worker_devices (user_id, device_id, status, created_at) VALUES (?, ?, 'approved', ?)
      ON CONFLICT(user_id, device_id) DO UPDATE SET status = 'approved'
    `, userId, deviceId, now);
    return { registered: true, autoRegistered: true };
  }
  await db.run("INSERT OR IGNORE INTO worker_devices (user_id, device_id, status, created_at) VALUES (?, ?, 'pending', ?)",
    userId, deviceId, now);
  return { registered: false, autoRegistered: false };
}

/** Distinct devices a worker clocked in/out with in the last 30 days (optionally counting one more). */
export async function recentDeviceCount(db, userId, extraDeviceId = null) {
  const since = windowStart();
  const row = await db.get(`
    SELECT COUNT(DISTINCT d) AS n FROM (
      SELECT in_device_id AS d FROM shifts WHERE user_id = ? AND check_in_at >= ?
      UNION ALL SELECT out_device_id FROM shifts WHERE user_id = ? AND check_in_at >= ?
      UNION ALL SELECT ?
    ) WHERE d IS NOT NULL
  `, userId, since, userId, since, extraDeviceId);
  return row.n;
}

/** Active workers who used at least `threshold` devices in the last 30 days. */
export async function frequentDeviceChangers(db, threshold) {
  return db.all(`
    SELECT u.id, u.name, COUNT(DISTINCT x.d) AS n FROM (
      SELECT user_id, in_device_id AS d FROM shifts WHERE check_in_at >= ?1
      UNION ALL SELECT user_id, out_device_id FROM shifts WHERE check_in_at >= ?1
    ) x JOIN users u ON u.id = x.user_id
    WHERE x.d IS NOT NULL AND u.active = 1 AND u.role = 'worker'
    GROUP BY u.id HAVING n >= ?2 ORDER BY n DESC, u.name
  `, windowStart(), threshold);
}

/** Short display name with a fingerprint so two identical phones can be told apart. */
export const deviceName = (label, key) => (label ? `${label} #${String(key || '').slice(0, 6)}` : null);

// Columns/joins that add device labels to a `shifts s` query.
export const DEVICE_COLUMNS = `dvi.label AS in_device_label, dvi.device_key AS in_device_key,
  dvo.label AS out_device_label, dvo.device_key AS out_device_key`;
export const DEVICE_JOINS = 'LEFT JOIN devices dvi ON dvi.id = s.in_device_id LEFT JOIN devices dvo ON dvo.id = s.out_device_id';
