# Project Audit — Q&A Management App

Generated from the uploaded project ZIP on 2026-05-26.

## Executive summary

This is a solid first internal-tool prototype. The current stack is suitable for an office Q&A, reviewer workflow, team chat, and admin dashboard. The project does **not** need a traditional backend server today. The main production risks are maintainability, frontend size, role consistency, and a few missing/loose database pieces.

## What I found in the uploaded ZIP

| Area | Current state | Risk level | Recommendation |
|---|---|---:|---|
| Frontend | One `index.html` file, about 8,600 lines / 518 KB | Medium | Keep it working now, then split into modules in phases. |
| Database | One large `00_baseline.sql`, about 950 lines | Medium | Treat it as migration `0000_baseline.sql`; put every future DB change in numbered migrations. |
| Migrations | Folder exists but has no real migration files | Medium | Use `supabase/migrations/0000_...`, `0001_...`, etc. |
| Documentation | Good existing docs are present | Low | Keep docs, but add a production checklist and a beginner runbook. |
| Netlify config | No `netlify.toml` found | Low | Add one so deploy settings are version controlled. |
| Privacy page | README links to `privacy.html`, but file was missing | Medium | Added `public/privacy.html`. |
| HTML validity | Last script block was missing `</script>` before the footer | High | Fixed in the reorganized package. |
| Roles | Frontend uses `user` / `reviewer_admin`; SQL allows `staff` / `reviewer` / `admin` / `primary_admin` | High | Normalize frontend roles to database roles. Added compatibility patch. |
| Missing table | Frontend writes to `admin_activity_log`; baseline SQL did not create it | High | Added migration `0001_production_hardening.sql`. |
| Attachments | Updated to Supabase Storage-backed uploads via `qna-attachments`; text fields now store URLs instead of base64 blobs | Low/Medium | Keep the bucket migration applied in every environment and monitor Storage usage. |
| Security | RLS is enabled and mostly well structured | Medium | Tighten notification insert policy and add headers. |

## Important production fixes included in this package

1. Fixed the missing closing `</script>` near the footer in `public/index.html`.
2. Replaced the hardcoded V2 admin email with the configured `PRIMARY_ADMIN_EMAIL` fallback.
3. Added a frontend role compatibility patch so UI roles match the database constraints.
4. Added `supabase/migrations/0001_production_hardening.sql`.
5. Added a missing `public/privacy.html` page.
6. Added `netlify.toml` with safe headers.

## Do not do these yet

- Do not rewrite the whole frontend into React immediately.
- Do not add a Node/Python backend just because the project feels large.
- Do not remove the existing single HTML file until the app is tested after each small split.
- Do not store Supabase `service_role` keys in frontend code.

## Highest priority next steps

1. Deploy this reorganized version to a staging Netlify site.
2. Run `0001_production_hardening.sql` in Supabase SQL Editor.
3. Run `0002_attachments_storage.sql`, then confirm login, question submit, attachment upload/preview, answer save, admin user update, team chat, and notifications.
4. Only after that, start frontend cleanup.
