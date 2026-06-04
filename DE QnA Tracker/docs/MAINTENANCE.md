# Maintenance Guide

Day-to-day and month-to-month tasks. Written for someone who isn't a developer.

---

## Common tasks

### Add a new reviewer

**Easiest way (in-app):**
1. Sign in as primary admin.
2. Go to **Admin → Reviewers**.
3. Type their email → **Add**.

**Through Supabase directly:**
1. Supabase → **Table Editor** → `app_user_roles`.
2. **Insert row** → email + role `reviewer` → Save.

### Add a new admin

Only the primary admin can do this safely. In Supabase Table Editor:
1. Find the user in `app_user_roles` (or add them).
2. Set `role = admin`.

### Promote a staff member to reviewer

Same as above, but set `role = reviewer`.

### Remove someone

If they've left the company:
1. Supabase → **Authentication** → **Users** → find them → **Delete user**.
2. Their old questions stay (with their name still attached). Cleanup is intentional.

If they're still on staff but you want to revoke reviewer/admin access:
1. Set their `app_user_roles.role` back to `staff`.

### Change the SLA from 2 days to something else

Two ways:
- **In-app:** Admin → SLA settings.
- **Directly:** Supabase → Table Editor → `sla_settings` → edit row id=1 → change `response_days`.

The change takes effect on all *new* questions submitted after the change. Existing questions keep their original `due_at`.

### Add a new question category (issue field)

- **In-app:** Admin → Issue Fields → Add.
- **Directly:** Insert a row in `issue_fields` with name, color_class, sort_order, etc.

### Archive vs delete a question

**Always archive, never delete.** Archive keeps the audit trail intact. Deletion is blocked by RLS specifically to prevent accidents.

To archive: in the Review or All Questions view, select questions → Archive.

To actually permanently delete (admin only, last resort): go to Supabase Table Editor and delete the row manually. There is no recovery.

---

## Monthly checklist

| Task                                            | Why                                         |
|-------------------------------------------------|---------------------------------------------|
| Check Supabase free tier usage (Database tab)   | Avoid surprise overage / pause              |
| Check Netlify bandwidth (Site overview)         | Same.                                       |
| Spot-check `activity_log` for unusual actions   | Security hygiene                            |
| Export a manual DB backup (`supabase db dump`)  | Belt-and-suspenders                         |
| Review the list of admins in `app_user_roles`   | Catch orphaned access                       |

---

## Quarterly checklist

| Task                                                                    | Why                                       |
|-------------------------------------------------------------------------|-------------------------------------------|
| Rotate the Supabase anon key (Settings → API → "Regenerate keys")       | Reduce blast radius if it ever leaked     |
| Review GitHub repo collaborators                                        | Same                                      |
| Update CDN library versions in `index.html` (Supabase, Chart.js, etc.)  | Get security patches                      |
| Vacuum analyze the database (Supabase → SQL Editor → `vacuum analyze;`) | Keep query plans fresh                    |

---

## Common problems & fixes

### "Sign in with Google" doesn't work

Most common cause: the redirect URL in Google Cloud Console doesn't match the Supabase callback URL exactly. Fix: copy the exact URL from Supabase → Authentication → Providers → Google → "Callback URL" and paste into Google Cloud → OAuth client → Authorized redirect URIs.

### App loads but data doesn't appear

1. Open browser DevTools (right-click → Inspect) → **Console** tab.
2. Look for red errors mentioning "PostgREST", "401", or "Row level security".
3. Most likely: your user isn't in `app_user_roles` yet, or their role doesn't grant access.
4. Fix: in Supabase Table Editor, confirm the user has a row.

### Chat messages don't appear in real time

1. Confirm in Supabase → Database → Replication → the `supabase_realtime` publication includes the `collab_messages` table.
2. If it doesn't, re-run section 9 of `00_baseline.sql`.

### A new SQL migration broke the app

1. **Don't panic.** Supabase backs up nightly.
2. Supabase → Database → Backups → restore the previous night's snapshot.
3. You'll lose any data added after the backup. For most internal tools this is acceptable.

### "Supabase project paused" message

The free tier pauses a project after 1 week of zero traffic. The `setInterval` keep-alive ping in your `index.html` runs every 5 days specifically to prevent this — but only if someone has the app open at least once a week. If everyone is on vacation:
1. Go to Supabase dashboard → click your project → "Restore project".
2. Wait ~30 sec → it's back.

---

## Future improvements (backlog)

These are nice-to-have, not urgent. Pick one when you have a quiet afternoon.

| Priority | Item                                                                                              | Effort   |
|:--------:|---------------------------------------------------------------------------------------------------|----------|
| High     | Split `index.html` JavaScript: remove the dead first-copy of functions in the v1 block            | 2-3 hrs  |
| High     | Move credentials from inline JS into `config.js`                                                  | 30 min   |
| Medium   | Consolidate role checks to read only from `app_user_roles` (deprecate `reviewers` table)          | 2 hrs    |
| Medium   | Add Supabase Storage support for question image attachments (currently links-only)                | 3-4 hrs  |
| Medium   | Add a Supabase Edge Function to email users when their question is answered                       | 1-2 hrs  |
| Low      | Extract CSS into a separate `styles.css` file                                                     | 1 hr     |
| Low      | Add automated DB backups to S3 or Google Drive via pg_cron                                        | 2 hrs    |
| Low      | Add a simple "Export to Excel" button on the admin dashboard (uses the already-loaded xlsx lib)   | 1 hr     |
