# Refactor Roadmap

This roadmap avoids a risky full rewrite. The goal is to keep the app working while making it easier to maintain.

## Phase 1 — Stabilize production

- Use the reorganized folder structure.
- Run `0001_production_hardening.sql`.
- Test the main workflows.
- Keep Supabase + Netlify.

## Phase 2 — Clean database ownership

- Make `app_user_roles` the only source of role truth.
- Keep `reviewers` only temporarily for old code compatibility.
- Later, remove frontend dependency on `reviewers`.
- Add Supabase Storage for attachments.

## Phase 3 — Split frontend safely

Start with the least risky pieces:

1. Move CSS into `assets/css/app.css`.
2. Move helper functions into `assets/js/utils.js`.
3. Move Supabase setup into `assets/js/supabase-client.js`.
4. Move Q&A functions into `assets/js/qa.js`.
5. Move team chat functions into `assets/js/chat.js`.
6. Move admin dashboard functions into `assets/js/admin.js`.

Do not change the logic while moving code. First move, then test, then improve.

## Phase 4 — Improve performance

- Stop loading all questions into the browser for every page.
- Add paginated queries: load 50 or 100 rows at a time.
- Use database search or views instead of filtering everything client-side.
- Keep indexes aligned with real queries.

## Phase 5 — Optional framework later

A framework like React/Vite can help once the app grows, but it is not urgent. Only consider it after the app is stable and the single HTML file has become too hard to maintain.
