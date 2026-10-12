# Restaurant setup

The restaurant runs **the same app** as the other venue, deployed a second time with its **own link and its own
database**. Staff, hours and settings are completely separate. Bug fixes and improvements reach both, because they
share the code.

It's used as an **attendance record**, not for pay: working hours are fixed, and the app records who came in late,
left early or didn't turn up, so warnings or penalties can be issued separately. Clock times are shown exactly as
they happened (no rounding).

| Need | How |
|---|---|
| **Time-sensitive** | Each person's **usual hours**, plus the **Attendance** page: late arrivals, early leaves, no-shows |
| **Location** | GPS geofence around the restaurant |
| **Selfie** | Optional selfie at clock-in (ask, or require) |
| **Only their own phone** | Phone check set to *Only allow the registered phone* |
| **Easy login** | Register staff by phone number and give each a **short name** (e.g. `KML`) to sign in with |

## 1. Deploy (once, about 10 minutes, free)

1. In the Cloudflare dashboard (the same account is fine): **Workers & Pages → Create → Import a repository** and pick
   `sensoria-attendance` again.
2. On the setup screen:
   - Project name: **`restaurant-attendance`** (it must match `name` in `wrangler.restaurant.jsonc`).
   - **Deploy command:** `npx wrangler deploy --config wrangler.restaurant.jsonc`
3. Click **Deploy**. The first deploy creates the restaurant's own database. The link looks like
   `https://restaurant-attendance.<your-name>.workers.dev`.
4. Optional: change the name shown in the app by editing `APP_NAME` in `wrangler.restaurant.jsonc` (e.g. your
   restaurant's name) and pushing.

If the first deploy fails with a database error, create a D1 database called `restaurant-attendance`
(**Storage & Databases → D1 → Create**) and add its `"database_id"` to `wrangler.restaurant.jsonc`, as described in the README.

## 2. First-time setup in the app

1. Open `<link>/setup` and create the manager account.
2. **Settings**, recommended for the restaurant:
   - **GPS location**: *Record location, flag if outside a work site*. Switch to *Must be at a work site* if needed.
   - **Phone check**: *Only allow the worker's registered phone*. A worker's first phone is registered automatically,
     so a colleague who signs in as them on their own phone can't clock in for them.
   - **Selfie at clock-in**: *Ask for a selfie; flag if skipped*, or *Selfie required*.
   - **Roster and lateness**: *Flag late, too-early and not-rostered clock-ins*. Grace period **5** min (arriving at
     10:06 for 10:00 is late; leaving at 21:54 for 22:00 is early); clock-in opens **30** min before the shift.
   - **Work sites**: stand in the restaurant, tap **Use my current location**, then **Add site** (radius 100–150 m).
3. **People**: add each staff member with their name, **phone number**, a **short name** (initials or nickname) and a
   4-digit **PIN**.
4. **Roster → Usual hours**: type each person's normal week once (`10-22`, split shift `10-14, 17-22`, late close
   `18:00-01:00`, blank for their day off). It repeats every week.
5. **Roster → Week by week**, only when something changes: leave, a swapped day off, extra hours.

## 3. What staff do

1. Open the link on **their own phone**, sign in with their **short name** and PIN, and allow location.
2. Each shift: take the selfie (if turned on) and tap **Clock IN**. The app says if they're late.
   Tap **Clock OUT** when they leave.
3. The home screen shows today's shift and their roster for the week.

## What the manager sees

- **Dashboard** (today, live): who is working, who is **late** (and by how much), who **missed** their shift, who is off.
- **Attendance** (per month): for each person, rostered shifts, attended, **times late / minutes late**, **times left
  early / minutes early** and **no-shows**, plus every incident with date, rostered time and actual time. Click a
  name for that person's record, e.g. before a warning. **CSV** downloads it for your records.
- Flags on each shift: *Late 12 min*, *Left 30 min early*, *Not on the roster*, *No selfie*, location and phone flags.
- **Shift page**: the selfie, rostered times, map and phone used. If someone forgot to clock in or out, correct the
  time here; the attendance record uses the corrected time.

The **Approvals** and **Export** (hours and pay) pages are there too but aren't needed for the attendance record.
