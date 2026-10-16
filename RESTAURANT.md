# Restaurant setup (Ossu)

The restaurant runs **the same app** as the other venue, deployed a second time with its **own link and its own
database**. Staff, hours and settings are completely separate. Bug fixes and improvements reach both, because they
share the code.

It's used as an **attendance record**, not for pay: working hours are fixed, and the app records who came in late,
left early or took more than their one day off a week, so warnings or penalties can be issued separately. There is
**no roster to fill in**: staff arrange their own days off among themselves. Clock times are shown exactly as they
happened (no rounding).

| Need | How |
|---|---|
| **Time-sensitive** | Fixed **working hours** in Settings, plus the **Attendance** page: late arrivals, early leaves, extra days off |
| **Location** | GPS geofence around the restaurant |
| **Selfie** | Optional selfie at clock-in (ask, or require) |
| **Only their own phone** | Phone check set to *Only allow the registered phone* |
| **Easy login** | Register staff by phone number and give each a **short name** (e.g. `KML`) to sign in with |

## 1. Deploy (once, about 10 minutes, free)

0. Make sure these changes are merged into `claude/gig-worker-checkin-system-dmyys6`, the repository's main branch,
   which Cloudflare deploys from. Merging them also updates the other venue's app; everything new there is off by
   default, so it keeps working as before.
1. In the Cloudflare dashboard (the same account is fine): **Workers & Pages → Create → Import a repository** and pick
   `sensoria-attendance` again.
2. On the setup screen:
   - Project name: **`ossu-attendance`** (it must match `name` in `wrangler.ossu.jsonc`).
   - **Deploy command:** `npx wrangler deploy --config wrangler.ossu.jsonc`
   - **Production branch** (if asked, under advanced settings): `claude/gig-worker-checkin-system-dmyys6`
3. Click **Deploy**. The first deploy creates the restaurant's own database. The link looks like
   `https://ossu-attendance.<your-name>.workers.dev`.
4. The app shows "Ossu Attendance" in the menu bar; change `APP_NAME` in `wrangler.ossu.jsonc` to rename it.

If the first deploy fails with a database error, create a D1 database called `ossu-attendance`
(**Storage & Databases → D1 → Create**) and add its `"database_id"` to `wrangler.ossu.jsonc`, as described in the README.

## 2. First-time setup in the app

1. Open `<link>/setup` and create the manager account.
2. **Settings**, recommended for the restaurant:
   - **GPS location**: *Location required to clock in/out; flag if outside a work site*. Staff can't clock in with
     location off; the phone tells them how to turn it on. (*Must be at a work site* is stricter: it also refuses
     clock-ins from outside, which can catch people standing at the door when indoor GPS is off.)
   - **Phone check**: *Only allow the worker's registered phone*. A worker's first phone is registered automatically,
     so a colleague who signs in as them on their own phone can't clock in for them.
   - **Selfie at clock-in**: *Ask for a selfie; flag if skipped*, or *Selfie required*.
   - **Attendance record**: *On*. **Working hours** e.g. `10:00-22:00` (split shift: `10-14, 17-22`).
     **Days off allowed per week**: 1. **Grace period**: 5 min (arriving at 10:06 for 10:00 is late; leaving at 21:54
     for 22:00 is early).
   - **Work sites**: stand in the restaurant, tap **Use my current location**, then **Add site** (radius 100–150 m).
3. **People**: add each staff member with their name, **phone number**, a **short name** (initials or nickname) and a
   4-digit **PIN**. Only if someone works different hours (e.g. evenings only), fill in their **Working hours**.

That's all. Nothing needs updating week to week.

## More than one outlet

Add each outlet under **Settings → Work sites** (stand inside it, tap **Use my current location**, name it e.g. `PJ`,
then do the same at `KL`). Same app, same staff, same login. Staff clock in wherever they are working that day and the
shift is filed under that outlet. The Dashboard, Attendance and Export pages then have an *All outlets | PJ | KL*
switch, and the CSVs can be downloaded per outlet. If an outlet keeps different hours, type them next to it under
Work sites.

## 3. What staff do

1. Open the link on **their own phone**, sign in with their **short name** and PIN, and allow location.
2. Each shift: take the selfie (if turned on) and tap **Clock IN**. The app says if they're late.
   Tap **Clock OUT** when they leave.
3. The home screen shows their working hours and how many days off they've taken this week (e.g. "1 of 1").

## What the manager sees

- **Dashboard** (today, live): who is working, who hasn't come in yet, and a red flag on anyone missing today who
  **already had their day off this week**.
- **Attendance** (per month): for each person, days worked, days off, **extra days off**, **times late / minutes late**
  and **times left early / minutes early**, plus every incident with the date, working hours and actual time. Click a
  name for that person's record, e.g. before a warning. **CSV** downloads it for your records.
- Flags on each shift: *Late 12 min*, *Left 30 min early*, *No selfie*, location and phone flags.
- **Shift page**: the selfie, working hours, map and phone used. If someone forgot to clock out, correct the time here;
  if they forgot to clock in, use **+ add shift** so the day counts as worked. The record uses the corrected times.

The **Approvals** and **Export** (hours and pay) pages are there too but aren't needed for the attendance record.
