'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { openDb } = require('./db');
const auth = require('./auth');
const { html, layout } = require('./views');
const workerRoutes = require('./routes/worker');
const adminRoutes = require('./routes/admin');

function createApp({ dbPath, dataDir, storageWarning = null }) {
  const db = openDb(dbPath);
  const selfieDir = path.join(dataDir, 'selfies');
  fs.mkdirSync(selfieDir, { recursive: true });
  const limiter = new auth.LoginLimiter();

  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) {
    const v = process.env.TRUST_PROXY;
    app.set('trust proxy', v === 'true' ? true : /^\d+$/.test(v) ? Number(v) : v);
  } else if (process.env.RAILWAY_ENVIRONMENT) {
    // Railway terminates HTTPS at its proxy, one hop in front of the app.
    app.set('trust proxy', 1);
  }

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'geolocation=(self), camera=(self)',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data: blob:; script-src 'self'; style-src 'self'; frame-ancestors 'none'; form-action 'self'",
    });
    next();
  });

  app.get('/healthz', (req, res) => {
    db.prepare('SELECT 1').get();
    res.type('text').send('ok');
  });

  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use('/api', express.json({ limit: '3mb' }));

  // Reject cross-site form posts (defence in depth on top of SameSite cookies).
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const src = req.headers.origin || req.headers.referer;
    if (src) {
      let host = null;
      try { host = new URL(src).host; } catch { /* malformed */ }
      if (host !== req.headers.host) return res.status(403).send('Cross-site request blocked');
    }
    next();
  });

  app.use((req, res, next) => {
    req.user = auth.sessionUser(db, req);
    next();
  });

  const ctx = { db, selfieDir, render: renderPage };

  function renderPage(res, opts, status = 200) {
    const req = res.req;
    const flash = opts.flash !== undefined ? opts.flash : (typeof req.query.ok === 'string' ? req.query.ok : null);
    const warning = storageWarning && req.user && req.user.role === 'supervisor' ? storageWarning : null;
    res.status(status).type('html').send(layout({ user: req.user, ...opts, flash, warning }));
  }

  // ---------- Login / logout / first-run setup ----------

  const hasSupervisor = () => !!db.prepare("SELECT 1 FROM users WHERE role = 'supervisor' LIMIT 1").get();
  const homeFor = (user) => (user.role === 'supervisor' ? '/admin' : '/');

  function loginPage(res, { error = null, login = '' } = {}, status = 200) {
    renderPage(res, {
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

  app.get('/login', (req, res) => {
    if (!hasSupervisor()) return res.redirect('/setup');
    if (req.user) return res.redirect(homeFor(req.user));
    loginPage(res);
  });

  app.post('/login', (req, res) => {
    const login = String(req.body.login || '').trim();
    const secret = String(req.body.secret || '');
    const ip = req.ip;
    const locked = limiter.lockedFor(ip, login);
    if (locked) {
      return loginPage(res, { login, error: `Too many attempts. Try again in ${Math.ceil(locked / 60000)} minutes.` }, 429);
    }
    const user = db.prepare('SELECT * FROM users WHERE login = ? AND active = 1').get(login);
    if (!user || !auth.verifySecret(secret, user.secret_hash)) {
      limiter.fail(ip, login);
      return loginPage(res, { login, error: 'Incorrect login or PIN/password.' }, 401);
    }
    limiter.succeed(ip, login);
    auth.createSession(db, req, res, user);
    res.redirect(homeFor(user));
  });

  app.post('/logout', (req, res) => {
    auth.destroySession(db, req, res);
    res.redirect('/login');
  });

  function setupPage(res, { error = null, values = {} } = {}, status = 200) {
    renderPage(res, {
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

  app.get('/setup', (req, res) => {
    if (hasSupervisor()) return res.redirect('/login');
    setupPage(res);
  });

  app.post('/setup', (req, res) => {
    if (hasSupervisor()) return res.redirect('/login');
    const name = String(req.body.name || '').trim();
    const login = String(req.body.login || '').trim();
    const secret = String(req.body.secret || '');
    if (!name || !login || secret.length < 8) {
      return setupPage(res, { error: 'Fill in all fields; password must be at least 8 characters.', values: { name, login } }, 400);
    }
    const r = db.prepare("INSERT INTO users (name, login, secret_hash, role) VALUES (?, ?, ?, 'supervisor')")
      .run(name, login, auth.hashSecret(secret));
    auth.createSession(db, req, res, { id: Number(r.lastInsertRowid), role: 'supervisor' });
    res.redirect('/admin/people?ok=' + encodeURIComponent('Supervisor created. Now add your workers.'));
  });

  // ---------- Role gates ----------

  ctx.requireWorker = (req, res, next) => {
    if (!req.user) return req.path.startsWith('/api/') ? res.status(401).json({ error: 'Please sign in again.' }) : res.redirect('/login');
    if (req.user.role !== 'worker') return req.path.startsWith('/api/') ? res.status(403).json({ error: 'Workers only.' }) : res.redirect('/admin');
    next();
  };
  ctx.requireSupervisor = (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (req.user.role !== 'supervisor') return res.redirect('/');
    next();
  };

  // Selfies are private: supervisors, or the worker who took it.
  app.get('/selfies/:file', (req, res) => {
    const file = req.params.file;
    if (!req.user || !/^[a-f0-9]{32}\.jpg$/.test(file)) return res.sendStatus(404);
    if (req.user.role !== 'supervisor') {
      const own = db.prepare('SELECT 1 FROM shifts WHERE user_id = ? AND (in_selfie = ? OR out_selfie = ?)').get(req.user.id, file, file);
      if (!own) return res.sendStatus(404);
    }
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(path.join(selfieDir, file), (err) => { if (err && !res.headersSent) res.sendStatus(404); });
  });

  app.use(workerRoutes(ctx));
  app.use(adminRoutes(ctx));

  app.use((req, res) => renderPage(res, { title: 'Not found', body: html`<div class="card"><h1>Page not found</h1><p><a href="/">Go home</a></p></div>` }, 404));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    if (req.path.startsWith('/api/')) return res.status(err.status || 500).json({ error: 'Something went wrong. Please try again.' });
    renderPage(res, { title: 'Error', body: html`<div class="card"><h1>Something went wrong</h1><p>Please go back and try again.</p></div>` }, err.status || 500);
  });

  app.locals.db = db;
  return app;
}

module.exports = { createApp };
