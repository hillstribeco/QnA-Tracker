# Q&A Management App

Internal office web app for:

- staff question submission,
- reviewer/admin Q&A management,
- searchable answers,
- team chat,
- notifications,
- admin user management and analytics.

## Recommended stack

Keep using:

- Supabase for database, authentication, Row Level Security, realtime, and future storage/functions.
- Netlify for static hosting and deploys.
- Google OAuth for sign-in.

You do not need a separate Node.js/Python/PHP backend right now.

## Project layout

```text
public/                 Netlify publishes this folder
supabase/migrations/    Database setup and production fixes
docs/                   Beginner-friendly documentation
scripts/                Optional helper scripts
netlify.toml            Netlify deploy settings
```

## Setup

1. In Supabase SQL Editor, run `supabase/migrations/0000_baseline.sql` for a fresh project.
2. Then run `supabase/migrations/0001_production_hardening.sql`.
3. Then run `supabase/migrations/0002_attachments_storage.sql` to create the Storage bucket used by image/file uploads.
4. Check `public/config.js` has the correct Supabase URL, anon key, and primary admin email.
5. Deploy this repository to Netlify with publish directory `public`.
6. Test image upload/preview in Submit Question, reviewer Answer, Follow-ups, and Team Chat.

## Important docs

- `docs/PROJECT_AUDIT.md`
- `docs/FOLDER_STRUCTURE.md`
- `docs/REFACTOR_ROADMAP.md`
- `docs/PRODUCTION_CHECKLIST.md`
- `docs/BEGINNER_RUNBOOK.md`
