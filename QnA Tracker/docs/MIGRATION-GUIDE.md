# Migrating from the Old Structure

This document explains how to safely move from your **current** project (the ZIP I analyzed) to the **new** structure.

> **Important:** your existing Supabase database is already in production. We don't want to wipe and rebuild it — we want to bring it in line with the new clean baseline. Because every SQL statement in `00_baseline.sql` is idempotent (`if not exists`, `on conflict`, `drop policy if exists`), **you can simply run the new baseline on your existing database and it will safely upgrade it.**

---

## Step-by-step

### Step 1 — Back up your current database (5 min)

This is the only step you must not skip.

1. Supabase → **Database** → **Backups** → confirm a recent backup exists.
2. Optionally, also use the Supabase CLI:
   ```bash
   supabase db dump -f backup-before-restructure.sql
   ```
3. Keep this file somewhere safe.

### Step 2 — Run the new consolidated baseline (5 min)

1. Supabase → **SQL Editor** → **New query**.
2. Paste the entire contents of `database/00_baseline.sql`.
3. Click **Run**.
4. Wait for "Success".

This will:
- Add the `app_reactions` table that was previously missing.
- Re-create all RLS policies cleanly (drops duplicates first).
- Add any indexes you didn't have.
- Reseed default issue fields if any are missing.
- **Not** touch your existing data. All questions, comments, profiles, messages remain.

### Step 3 — Replace your file structure (10 min)

1. Take your existing `index.html` and copy it to the new `frontend/` folder.
2. Rename it to `index.html` (drop the `_production_refactored_qa_hardened` suffix).
3. Delete the old `Index/` folder.

Your old SQL files (`supabase-setup.sql`, etc.) can now be deleted — they're all superseded by `00_baseline.sql`. **Archive them somewhere first** so you have history.

### Step 4 — Update Netlify deploy settings (2 min)

If you're currently deploying the root folder, update Netlify's **Publish directory** to `frontend`.

### Step 5 — Verify (5 min)

1. Open the live app.
2. Sign in.
3. Submit a test question. Check it appears.
4. Reply to it. Check the answer flow works.
5. Open the chat. Send a message. Check realtime works.
6. (If admin) check the admin dashboard loads.

Done. Total downtime: zero. Your data is intact.

---

## What about the dead code in `index.html`?

That's a **separate** improvement, not required for this migration.

The current `index.html` has two `init()` functions, two `submitQuestion()`s, etc. The second copy ("V2 OVERRIDES") wins because of JavaScript's function-declaration hoisting rules. The first copy is roughly 1700 lines of unused code.

Removing it is safe but should be done carefully:

1. Make a working copy of `index.html` named `index.cleaned.html`.
2. Delete the first `<script>` block contents from line ~2101 down to the V2 OVERRIDES header at line ~3794. **Keep** the V2 OVERRIDES block.
3. Test thoroughly in a Live Server preview.
4. If everything still works, replace `index.html`.
5. If anything breaks, revert from your working copy.

This is a half-day project. Hold off until you have nothing more urgent to fix.

---

## What about the third "source of truth" for roles?

Right now, three different places store reviewer/admin info:

1. `reviewers` table — used by frontend `isReviewer()` check.
2. `collab_profiles.role` — used by some chat permission checks.
3. `app_user_roles` — the new canonical store.

The new `00_baseline.sql` keeps all three for compatibility, but writes new admins to `app_user_roles`. To fully consolidate:

**Phase 1 (now):** Update the frontend to read role from `app_user_roles` for all permission checks. Continue writing to all three when adding a reviewer (so nothing breaks).

**Phase 2 (later):** Drop the `reviewers` table and the `collab_profiles.role` column in a future migration. Document the breaking change.

For now, no action needed. The system works; it's just slightly redundant.

---

## Cross-check before you delete the old SQL files

Quick mental check: does the new `00_baseline.sql` cover what each old file did?

| Old file                                       | Covered by new baseline?                |
|------------------------------------------------|-----------------------------------------|
| `supabase-setup.sql`                           | ✅ Sections 2, 8                        |
| `supabase-setup-admin-comments.sql`            | ✅ Sections 2a, 1, 8                    |
| `supabase-admin-dashboard-v2.sql`              | ✅ Sections 2, 3, 4, 8                  |
| `supabase-admin-dashboard-phase3.sql`          | ✅ Section 7 (search indexes), Section 10 (views) |
| `question_views_update.sql`                    | ✅ Section 2b, 8                        |
| `collaboration_system_update.sql`              | ✅ Section 5, 8, 9                      |
| `collaboration_profile_chat_update.sql`        | ✅ Section 5 (profile columns)          |
| `user_info_rbac_update.sql`                    | ✅ Sections 1, 1a                       |
| `admin_customization_system_update.sql`        | ✅ Sections 3, 4 (`admin_customization_activity`), questions.custom_fields column |

Plus: the new baseline adds the missing `app_reactions` table that no old file defined.

Safe to archive your old SQL files.
