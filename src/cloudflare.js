// Cloudflare Workers entry point. Static files in public/ are served by the
// platform; everything else is handled here with the D1 database bound as DB.

import { createApp } from './app.js';
import { D1Db } from './db-d1.js';

export default createApp({
  dbFor: (c) => new D1Db(c.env.DB),
  getIp: (c) => c.req.header('cf-connecting-ip') || '',
});
