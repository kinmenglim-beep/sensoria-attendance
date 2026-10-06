// All times are stored in UTC and shown in the business's local time zone.
export const DEFAULT_TZ = 'Asia/Kuala_Lumpur';
export let TZ = DEFAULT_TZ;
let partsFormatter = makeFormatter(TZ);

function makeFormatter(timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
}

/** Switch the business time zone (from the APP_TZ setting). */
export function setTimeZone(tz) {
  if (!tz || tz === TZ) return;
  partsFormatter = makeFormatter(tz); // throws on an invalid zone name
  TZ = tz;
}

function parts(date) {
  const o = {};
  for (const p of partsFormatter.formatToParts(date)) o[p.type] = p.value;
  return o;
}

function toDate(v) {
  return v instanceof Date ? v : new Date(v);
}

/** Local calendar date, YYYY-MM-DD. */
export function localDate(v = new Date()) {
  const p = parts(toDate(v));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Local wall-clock time, HH:MM. */
export function localTime(v) {
  if (!v) return '';
  const p = parts(toDate(v));
  return `${p.hour}:${p.minute}`;
}

export function localDateTime(v) {
  if (!v) return '';
  return `${localDate(v)} ${localTime(v)}`;
}

// Milliseconds the zone is ahead of UTC at the given instant.
function offsetMs(ms) {
  const p = parts(new Date(ms));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - (ms - (ms % 1000));
}

/** Convert a local date (YYYY-MM-DD) + time (HH:MM) to a UTC ISO string. */
export function localToUtcIso(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - offsetMs(guess);
  t = guess - offsetMs(t); // second pass handles DST transitions
  return new Date(t).toISOString();
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}

export function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function hoursBetween(startIso, endIso) {
  if (!startIso || !endIso) return 0;
  const ms = Date.parse(endIso) - Date.parse(startIso);
  return Math.max(0, Math.round(ms / 36e3) / 100);
}

export function formatDuration(ms) {
  const mins = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

export function prettyDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

export function prettyMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
export const isMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
export const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

