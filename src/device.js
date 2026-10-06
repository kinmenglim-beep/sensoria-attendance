'use strict';

// Device identification. Browsers don't reveal a phone's real name, so each
// browser gets a random, long-lived device key (cookie + localStorage copy)
// and a readable description built from the user agent / client hints.

const crypto = require('node:crypto');
const { parseCookies } = require('./auth');

const COOKIE = 'did';
const KEY_RE = /^[A-Za-z0-9_-]{22,64}$/;
const TWO_YEARS = 2 * 365 * 24 * 60 * 60 * 1000;

const clean = (v, max = 60) => String(v || '').replace(/[^\x20-\x7E]/g, '').trim().slice(0, max);

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
function describeDevice(userAgent, hints = {}) {
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
function resolveDevice(db, req, res, body = {}) {
  const cookieKey = parseCookies(req.headers.cookie)[COOKIE];
  let key = KEY_RE.test(cookieKey || '') ? cookieKey : null;
  if (!key && KEY_RE.test(String(body.deviceKey || ''))) key = String(body.deviceKey);
  if (!key) key = crypto.randomBytes(18).toString('base64url');
  if (key !== cookieKey) {
    res.cookie(COOKIE, key, {
      httpOnly: true, sameSite: 'lax', maxAge: TWO_YEARS, path: '/',
      secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : req.secure,
    });
  }
  const ua = clean(req.headers['user-agent'], 400);
  const label = describeDevice(ua, { model: body.deviceModel, platformVersion: body.platformVersion, standalone: body.standalone === true });
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO devices (device_key, label, user_agent, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(device_key) DO UPDATE SET label = excluded.label, user_agent = excluded.user_agent, last_seen = excluded.last_seen
  `).run(key, label, ua, now, now);
  return db.prepare('SELECT * FROM devices WHERE device_key = ?').get(key);
}

const DEVICE_WINDOW_DAYS = 30;

/**
 * Check the device against the worker's registered phone(s). The first phone a
 * worker ever uses is registered automatically; any other phone is recorded as
 * 'pending' for a supervisor to review. Returns { registered, autoRegistered }.
 */
function checkRegistration(db, userId, deviceId) {
  const now = new Date().toISOString();
  const rows = db.prepare('SELECT device_id, status FROM worker_devices WHERE user_id = ?').all(userId);
  const approved = rows.filter((r) => r.status === 'approved').map((r) => r.device_id);
  if (approved.includes(deviceId)) return { registered: true, autoRegistered: false };
  if (!approved.length) {
    db.prepare(`
      INSERT INTO worker_devices (user_id, device_id, status, created_at) VALUES (?, ?, 'approved', ?)
      ON CONFLICT(user_id, device_id) DO UPDATE SET status = 'approved'
    `).run(userId, deviceId, now);
    return { registered: true, autoRegistered: true };
  }
  db.prepare("INSERT OR IGNORE INTO worker_devices (user_id, device_id, status, created_at) VALUES (?, ?, 'pending', ?)")
    .run(userId, deviceId, now);
  return { registered: false, autoRegistered: false };
}

/** Number of different devices a worker clocked in/out with in the last 30 days. */
function recentDeviceCount(db, userId) {
  const since = new Date(Date.now() - DEVICE_WINDOW_DAYS * 86400000).toISOString();
  return db.prepare(`
    SELECT COUNT(DISTINCT d) AS n FROM (
      SELECT in_device_id AS d FROM shifts WHERE user_id = ? AND check_in_at >= ?
      UNION ALL SELECT out_device_id FROM shifts WHERE user_id = ? AND check_in_at >= ?
    ) WHERE d IS NOT NULL
  `).get(userId, since, userId, since).n;
}

/** Active workers who used at least `threshold` devices in the last 30 days. */
function frequentDeviceChangers(db, threshold) {
  const since = new Date(Date.now() - DEVICE_WINDOW_DAYS * 86400000).toISOString();
  return db.prepare(`
    SELECT u.id, u.name, COUNT(DISTINCT x.d) AS n FROM (
      SELECT user_id, in_device_id AS d, check_in_at AS t FROM shifts
      UNION ALL SELECT user_id, out_device_id, check_in_at FROM shifts
    ) x JOIN users u ON u.id = x.user_id
    WHERE x.d IS NOT NULL AND x.t >= ? AND u.active = 1 AND u.role = 'worker'
    GROUP BY u.id HAVING n >= ? ORDER BY n DESC, u.name
  `).all(since, threshold);
}

/** Short display name with a fingerprint so two identical phones can be told apart. */
const deviceName = (label, key) => (label ? `${label} #${String(key || '').slice(0, 6)}` : null);

// Columns/joins that add device labels to a `shifts s` query.
const DEVICE_COLUMNS = `dvi.label AS in_device_label, dvi.device_key AS in_device_key,
  dvo.label AS out_device_label, dvo.device_key AS out_device_key`;
const DEVICE_JOINS = `LEFT JOIN devices dvi ON dvi.id = s.in_device_id LEFT JOIN devices dvo ON dvo.id = s.out_device_id`;

module.exports = {
  describeDevice, resolveDevice, deviceName, checkRegistration, recentDeviceCount, frequentDeviceChangers,
  DEVICE_COLUMNS, DEVICE_JOINS, DEVICE_WINDOW_DAYS,
};
