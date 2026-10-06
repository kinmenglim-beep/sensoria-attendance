// Node entry point: local development and self-hosting (e.g. Docker).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';

import { createApp } from './app.js';
import { NodeDb } from './db-node.js';
import { TZ, setTimeZone } from './time.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(here, '..', 'data'));
const db = new NodeDb(process.env.DB_PATH || path.join(dataDir, 'attendance.db'));
const port = Number(process.env.PORT) || 3000;
const trustProxy = !!process.env.TRUST_PROXY && process.env.TRUST_PROXY !== 'false';
if (process.env.APP_TZ) setTimeZone(process.env.APP_TZ);

const app = createApp({
  dbFor: () => db,
  trustProxy,
  getIp: (c) => {
    const forwarded = trustProxy && c.req.header('x-forwarded-for');
    return forwarded ? forwarded.split(',')[0].trim() : c.env.incoming.socket.remoteAddress;
  },
  assets: serveStatic({ root: path.relative(process.cwd(), path.join(here, '..', 'public')) || '.' }),
});

serve({ fetch: app.fetch, port }, () => {
  console.log(`Attendance app listening on http://localhost:${port} (time zone ${TZ}, data in ${dataDir})`);
});
