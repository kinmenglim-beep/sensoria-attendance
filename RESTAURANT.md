# Restaurant setup

The restaurant runs **the same app** as the other venue, deployed a second time with its **own link and its own
database**. Staff, hours and settings are completely separate. Bug fixes and improvements reach both, because they
share the code.

What's set up differently for the restaurant:

| Need | How |
|---|---|
| **Time-sensitive** | **Roster** page plus late / too-early / not-rostered checks |
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
   - **Roster and lateness**: *Flag late, too-early and not-rostered clock-ins*. Late after **5** min; clock-in opens
     **30** min before the shift.
   - **Work sites**: stand in the restaurant, tap **Use my current location**, then **Add site** (radius 100–150 m).
3. **People**: add each staff member with their name, **phone number**, a **short name** (initials or nickname) and a
   4-digit **PIN**.
4. **Roster**: type each person's hours for the week (`10-15`, split shift `10-14, 17-22`, late close `18:00-01:00`).
   Next week, tap **Copy last week** and adjust.

## 3. What staff do

1. Open the link on **their own phone**, sign in with their **short name** and PIN, and allow location.
2. Each shift: take the selfie (if turned on) and tap **Clock IN**. The app says if they're late.
   Tap **Clock OUT** when they leave.
3. The home screen shows today's shift and their roster for the week.

## What the manager sees

- **Dashboard**: who is working, who is **late** (and by how much), who **missed** a rostered shift, and who is off.
- Flags on each shift: *Late 12 min*, *Clocked in well before rostered start*, *Not on the roster*,
  *Left before rostered end*, *No selfie*, location and phone flags.
- **Shift page**: the selfie, rostered times, map and phone used.
- **Export**: the monthly CSVs include times late and minutes late per person.
