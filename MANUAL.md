# Attendance: user manual

> Printable versions for end users: **docs/Worker-Guide.pdf** and **docs/Admin-Guide.pdf** (editable: the `.docx` files).
> Rebuild them with the real link: `APP_LINK=https://… npm run guides`.

> App address: **https://sensoria-attendance.kinmenglim.workers.dev**

## Links

| What | Link | Who |
|---|---|---|
| First-time setup (creates the **first admin**) | `https://sensoria-attendance.kinmenglim.workers.dev/setup` | Owner, **once only**. It stops working after the first admin exists. |
| Sign in (everyone) | `https://sensoria-attendance.kinmenglim.workers.dev/login` | Admins and workers use the same page; each is taken to their own screen. |
| Worker: clock in / out | `https://sensoria-attendance.kinmenglim.workers.dev/` | Workers |
| Worker: my hours | `https://sensoria-attendance.kinmenglim.workers.dev/me` | Workers |
| Admin dashboard (today) | `https://sensoria-attendance.kinmenglim.workers.dev/admin` | Admins |
| Approvals (all pending) | `https://sensoria-attendance.kinmenglim.workers.dev/admin/pending` | Admins |
| Add / edit people, reset PINs | `https://sensoria-attendance.kinmenglim.workers.dev/admin/people` | Admins |
| Monthly export (CSV) | `https://sensoria-attendance.kinmenglim.workers.dev/admin/export` | Admins |
| Settings and work sites | `https://sensoria-attendance.kinmenglim.workers.dev/admin/settings` | Admins |

**Creating accounts:** workers **cannot sign up themselves**. An admin creates every account (workers and other
admins) at **People** (`https://sensoria-attendance.kinmenglim.workers.dev/admin/people`).

---

## Worker guide

**First time (do this before your first shift)**
1. Open the link your supervisor sent you **on your own phone**.
2. Sign in with your **phone number / staff ID** and **PIN**.
3. Optional: add it to your home screen so it opens like an app. **Do this before your first clock-in, and from then
   on always open it the same way.** Each way of opening it counts as a different phone.
   - iPhone (Safari): Share button → **Add to Home Screen**
   - Android (Chrome): ⋮ menu → **Add to Home screen**
4. When asked, tap **Allow** for location.

**Every shift**
1. At the venue, open the app and tap **Clock IN**.
2. When you finish, tap **Clock OUT**.
3. Done. Your supervisor approves your hours.

**Good to know**
- Hours are rounded to the **nearest 15 minutes**: 1:13 counts as 1:15, and 3:24 counts as 3:30.
- **My hours** shows every shift, whether it's approved, who approved it and when.
- Use **only your own phone**. Clocking in for someone else, or on someone else's phone, is flagged.
- **Forgot to clock out?** Tell your supervisor the time you finished. You can still clock in next time as normal.
- **New phone, or "location denied"?** Tell your supervisor. For location, turn on GPS and allow location for the
  site in your browser settings.
- **Forgot your PIN?** Ask your supervisor to reset it.

---

## Admin guide

**One-time setup**
1. Open `https://sensoria-attendance.kinmenglim.workers.dev/setup` and create your admin account (username + password of 8 or more characters).
2. **Settings → Work sites:** stand at the venue and tap **Use my current location** → **Add site**.
   A radius of 150 m is a good default.
3. **People:** add each worker with their name, **phone number** (their sign-in ID), a **PIN** (4 or more digits)
   and, optionally, an hourly rate. Add other admins here too (Role: Supervisor).
4. Send each worker their details (template below).

**Every day (Dashboard)**
- The top cards show **Working now / Clocked out / Not clocked in / To approve**.
- Tick the shifts in **Check-ins today** → **Approve selected**. Ideally do this the same day.
- Shifts with yellow **flags** need a look first: tap **View** to see the location (with a map link) and the phone used.
  - *Checked in outside area / No GPS*: they weren't at the venue, or GPS was off.
  - *Not their registered phone / Device also used by another worker*: possibly someone clocking in for a friend.
  - 🚩 *Many different phones lately* (red banner): a strong warning sign; check with the worker.
- **Wrong time or forgot to clock out:** **View** → enter the correct times → **Save** (it's approved too if the box
  is ticked). Every change is kept in the shift's history.
- **Someone couldn't clock in:** in *Not clocked in*, tap **+ add shift**.
- **Reject:** **View** → type a reason → **Reject**. The worker sees the reason.

**Phones**
- A worker's first phone is registered automatically. If they genuinely change phone, go to **People → their name
  → Phones** → **Register** the new one (and **Unregister** the old one).

**Month end (Export)**
- Approve everything still pending first. **Only approved hours count as payable.**
- **Summary CSV:** one row per worker with total hours and pay, plus hours for each day of the month.
- **Detailed CSV:** every shift with actual and rounded times, who approved it and when.

**People admin**
- **Reset a PIN:** People → name → type a new PIN → Save.
- **Someone leaves:** People → name → untick **Active** → Save. Their history is kept.

**Message template for workers**
> Hi [name], here's our attendance app: https://sensoria-attendance.kinmenglim.workers.dev
> Sign in with your phone number [number] and PIN [PIN].
> Please use your own phone, allow location, and tap Clock IN / Clock OUT at the venue each shift.
