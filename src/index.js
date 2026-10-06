'use strict';

const path = require('node:path');
const { createApp } = require('./app');
const { TZ } = require('./time');

// On Railway, keep data on the attached volume wherever it is mounted.
const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const dataDir = path.resolve(volume || process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const dbPath = process.env.DB_PATH || path.join(dataDir, 'attendance.db');
const port = Number(process.env.PORT) || 3000;

let storageWarning = null;
if (process.env.RAILWAY_ENVIRONMENT && !volume) {
  storageWarning = 'No storage volume is attached. All data will be lost on the next update or restart. '
    + 'In Railway, add a Volume to this service (mount path /data).';
  console.warn(`WARNING: ${storageWarning}`);
}

const app = createApp({ dbPath, dataDir, storageWarning });
app.listen(port, () => {
  console.log(`Attendance app listening on port ${port} (time zone ${TZ}, data in ${dataDir})`);
});
