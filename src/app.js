import { Hono } from 'hono';

import { ensureSchema } from './db.js';
import * as auth from './auth.js';
import { html, layout } from './views.js';
import { DEFAULT_TZ, setTimeZone, setRounding } from './time.js';
import { envVar } from './env.js';
import { registerWorkerRoutes } from './routes/worker.js';
import { registerAdminRoutes } from './routes/admin.js';

/**
 * @param {object} opts
 * @param {(c) => object} opts.dbFor       returns the async DB for a request
 * @param {(c) => string} opts.getIp       returns the client IP for a request
 * @param {boolean} [opts.trustProxy]      trust X-Forwarded-Proto for HTTPS detection
 * @param {Function} [opts.assets]        optional middleware serving public/ (Node only;
 *                                         on Cloudflare the platform serves static files)
 */
export function createApp({ dbFor, getIp, trustProxy = false, assets = null }) {
  const app = new Hono();
  let schemaReady = null;

  app.use(async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'same-origin');
    c.header('Permissions-Policy', 'geolocation=(self), camera=()');
    c.header('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; frame-ancestors 'none'; form-action 'self'");
  });

  app.get('/healthz', (c) => c.text('ok'));
  if (assets) app.use(assets);

  // Reject cross-site form posts (defence in depth on top of SameSite cookies).
  app.use(async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
    const src = c.req.header('origin') || c.req.header('referer');
    if (src) {
      let host = null;
      try { host = new URL(src).host; } catch { /* malformed */ }
      if (host !== new URL(c.req.url).host) return c.text('Cross-site request blocked', 403);
    }
    return next();
  });

  app.use(async (c, next) => {
    setTimeZone(envVar(c, 'APP_TZ') || DEFAULT_TZ);
    setRounding(envVar(c, 'ROUND_MINUTES') ?? undefined);
    const db = dbFor(c);
    if (!schemaReady) schemaReady = ensureSchema(db).catch((err) => { schemaReady = null; throw err; });
    await schemaReady;
    c.set('db', db);
    c.set('ip', getIp(c) || '');
    c.set('secure', auth.isSecure(c, trustProxy));
    c.set('user', await auth.sessionUser(c, db));
    return next();
  });

  function render(c, opts, status = 200) {
    const user = c.get('user');
    const flash = opts.flash !== undefined ? opts.flash : (c.req.query('ok') ?? null);
    return c.html(layout({ user, ...opts, flash }), status);
  }

  /** Parsed form body; repeated fields (e.g. ids) come back as arrays. */
  async function form(c) {
    return c.req.parseBody({ all: true });
  }

  // ---------- Login / logout / first-run setup ----------

  const hasSupervisor = async (db) => !!(await db.get("SELECT 1 AS x FROM users WHERE role = 'supervisor' LIMIT 1"));
  const homeFor = (user) => (user.role === 'supervisor' ? '/admin' : '/');

  function loginPage(c, { error = null, login = '' } = {}, status = 200) {
    return render(c, {
      title: 'Sign in',
      error,
      body: html`
        <div class="auth-box card">
          <h1>Sign in</h1>
          <p class="muted">Workers: use your phone number / staff ID and PIN.</p>
          <form method="post" action="/login" class="stack">
            <label>Phone / Staff ID / Username
              <input name="login" value="${login}" autocomplete="username" autocapitalize="none" required autofocus>
            </label>
            <label>PIN or password
              <input name="secret" type="password" autocomplete="current-password" required>
            </label>
            <button class="btn btn-primary btn-block" type="submit">Sign in</button>
          </form>
        </div>`,
    }, status);
  }

  app.get('/login', async (c) => {
    if (!(await hasSupervisor(c.get('db')))) return c.redirect('/setup');
    const user = c.get('user');
    if (user) return c.redirect(homeFor(user));
    return loginPage(c);
  });

  app.post('/login', async (c) => {
    const db = c.get('db');
    const b = await form(c);
    const login = String(b.login || '').trim();
    const secret = String(b.secret || '');
    const ip = c.get('ip');
    const locked = await auth.loginLockedFor(db, ip, login);
    if (locked) {
      return loginPage(c, { login, error: `Too many attempts. Try again in ${Math.ceil(locked / 60000)} minutes.` }, 429);
    }
    const user = await db.get('SELECT * FROM users WHERE login = ? AND active = 1', login);
    if (!user || !(await auth.verifySecret(secret, user.secret_hash))) {
      await auth.recordLoginFailure(db, ip, login);
      return loginPage(c, { login, error: 'Incorrect login or PIN/password.' }, 401);
    }
    await auth.clearLoginFailures(db, ip, login);
    await auth.createSession(c, db, user, { secure: c.get('secure') });
    return c.redirect(homeFor(user));
  });

  app.post('/logout', async (c) => {
    await auth.destroySession(c, c.get('db'));
    return c.redirect('/login');
  });

  function setupPage(c, { error = null, values = {} } = {}, status = 200) {
    return render(c, {
      title: 'First-time setup',
      error,
      body: html`
        <div class="auth-box card">
          <h1>Welcome</h1>
          <p class="muted">Create the first supervisor account. You can add workers and more supervisors afterwards.</p>
          <form method="post" action="/setup" class="stack">
            <label>Your name <input name="name" value="${values.name || ''}" required></label>
            <label>Username <input name="login" value="${values.login || ''}" autocapitalize="none" required></label>
            <label>Password (min. 8 characters)
              <input name="secret" type="password" minlength="8" autocomplete="new-password" required>
            </label>
            <button class="btn btn-primary btn-block" type="submit">Create supervisor</button>
          </form>
        </div>`,
    }, status);
  }

  app.get('/setup', async (c) => {
    if (await hasSupervisor(c.get('db'))) return c.redirect('/login');
    return setupPage(c);
  });

  app.post('/setup', async (c) => {
    const db = c.get('db');
    if (await hasSupervisor(db)) return c.redirect('/login');
    const b = await form(c);
    const name = String(b.name || '').trim();
    const login = String(b.login || '').trim();
    const secret = String(b.secret || '');
    if (!name || !login || secret.length < 8) {
      return setupPage(c, { error: 'Fill in all fields; password must be at least 8 characters.', values: { name, login } }, 400);
    }
    const r = await db.run("INSERT INTO users (name, login, secret_hash, role) VALUES (?, ?, ?, 'supervisor')",
      name, login, await auth.hashSecret(secret));
    await auth.createSession(c, db, { id: r.lastId, role: 'supervisor' }, { secure: c.get('secure') });
    return c.redirect('/admin/people?ok=' + encodeURIComponent('Supervisor created. Now add your workers.'));
  });

  // ---------- Role gates ----------

  const isApi = (c) => c.req.path.startsWith('/api/');
  async function requireWorker(c, next) {
    const user = c.get('user');
    if (!user) return isApi(c) ? c.json({ error: 'Please sign in again.' }, 401) : c.redirect('/login');
    if (user.role !== 'worker') return isApi(c) ? c.json({ error: 'Workers only.' }, 403) : c.redirect('/admin');
    return next();
  }
  async function requireSupervisor(c, next) {
    const user = c.get('user');
    if (!user) return c.redirect('/login');
    if (user.role !== 'supervisor') return c.redirect('/');
    return next();
  }

  const helpers = { render, form, requireWorker, requireSupervisor };
  registerWorkerRoutes(app, helpers);
  registerAdminRoutes(app, helpers);

  app.notFound((c) => render(c, {
    title: 'Not found',
    body: html`<div class="card"><h1>Page not found</h1><p><a href="/">Go home</a></p></div>`,
  }, 404));

  app.onError((err, c) => {
    console.error(err);
    if (isApi(c)) return c.json({ error: 'Something went wrong. Please try again.' }, 500);
    return c.html(layout({
      title: 'Error',
      user: null,
      body: html`<div class="card"><h1>Something went wrong</h1><p>Please go back and try again.</p></div>`,
    }), 500);
  });

  return app;
}
