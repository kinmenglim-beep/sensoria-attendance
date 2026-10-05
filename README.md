# Attendance: check in/out for part-time and gig workers

A small web app that runs in the phone browser, so there is nothing to install. Workers clock in and out.
Supervisors approve shifts and see who is missing. Management downloads a monthly CSV for payroll.

## What it does

**Workers** (on their phone)
- Sign in with their phone number or staff ID and a PIN. They stay signed in for 60 days.
- One big **Clock IN / Clock OUT** button. The phone records GPS location and a selfie, depending on the settings.
- **My hours**: each shift with check-in/out times, hours, status, who approved it and when, plus monthly totals and an estimated pay.

**Supervisors**
- **Dashboard** for any day: who is *working now*, *clocked out* or *not clocked in*. It also lists shifts waiting for approval, with tick boxes to approve many at once.
- Alerts for workers who **never clocked out** and for approvals left over from earlier days.
- **Shift detail**: selfie, distance from the venue with a map link, IP address, flags, and a full history (audit log).
  From here a supervisor can approve, reject (with a reason the worker can see), or correct the times.
- **Add shift manually** for a worker who couldn't clock in (dead phone and so on).
- **People**: add workers and supervisors, set hourly rates, reset PINs, deactivate leavers.
- **Settings**: verification options and work sites (geofences).

**Monthly export** (Export page)
- **Summary CSV**: one row per worker with days worked, shifts, approved, pending and rejected hours, rate, and approved pay.
  It also has a column for each day of the month with that day's approved hours, plus a TOTAL row. Every worker is in a single table.
- **Detailed CSV**: one row per shift with date, check-in, check-out, hours, status, approved/rejected by, approval timestamp,
  notes, GPS distance and coordinates, selfie taken, and flags.
- Only **approved** hours count as payable. Pending and rejected hours are shown separately.

## Verification: what's recommended

| Method | How it works | Effort for workers | Cheating resistance | Notes |
|---|---|---|---|---|
| **GPS geofence** ✅ | The phone's location is compared with your venue(s) | None (one-time "allow location") | Medium | Works on any phone. Indoor GPS can be off by 20–100 m, so use a 100–200 m radius. |
| **Selfie** ✅ | Front-camera photo at check-in | One tap | High (stops buddy-punching) | Photos are small (~50 KB) and visible only to supervisors and the worker. |
| **Venue WiFi** | Checks the venue's *public IP* | Must be on the WiFi | Medium–High | A browser can't read the WiFi name. This only works if the venue has a fixed IP, and it fails when a worker is on mobile data. |

**Default setup: GPS in "flag" mode plus a selfie at check-in.** Nobody is ever blocked from clocking in, even when GPS is
flaky indoors. Anything unusual is flagged so the supervisor can review it before approving. If people start abusing
it, switch GPS to "block" in Settings. Add the WiFi check only if the venue has a fixed IP and everyone uses the WiFi.

## Running it

Requires **Node.js 22.13+**. No database server is needed: data is stored in SQLite under `./data`.

```bash
npm install
npm start          # http://localhost:3000
```

On first visit, the setup page creates the first supervisor. Then add workers on **People** and add your venue on
**Settings → Work sites** (stand at the venue and tap "Use my current location").

### Deploying (HTTPS is required)

Phones only allow GPS and camera access on **HTTPS** sites, so the app must be served over HTTPS.
The simplest options:

- **Small VPS** (DigitalOcean, Lightsail, Hetzner; about US$5/month) with [Caddy](https://caddyserver.com) in front.
  Caddy gets HTTPS certificates automatically: `your-domain.com { reverse_proxy localhost:3000 }`.
- **Railway / Render / Fly.io** using the included `Dockerfile`. **Attach a persistent volume at `/data`**,
  otherwise data is lost on redeploy.

Back up the `data/` folder, which holds the database and selfies, regularly.

### Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `APP_TZ` | `Asia/Kuala_Lumpur` | Time zone for work dates, display and exports. Set this to your location. |
| `DATA_DIR` | `./data` | Where the database and selfies are stored |
| `TRUST_PROXY` | (unset) | Set to `1` (or `true`) behind Caddy/nginx/a PaaS so the real client IP is used (needed for the WiFi check and login rate-limiting) |
| `COOKIE_SECURE` | auto | Force `true` if HTTPS ends at a proxy and `TRUST_PROXY` isn't set |
| `MAX_SHIFT_HOURS` | `16` | An open shift older than this counts as "forgot to clock out" |

## How a day works

1. A worker opens the site, takes a selfie and taps **Clock IN**. Location is recorded and checked against the venue.
2. The supervisor dashboard shows them under **Working now**. Anyone who hasn't arrived is under **Not clocked in**.
3. The worker taps **Clock OUT**, and the shift appears in **Check-ins today** as *Pending*.
4. At the end of the day, the supervisor ticks the shifts and taps **Approve selected**.
   Flagged shifts (outside the area, no GPS, edited) can be opened first to check the selfie and map.
5. If someone forgets to clock out, they can still clock in the next day. The forgotten shift is closed at 0 h and
   flagged **Never clocked out**, and it can't be approved until a supervisor enters the real finish time.
6. At month end, management downloads the CSVs from **Export**.

## Development

```bash
npm run dev   # restarts on file changes
npm test      # unit and end-to-end tests
```

Code layout: `src/app.js` (server and login), `src/routes/worker.js`, `src/routes/admin.js`, `src/report.js` (monthly
totals), `src/verify.js` (geofence and IP), `public/` (CSS and small scripts).
