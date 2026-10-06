# Attendance: check in/out for part-time and gig workers

> **Using the app?** See **[MANUAL.md](MANUAL.md)** for the links and the worker and admin guides.

A small web app that runs in the phone browser, so there is nothing to install. Workers clock in and out.
Supervisors approve shifts and see who is missing. Management downloads a monthly CSV for payroll.

## What it does

**Workers** (on their phone)
- Sign in with their phone number or staff ID and a PIN. They stay signed in for 60 days.
- One big **Clock IN / Clock OUT** button. The phone records GPS location and which device was used.
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
| **Venue WiFi** | Checks the venue's *public IP* | Must be on the WiFi | Medium–High | A browser can't read the WiFi name. This only works if the venue has a fixed IP, and it fails when a worker is on mobile data. |

**Default setup: GPS in "flag" mode plus the device check.** Nobody is ever blocked from clocking in, even when GPS is
flaky indoors. Anything unusual is flagged so the supervisor can review it before approving. If people start abusing
it, switch GPS to "block" or the phone check to "only allow the registered phone" in Settings.

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

## Deploying for free on Cloudflare

The app runs on **Cloudflare Workers** with Cloudflare's built-in database (**D1**). The free plan needs no credit
card, is always on (no "waking up" delay), includes an HTTPS link (phones only allow GPS on HTTPS) and has limits far
above what a small team uses: 100,000 requests a day, 5 GB of storage, 100,000 database writes a day.

1. **Create a free Cloudflare account** at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up).
2. In the dashboard: **Workers & Pages → Create → Import a repository** (under "Workers"). Connect your GitHub account
   and pick `sensoria-attendance`.
3. On the setup screen, keep the project name **`sensoria-attendance`** (it must match `wrangler.jsonc`) and leave
   the default deploy command (`npx wrangler deploy`). Click **Deploy**.
4. The first deploy **creates the database automatically**. When it finishes, the dashboard shows the app's link, e.g.
   `https://sensoria-attendance.<your-name>.workers.dev`.
5. Open the link. The first visit shows the setup page: create the supervisor account. Then add the venue under
   **Settings → Work sites**, add workers under **People**, and send each worker the link with their ID and PIN.

Every push to GitHub redeploys automatically, and the data in D1 is kept.

**If the first deploy fails with a database error:** go to **Storage & Databases → D1 → Create**, name it
`sensoria-attendance`, copy its **Database ID**, add `"database_id": "<that id>"` next to `"database_name"` in
`wrangler.jsonc`, push, and the deploy re-runs.

**Backups:** D1 keeps a point-in-time history (Time Travel, 7 days on the free plan) for restoring after a mistake.
For long-term records, download the monthly CSVs from **Export**.

**Your own domain (optional):** Worker → Settings → Domains & Routes → add e.g. `attendance.yourcompany.com`
(the domain must be on Cloudflare).

### Settings (`wrangler.jsonc` → `vars`)

| Variable | Default | Purpose |
|---|---|---|
| `APP_TZ` | `Asia/Kuala_Lumpur` | Time zone for work dates, display and exports |
| `MAX_SHIFT_HOURS` | `16` | An open shift older than this counts as "forgot to clock out" |
| `ROUND_MINUTES` | `15` | Round clock times to the nearest N minutes for pay; `0` turns rounding off |

### Self-hosting instead (optional)

The same code also runs on Node.js 22.13+ with a local SQLite file. Use `npm start`, or the included `Dockerfile`
with persistent storage mounted at `/data`. Environment variables: `PORT` (3000), `APP_TZ`, `DATA_DIR`
(`./data`), `MAX_SHIFT_HOURS`, `ROUND_MINUTES`, and `TRUST_PROXY=1` when running behind a reverse proxy (needed for the real client
IP and HTTPS cookies). Serve it over HTTPS.

## Time rounding

Hours are paid on times **rounded to the nearest quarter hour**: up to 7 minutes past rounds down, 8 or more rounds
up. For example, clocking in at 1:13pm and out at 3:24pm counts as 1:15pm–3:30pm, which is **2h 15m (2.25 h)**.
The real clock times are always kept. Screens show them with the rounded time in brackets, e.g. `13:13 (13:15)`. The
detailed CSV has actual times, rounded times, hours (rounded, used for pay) and actual hours. Change the interval with
`ROUND_MINUTES`. Rounding is applied when hours are calculated, so changing it also changes past months' figures.

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
npm install
npm run dev        # Cloudflare's local runtime with a local D1 database: http://localhost:8787
npm start          # or plain Node.js with SQLite in ./data: http://localhost:3000
npm test           # unit and end-to-end tests
```

On first visit, the setup page creates the first supervisor.

Code layout:
- `src/app.js`: routing, login and sessions (Hono)
- `src/routes/worker.js` and `src/routes/admin.js`: the pages
- `src/db.js`: schema and helpers
- `src/db-d1.js` and `src/db-node.js`: database adapters for Cloudflare and Node
- `src/report.js`: monthly totals
- `src/verify.js`: geofence and IP checks
- `src/device.js`: device identification
- `src/cloudflare.js` and `src/node.js`: entry points
- `public/`: CSS and small scripts
