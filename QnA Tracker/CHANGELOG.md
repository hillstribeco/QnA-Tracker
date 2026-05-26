# Changelog

A running log of meaningful changes. Add a new entry whenever you make a real change to schema, security, or behavior. Newest entries go at the top.

## 2026-05-26 — Bug fixes (comment/attachment UI)

Three pre-existing bugs fixed (not caused by the restructuring):

- **Comment-form buttons (Reply, Clear, Upload, Link, Emoji) were unresponsive** on FAQ, Review, and Follow-up pages. Caused by a document-level capture-phase click listener calling `stopPropagation()` before the event reached the buttons. Removed the broken listener.
- **Attachment × remove button didn't react** until page refresh. Same root cause as above; fixed by the same change.
- **Uploaded images displayed as a long base64 text string** instead of inline images. Added a self-contained rendering patch that converts `[Attachment: name](url)` markdown into `<img>` or `<a>` elements. Also hardened against unsafe URL schemes (`javascript:`, etc.).

See `docs/BUGFIXES-2026-05-26.md` for full diagnosis, repro steps, and rollback instructions.

## 2026-05-26 — HTML cleanup

- Removed 30 duplicate function definitions from `index.html` (the V1 block was dead code overridden by V2 OVERRIDES). 761 lines / 33 KB removed.
- Extracted Supabase credentials from inline JavaScript into `frontend/config.js`.
- Added `<script src="config.js"></script>` include before the inline scripts.
- Renamed `index_production_refactored_qa_hardened.html` → `index.html`.
- All 75 unique helper functions from the V1 block preserved (still called by V2 code).
- Both inline script blocks pass Node.js syntax check.
- No HTML markup, CSS, or business logic was modified.
- See `docs/HTML-CLEANUP-NOTES.md` for the full diff.

## 2026-05-26 — Project restructuring

- Consolidated 9 scattered SQL files into a single `database/00_baseline.sql`.
- Added missing `app_reactions` table (was referenced by frontend but undefined in old SQL).
- Established `app_user_roles` as the canonical role store; kept `reviewers` for legacy compatibility.
- Centralized role-check helpers: `is_admin()`, `is_reviewer()`, `current_user_email()`.
- Created folder structure: `frontend/`, `database/`, `database/migrations/`, `docs/`.
- Wrote `README.md`, `ARCHITECTURE.md`, `DATABASE.md`, `DEPLOYMENT.md`, `SECURITY.md`, `MAINTENANCE.md`, `MIGRATION-GUIDE.md`.
- Extracted Supabase credentials into `frontend/config.js`.

## Earlier history (before restructuring)

Reconstructed from the chronological order of the original SQL files:

- 2026-05-21 — Initial `questions` table and basic RLS (`supabase-setup.sql`).
- 2026-05-22 — Added `reviewers` and threaded `question_comments` (`supabase-setup-admin-comments.sql`).
- 2026-05-23 — Admin Dashboard v2: `issue_fields`, `sla_settings`, `activity_log`, archive, SLA triggers (`supabase-admin-dashboard-v2.sql`).
- 2026-05-23 — Admin Dashboard Phase 3: search indexes, analytics views (`supabase-admin-dashboard-phase3.sql`).
- 2026-05-24 — `question_views` tracking (`question_views_update.sql`).
- 2026-05-25 — Slack-style team chat: `collab_profiles`, `collab_channels`, `collab_messages`, notifications, reactions, reads, typing (`collaboration_system_update.sql`).
- 2026-05-25 — Extended chat profile fields + message edit/delete metadata (`collaboration_profile_chat_update.sql`).
- 2026-05-25 — `app_user_roles` RBAC + admin profile enrichment (`user_info_rbac_update.sql`).
- 2026-05-25 — Admin customization: `app_settings`, `admin_customization_activity`, `questions.custom_fields` (`admin_customization_system_update.sql`).
