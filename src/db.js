'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  login       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  secret_hash TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('worker', 'supervisor')),
  hourly_rate REAL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Work locations used for the GPS geofence check.
CREATE TABLE IF NOT EXISTS sites (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  lat      REAL NOT NULL,
  lng      REAL NOT NULL,
  radius_m INTEGER NOT NULL DEFAULT 150
);

-- Browsers/phones used to clock in, identified by a random long-lived key.
CREATE TABLE IF NOT EXISTS devices (
  id         INTEGER PRIMARY KEY,
  device_key TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL,
  user_agent TEXT,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);

-- Each worker's registered phone(s). 'pending' = used but not yet reviewed,
-- 'dismissed' = supervisor looked at it and chose not to register it.
CREATE TABLE IF NOT EXISTS worker_devices (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  status      TEXT NOT NULL CHECK (status IN ('approved', 'pending', 'dismissed')),
  created_at  TEXT NOT NULL,
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  PRIMARY KEY (user_id, device_id)
);

-- One row per check-in/check-out pair. Times are stored as UTC ISO strings;
-- work_date is the local (APP_TZ) date of the check-in.
CREATE TABLE IF NOT EXISTS shifts (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  work_date     TEXT NOT NULL,
  check_in_at   TEXT NOT NULL,
  check_out_at  TEXT,
  in_lat REAL, in_lng REAL, in_accuracy REAL, in_site TEXT, in_distance_m REAL, in_selfie TEXT, in_ip TEXT,
  in_device_id INTEGER REFERENCES devices(id),
  out_lat REAL, out_lng REAL, out_accuracy REAL, out_site TEXT, out_distance_m REAL, out_selfie TEXT, out_ip TEXT,
  out_device_id INTEGER REFERENCES devices(id),
  flags         TEXT NOT NULL DEFAULT '',
  worker_note   TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by   INTEGER REFERENCES users(id),
  reviewed_at   TEXT,
  review_note   TEXT
);
CREATE INDEX IF NOT EXISTS shifts_by_date ON shifts(work_date);
CREATE INDEX IF NOT EXISTS shifts_by_user_date ON shifts(user_id, work_date);
-- A worker can only have one open (not yet checked out) shift at a time.
CREATE UNIQUE INDEX IF NOT EXISTS shifts_one_open ON shifts(user_id) WHERE check_out_at IS NULL;

CREATE TABLE IF NOT EXISTS audit (
  id       INTEGER PRIMARY KEY,
  shift_id INTEGER REFERENCES shifts(id),
  actor_id INTEGER REFERENCES users(id),
  action   TEXT NOT NULL,
  detail   TEXT,
  at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_by_shift ON audit(shift_id);
`;

const DEFAULT_SETTINGS = {
  // off | flag | block — what to do when GPS is missing or outside every site.
  geofence_mode: 'flag',
  // none | in | both — when a selfie is required.
  selfie: 'none',
  // off | flag | block — what to do when the request doesn't come from the venue network.
  ip_mode: 'off',
  allowed_ips: '',
  // off | flag | block — what to do when a worker uses a phone that isn't registered to them.
  device_mode: 'flag',
  // Alert when a worker uses this many different phones within 30 days.
  device_alert_count: '3',
};

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // Upgrade databases created before device tracking existed.
  const cols = db.prepare('PRAGMA table_info(shifts)').all().map((c) => c.name);
  for (const col of ['in_device_id', 'out_device_id']) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE shifts ADD COLUMN ${col} INTEGER REFERENCES devices(id)`);
  }
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insert.run(k, v);
  return db;
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getSettings(db) {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function audit(db, shiftId, actorId, action, detail = null) {
  db.prepare('INSERT INTO audit (shift_id, actor_id, action, detail, at) VALUES (?, ?, ?, ?, ?)')
    .run(shiftId, actorId, action, detail, new Date().toISOString());
}

function removeFlags(existing, ...flags) {
  return String(existing || '').split(',').filter((f) => f && !flags.includes(f)).join(',');
}

const hasFlag = (flags, flag) => String(flags || '').split(',').includes(flag);

function addFlags(existing, ...flags) {
  const set = new Set(String(existing || '').split(',').filter(Boolean));
  for (const f of flags) if (f) set.add(f);
  return [...set].join(',');
}

module.exports = {
  openDb, transaction, getSettings, setSetting, audit, addFlags, removeFlags, hasFlag, DEFAULT_SETTINGS,
};
