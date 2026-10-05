'use strict';

const path = require('node:path');
const { createApp } = require('./app');
const { TZ } = require('./time');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const dbPath = process.env.DB_PATH || path.join(dataDir, 'attendance.db');
const port = Number(process.env.PORT) || 3000;

const app = createApp({ dbPath, dataDir });
app.listen(port, () => {
  console.log(`Attendance app listening on http://localhost:${port} (time zone ${TZ}, data in ${dataDir})`);
});
