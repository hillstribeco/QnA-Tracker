# Production Refactor Summary

This package contains a production-hardening refactor across stability, performance, UX, security, and architecture.

## Stability

- Moved JavaScript out of the 10k-line `index.html` into load-ordered files under `public/js/`.
- Added centralized Supabase retry handling for transient network/API failures.
- Added browser-level `error` and `unhandledrejection` handling with user-facing toast feedback.
- Preserved existing route/auth behavior while making reviewer role loading resilient across `app_user_roles` and the legacy `reviewers` table.

## Performance

- Removed eager Chart.js and SheetJS loading from the initial page load.
- Added lazy loading for Chart.js and XLSX only when analytics/import/export features need them.
- Replaced broad `select('*')` calls with explicit field lists for questions, comments, settings, activity, roles, collaboration data, and profile data.
- Added `AppAPI.PAGE_SIZE` and caps on large dashboard fetches to avoid unbounded reads.
- Kept the global search cache with a short TTL and explicit field selection.
- Added database indexes for active questions, answered questions, comments, chat messages, notifications, and duplicate bill checks.

## UI/UX

- Added reusable UI helpers in `public/js/ui.js`.
- Added improved skeleton loader styling.
- Improved mobile navigation, filters, cards, modals, and toast layout.
- Added focus-visible states for better keyboard accessibility.

## Security

- Added server-side validation triggers for questions and threaded comments.
- Added a new Supabase hardening migration: `supabase/migrations/0004_production_performance_security.sql`.
- Tightened legacy reviewer visibility so non-admins can only verify their own reviewer row while admins manage all reviewers.
- Preserved anon-key-only frontend usage; no service role key is present in frontend code.

## Architecture

New frontend modules:

- `public/js/api.js` — Supabase client creation, retry handling, shared field lists, lazy library loading, debounce helper.
- `public/js/ui.js` — skeleton/empty/busy UI helpers.
- `public/js/auth.js` — shared email normalization and validation helpers.
- `public/js/app.js` — extracted application logic from the original inline scripts.

## Verification

Run:

```bash
npm run check:js
python3 scripts/project_audit.py
```

The refactor was checked with Node syntax validation for every frontend module.
