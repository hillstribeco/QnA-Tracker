# Security Notes

This document explains the security model in plain language, and flags the issues found during the project audit.

---

## How permissions actually work

The app has **two layers** of permission:

| Layer                  | What it does                                          | Can be bypassed by an attacker? |
|------------------------|-------------------------------------------------------|---------------------------------|
| Frontend role check    | Shows/hides UI elements (Review tab, Admin tab, etc.) | **Yes — trivially.**            |
| Row Level Security (RLS) on PostgreSQL | Blocks unauthorized reads/writes at the database itself | **No.**                  |

**The frontend is for UX only.** The database is what actually protects data. If RLS is wrong, the app is insecure even if the UI looks perfect.

The good news: your RLS policies (now consolidated in `00_baseline.sql` section 8) are reasonably strong. The audit found no critical RLS holes.

---

## The Supabase keys

There are two keys, and treating them correctly is critical:

| Key              | Where it goes              | Safe to expose?              |
|------------------|----------------------------|------------------------------|
| **`anon` / `publishable` key** | Frontend JavaScript        | **Yes.** Designed to be public. |
| **`service_role` key**         | Server-side code only      | **Never.** Bypasses RLS.    |

Your current `index.html` hardcodes the `anon` key — that's fine. Just make sure you never paste the `service_role` key into the frontend or commit it to GitHub.

---

## Issues found in the audit

### 🔴 Critical: dead duplicate code

Your `index.html` defines `init()`, `submitQuestion()`, `loadReviewData()`, `loadAdminPanel()`, `addReviewer()`, `removeReviewer()`, `addComment()`, `editComment()`, `toggleResolved()`, and several others **twice**. The second definitions ("V2 OVERRIDES") win, so the first ~1700 lines of JS are dead code. **Why it's a security issue:** if you ever fix a security bug in one copy, the other still has the bug. If JavaScript's hoisting rules ever change (they won't, but the principle), the wrong copy could suddenly run.

**Fix:** delete the first copies. Backlog item, not emergency.

### 🟠 Important: missing table referenced by frontend

The frontend uses `app_reactions` for emoji reactions, but no SQL file defined this table. The new `00_baseline.sql` adds it.

**Fix:** run the new baseline. Already addressed.

### 🟠 Important: three sources of truth for roles

Your old setup had:
- `reviewers` table (just emails)
- `collab_profiles.role` column
- `app_user_roles` table

Three places to add a reviewer; only one (`reviewers`) is actually consulted by the frontend. The new baseline keeps all three but designates `app_user_roles` as canonical and seeds the legacy `reviewers` table from it.

**Fix:** update the frontend to read role from `app_user_roles` exclusively. Then drop `reviewers` and `collab_profiles.role` in a future migration. Backlog item.

### 🟡 Worth fixing: hardcoded admin email everywhere

`hillstribeco@gmail.com` appears in dozens of places across SQL and HTML. Changing your admin requires editing many lines. The new baseline centralizes this — the only place to change is the seed row in `app_user_roles`.

**Fix:** for the frontend, replace any remaining hardcoded email checks with a call to a helper that reads the current user's role.

### 🟡 Worth fixing: `config.js` not yet extracted

Currently `SUPABASE_URL` and `SUPABASE_KEY` are inline in `index.html`. They should be in a separate `config.js` file so:
- The frontend file can be edited without risking credential typos.
- Different environments (staging, production) can use different config files.
- The HTML can be safely shared/templated.

See `public/config.js` template in the restructured project.

### 🟢 Already correct

- RLS is enabled on **every** table.
- Anon key (not service key) is in the frontend.
- HTTPS-only (Netlify default).
- Google OAuth instead of passwords (Google handles MFA, breach detection).
- No SQL injection risk — all queries go through Supabase's parameterized client.
- Question deletion is blocked via RLS — only archive is allowed.

---

## Backups and recovery

- **Supabase free tier:** daily automatic backups, 7-day retention.
- **Supabase Pro:** point-in-time recovery, 30-day retention.
- **Manual export:** `supabase db dump > backup-2026-05-25.sql` via the Supabase CLI. Worth doing monthly.

---

## What to do if a Google account is compromised

If a staff member's Google account is hijacked, the attacker gets the same access that user had — which is exactly why staff have minimal permissions in the role model. To revoke:

1. Supabase → **Authentication** → **Users** → find the user → **Delete user**.
2. Or set their role in `app_user_roles` to `staff` (downgrades them but preserves history).
3. The user's existing comments and questions stay (with their name attached for accountability).

---

## What to do if the database is leaked or compromised

1. **Rotate the database password** — Supabase → Settings → Database.
2. **Rotate the anon key** — Supabase → Settings → API → roll the anon key. Update `config.js`.
3. **Audit `activity_log`** — find the timeframe of the incident.
4. **Restore from backup** if data was tampered with — Supabase → Database → Backups → restore.
5. **Force all users to sign in again** — Supabase → Authentication → bulk sign-out.

---

## What to do if you (the admin) forget your access

The Supabase database password is stored only in Supabase. If you lose it, you can reset it from the Supabase dashboard as long as you can still sign in to Supabase.

**Do not lose access to:**
- The Google account associated with the Supabase organization
- The GitHub repo
- The domain registrar (if using a custom domain)

Consider storing these in a password manager and giving emergency access to a second trusted person.
