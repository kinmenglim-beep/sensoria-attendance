// Passwords/PINs, sessions and login rate limiting, using Web Crypto so the
// same code runs on Cloudflare Workers and Node.

import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

const COOKIE = 'sid';
const DAY = 24 * 60 * 60 * 1000;
// Workers stay signed in on their own phone; supervisors re-login weekly.
const SESSION_TTL = { worker: 60 * DAY, supervisor: 7 * DAY };
// Kept moderate so a login fits in the Workers free plan's CPU budget; the
// iteration count is stored in each hash so it can be raised later.
const PBKDF2_ITERATIONS = 20000;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

const enc = new TextEncoder();
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function randomToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function pbkdf2(secret, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashSecret(secret) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(secret, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

export async function verifySecret(secret, stored) {
  const [scheme, iter, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'pbkdf2' || !(Number(iter) > 0) || !saltB64 || !hashB64) return false;
  const expected = unb64(hashB64);
  const actual = await pbkdf2(String(secret), unb64(saltB64), Number(iter));
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

export async function sha256(s) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function isSecure(c, trustProxy) {
  if (new URL(c.req.url).protocol === 'https:') return true;
  return !!trustProxy && c.req.header('x-forwarded-proto') === 'https';
}

export async function createSession(c, db, user, { secure }) {
  const token = randomToken();
  const ttl = SESSION_TTL[user.role] || DAY;
  await db.batch([
    ['DELETE FROM sessions WHERE expires_at < ?', Date.now()],
    ['INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', await sha256(token), user.id, Date.now() + ttl],
  ]);
  setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure, maxAge: Math.floor(ttl / 1000), path: '/' });
}

export async function destroySession(c, db) {
  const token = getCookie(c, COOKIE);
  if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', await sha256(token));
  deleteCookie(c, COOKIE, { path: '/' });
}

export async function sessionUser(c, db) {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  return db.get(`
    SELECT u.id, u.name, u.login, u.role, u.hourly_rate
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1
  `, await sha256(token), Date.now());
}

// ---- Brute-force protection for logins (PINs are short) ----

const limiterKey = (ip, login) => `${ip}|${String(login).toLowerCase()}`;

/** Milliseconds until this IP + login may try again (0 = not locked). */
export async function loginLockedFor(db, ip, login) {
  const row = await db.get('SELECT locked_until FROM login_failures WHERE key = ?', limiterKey(ip, login));
  return row ? Math.max(0, row.locked_until - Date.now()) : 0;
}

export async function recordLoginFailure(db, ip, login) {
  const key = limiterKey(ip, login);
  const now = Date.now();
  await db.batch([
    ['DELETE FROM login_failures WHERE locked_until > 0 AND locked_until < ?', now],
    [`INSERT INTO login_failures (key, count, locked_until) VALUES (?, 1, 0)
      ON CONFLICT(key) DO UPDATE SET count = count + 1`, key],
    // Lock after too many failures and start counting again.
    ['UPDATE login_failures SET locked_until = ?, count = 0 WHERE key = ? AND count >= ?', now + LOCK_MS, key, MAX_FAILURES],
  ]);
}

export async function clearLoginFailures(db, ip, login) {
  await db.run('DELETE FROM login_failures WHERE key = ?', limiterKey(ip, login));
}
