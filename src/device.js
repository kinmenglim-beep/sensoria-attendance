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

/** Short display name with a fingerprint so two identical phones can be told apart. */
const deviceName = (label, key) => (label ? `${label} #${String(key || '').slice(0, 6)}` : null);

// Columns/joins that add device labels to a `shifts s` query.
const DEVICE_COLUMNS = `dvi.label AS in_device_label, dvi.device_key AS in_device_key,
  dvo.label AS out_device_label, dvo.device_key AS out_device_key`;
const DEVICE_JOINS = `LEFT JOIN devices dvi ON dvi.id = s.in_device_id LEFT JOIN devices dvo ON dvo.id = s.out_device_id`;

module.exports = { describeDevice, resolveDevice, deviceName, DEVICE_COLUMNS, DEVICE_JOINS };
