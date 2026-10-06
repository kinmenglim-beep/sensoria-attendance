// Async database interface backed by Node's built-in SQLite. Used for local
// development, tests and self-hosting with Docker.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const clean = (params) => params.map((p) => (p === undefined ? null : p));
const plain = (row) => (row ? { ...row } : null);

export class NodeDb {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  }

  exec1(sql, params) {
    const stmt = this.db.prepare(sql);
    if (stmt.columns().length) {
      const rows = stmt.all(...clean(params)).map(plain);
      return { changes: 0, lastId: null, rows };
    }
    const r = stmt.run(...clean(params));
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid), rows: [] };
  }

  async get(sql, ...params) {
    return plain(this.db.prepare(sql).get(...clean(params)));
  }

  async all(sql, ...params) {
    return this.db.prepare(sql).all(...clean(params)).map(plain);
  }

  async run(sql, ...params) {
    return this.exec1(sql, params);
  }

  /** Run [sql, ...params] statements atomically, like a D1 batch. */
  async batch(statements) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(([sql, ...params]) => this.exec1(sql, params));
      this.db.exec('COMMIT');
      return results;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
