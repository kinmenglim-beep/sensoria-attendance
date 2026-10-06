// Async database interface backed by Cloudflare D1.

const clean = (params) => params.map((p) => (p === undefined ? null : p));

export class D1Db {
  constructor(d1) {
    this.d1 = d1;
  }

  stmt(sql, params) {
    const s = this.d1.prepare(sql);
    return params.length ? s.bind(...clean(params)) : s;
  }

  async get(sql, ...params) {
    return (await this.stmt(sql, params).first()) ?? null;
  }

  async all(sql, ...params) {
    return (await this.stmt(sql, params).all()).results;
  }

  async run(sql, ...params) {
    const r = await this.stmt(sql, params).run();
    return { changes: r.meta.changes, lastId: r.meta.last_row_id, rows: r.results || [] };
  }

  /** Run [sql, ...params] statements atomically (D1 batches are transactions). */
  async batch(statements) {
    if (!statements.length) return [];
    const results = await this.d1.batch(statements.map(([sql, ...params]) => this.stmt(sql, params)));
    return results.map((r) => ({ changes: r.meta.changes, lastId: r.meta.last_row_id, rows: r.results || [] }));
  }
}
