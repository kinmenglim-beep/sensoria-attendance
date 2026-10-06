# Attendance: check in/out for part-time and gig workers

A small web app that runs in the phone browser, so there is nothing to install. Workers clock in and out.
Supervisors approve shifts and see who is missing. Management downloads a monthly CSV for payroll.

## What it does

**Workers** (on their phone)
- Sign in with their phone number or staff ID and a PIN. They stay signed in for 60 days.
- One big **Clock IN / Clock OUT** button. The phone records GPS location and which device was used (and a selfie, if enabled).
- **My hours**: each shift with check-in/out times, hours, status, who approved it and when, plus monthly totals and an estimated pay.

**Supervisors**
- **Dashboard** for any day: who is *working now*, *clocked out* or *not clocked in*. It also lists shifts waiting for approval, with tick boxes to approve many at once.
- Alerts for workers who **never clocked out** and for approvals left over from earlier days.
- **Shift detail**: distance from the venue with a map link, the device used, IP address, flags, and a full history (audit log).
  From here a supervisor can approve, reject (with a reason the worker can see), or correct the times.
- **Add shift manually** for a worker who couldn't clock in (dead phone and so on).
- **People**: add workers and supervisors, set hourly rates, reset PINs, deactivate leavers. Each worker's page lists the devices they've used.
- **Settings**: verification options and work sites (geofences).

**Monthly export** (Export page)
- **Summary CSV**: one row per worker with days worked, shifts, approved, pending and rejected hours, rate, and approved pay.
  It also has a column for each day of the month with that day's approved hours, plus a TOTAL row. Every worker is in a single table.
- **Detailed CSV**: one row per shift with date, check-in, check-out, hours, status, approved/rejected by, approval timestamp,
  notes, GPS distance and coordinates, check-in/out device, and flags.
- Only **approved** hours count as payable. Pending and rejected hours are shown separately.

## Verification: what's recommended

| Method | How it works | Effort for workers | Cheating resistance | Notes |
|---|---|---|---|---|
| **GPS geofence** ✅ | The phone's location is compared with your venue(s) | None (one-time "allow location") | Medium | Works on any phone. Indoor GPS can be off by 20–100 m, so use a 100–200 m radius. |
| **Device check** ✅ | Each worker's phone is registered; other phones, shared phones and frequent changes are flagged | None | Medium–High (catches buddy-punching) | Only supervisors can see it. Can be set to allow the registered phone only. |
| **Selfie** | Front-camera photo at check-in | One tap | High | Off by default. Turn it on in Settings if needed. |
| **Venue WiFi** | Checks the venue's *public IP* | Must be on the WiFi | Medium–High | A browser can't read the WiFi name. This only works if the venue has a fixed IP, and it fails when a worker is on mobile data. |

**Default setup: GPS in "flag" mode plus the device check.** Nobody is ever blocked from clocking in, even when GPS is
flaky indoors. Anything unusual is flagged so the supervisor can review it before approving. If people start abusing
it, switch GPS to "block" or turn on selfies in Settings.

### Device check

Browsers don't reveal a phone's real name (e.g. "Ali's iPhone"). Instead, the first time a phone clocks in it gets a
random device ID, stored as a cookie with a backup copy in the browser. The supervisor sees a description such as
`iPhone · iOS 17.5 · Safari #7KrwTr` or `SM-A515F · Android 13 · Chrome #Qx81aB`. The `#code` tells apart two
phones of the same model.

**Registered phone.** Gig workers normally keep the same phone, so each worker's **first** phone is registered
automatically. Supervisors see these automatic flags; workers never do:
- **Not their registered phone**: the worker clocked in/out on a different phone. The phone also appears under
  **📱 Unregistered phones to review** on the dashboard. If the worker genuinely changed phone, open their page
  (People → name → *Phones*) and tap **Register**, and unregister the old one. Otherwise tap **Ignore**, and check-ins
  from that phone stay flagged.
- **🚩 Many different phones lately**: the worker used 3 or more different phones in the last 30 days. They are
  listed in a red alert at the top of the dashboard and marked 🚩 in the People list. This is the strongest sign that
  someone else is clocking in for them. The number is adjustable in Settings.
- **Device also used by another worker**: the same phone was used by two workers, e.g. a friend clocking in for a
  buddy on their own phone.
- **Clocked out on a different device**: the check-out phone differs from the check-in phone.

**Settings → Phone check** has three modes:
- **Flag** (default): unregistered phones are allowed but flagged.
- **Only allow the registered phone**: other phones are refused. The worker is asked to use their usual phone or get
  the new one approved, and the attempt shows up for review.
- **Off**: the device is recorded only.

A one-off new phone can be innocent: cleared browser data, private/incognito mode, a different browser, or iPhone
"Add to Home Screen" (which counts as a separate browser). Ask the worker before acting on a single flag. Repeated
changes or sharing are the real red flags.

## Running it

Requires **Node.js 22.13+**. No database server is needed: data is stored in SQLite under `./data`.

```bash
npm install
npm start          # http://localhost:3000
```

On first visit, the setup page creates the first supervisor. Then add workers on **People** and add your venue on
**Settings → Work sites** (stand at the venue and tap "Use my current location").

### Deploying on Railway (recommended)

Phones only allow GPS on **HTTPS** sites, and Railway provides HTTPS automatically. Expect about US$5/month on the
Hobby plan. The repo already includes `railway.json` and a `Dockerfile`, so there's nothing to configure in code.

1. Go to [railway.com](https://railway.com) and **sign in with GitHub**, using the account that owns this repo.
   Choose the Hobby plan.
2. **New Project → Deploy from GitHub repo →** pick `sensoria-attendance`. Allow Railway access to the repo if asked.
3. **Add storage. Don't skip this, or all data is wiped on every update.** Right-click the service on the project
   canvas (or use the command palette, ⌘K / Ctrl+K) → **Add Volume** → mount path `/data`. Until a volume is
   attached, supervisors see a red warning banner in the app.
4. Service → **Settings → Networking → Generate Domain**. This gives you a link like
   `https://sensoria-attendance-production.up.railway.app`.
5. Open the link. The first visit shows the setup page: create the supervisor account. Then add the venue under
   **Settings → Work sites**, add workers under **People**, and send each worker the link with their ID and PIN.

Every push to the deployed branch redeploys automatically, and the data on the volume is kept. To use your own domain
(e.g. `attendance.yourcompany.com`), add it under Settings → Networking → Custom Domain and create the DNS record it
shows. Back up regularly: Railway volumes support backups in the volume's settings.

### Deploying elsewhere

Any host that runs Docker works with the included `Dockerfile`. Mount persistent storage at `/data`, serve the app
over HTTPS, and set `TRUST_PROXY=1` when it sits behind a proxy. On a VPS, [Caddy](https://caddyserver.com) handles
HTTPS automatically: `your-domain.com { reverse_proxy localhost:3000 }`.

### Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `APP_TZ` | `Asia/Kuala_Lumpur` | Time zone for work dates, display and exports. Set this to your location. |
| `DATA_DIR` | `./data` (`/data` in Docker; the volume on Railway) | Where the database and selfies are stored |
| `TRUST_PROXY` | (unset; automatic on Railway) | Set to `1` (or `true`) behind Caddy/nginx/a PaaS so the real client IP is used (needed for the WiFi check and login rate-limiting) |
| `COOKIE_SECURE` | auto | Force `true` if HTTPS ends at a proxy and `TRUST_PROXY` isn't set |
| `MAX_SHIFT_HOURS` | `16` | An open shift older than this counts as "forgot to clock out" |

## How a day works

1. A worker opens the site and taps **Clock IN**. Location and device are recorded and checked.
2. The supervisor dashboard shows them under **Working now**. Anyone who hasn't arrived is under **Not clocked in**.
3. The worker taps **Clock OUT**, and the shift appears in **Check-ins today** as *Pending*.
4. At the end of the day, the supervisor ticks the shifts and taps **Approve selected**.
   Flagged shifts (outside the area, no GPS, new or shared device, edited) can be opened first to check the details.
5. If someone forgets to clock out, they can still clock in the next day. The forgotten shift is closed at 0 h and
   flagged **Never clocked out**, and it can't be approved until a supervisor enters the real finish time.
6. At month end, management downloads the CSVs from **Export**.

## Development

```bash
npm run dev   # restarts on file changes
npm test      # unit and end-to-end tests
```

Code layout: `src/app.js` (server and login), `src/routes/worker.js`, `src/routes/admin.js`, `src/report.js` (monthly
totals), `src/verify.js` (geofence and IP), `src/device.js` (device identification), `public/` (CSS and small scripts).
