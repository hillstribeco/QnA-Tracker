# Beginner Runbook — How to Maintain This App

## Daily / weekly

- Check whether staff can submit questions.
- Check whether reviewers can answer questions.
- Check whether chat and notifications are working.
- Archive old questions rather than deleting them.

## When changing the database

1. Make a new SQL file in `supabase/migrations/`.
2. Use the next number, for example `0002_add_storage.sql`.
3. Test it on a copy/staging Supabase project.
4. Run it in production only after testing.
5. Write what changed in `CHANGELOG.md`.

## When changing the frontend

1. Change one thing at a time.
2. Test login, submit, answer, admin, and chat after each change.
3. Commit to Git before making another change.
4. Deploy to staging first for bigger changes.

## Emergency rollback

- Netlify: open Deploys and publish the previous working deploy.
- Supabase: avoid destructive migrations; restore from backup if data was changed incorrectly.
- Frontend: revert the last Git commit and redeploy.
