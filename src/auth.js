'use strict';

const crypto = require('node:crypto');

const COOKIE = 'sid';
const DAY = 24 * 60 * 60 * 1000;
// Workers stay signed in on their own phone; supervisors re-login weekly.
const SESSION_TTL = { worker: 60 * DAY, supervisor: 7 * DAY };

function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(secret, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifySecret(secret, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(String(secret), Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function cookieSecure(req) {
  if (process.env.COOKIE_SECURE) return process.env.COOKIE_SECURE === 'true';
  return req.secure;
}

function createSession(db, req, res, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ttl = SESSION_TTL[user.role] || DAY;
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), user.id, Date.now() + ttl);
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: cookieSecure(req), maxAge: ttl, path: '/',
  });
}

function destroySession(db, req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.clearCookie(COOKIE, { path: '/' });
}

function sessionUser(db, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  return db.prepare(`
    SELECT u.id, u.name, u.login, u.role, u.hourly_rate
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1
  `).get(sha256(token), Date.now()) || null;
}

// Simple in-memory brute-force protection for logins (PINs are short).
class LoginLimiter {
  constructor({ maxFailures = 5, lockMs = 15 * 60 * 1000 } = {}) {
    this.maxFailures = maxFailures;
    this.lockMs = lockMs;
    this.entries = new Map();
  }

  key(ip, login) { return `${ip}|${String(login).toLowerCase()}`; }

  lockedFor(ip, login) {
    const e = this.entries.get(this.key(ip, login));
    if (!e || !e.until) return 0;
    const left = e.until - Date.now();
    if (left <= 0) { this.entries.delete(this.key(ip, login)); return 0; }
    return left;
  }

  fail(ip, login) {
    const k = this.key(ip, login);
    const e = this.entries.get(k) || { count: 0, until: 0 };
    e.count += 1;
    if (e.count >= this.maxFailures) { e.until = Date.now() + this.lockMs; e.count = 0; }
    this.entries.set(k, e);
    if (this.entries.size > 10000) this.entries.delete(this.entries.keys().next().value);
  }

  succeed(ip, login) { this.entries.delete(this.key(ip, login)); }
}

module.exports = {
  hashSecret, verifySecret, createSession, destroySession, sessionUser, parseCookies, LoginLimiter,
};
