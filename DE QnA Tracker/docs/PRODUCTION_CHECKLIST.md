# Production Deployment Checklist

## Before deploying

- [ ] Confirm `public/config.js` points to the correct Supabase project.
- [ ] Confirm Google OAuth redirect URLs include the Netlify production URL.
- [ ] Run `supabase/migrations/0000_baseline.sql` on a fresh project, or skip it if already installed.
- [ ] Run `supabase/migrations/0001_production_hardening.sql`.
- [ ] Confirm the primary admin can sign in.
- [ ] Confirm no `service_role` key exists in any frontend file.

## Test these workflows

- [ ] Staff login with Google.
- [ ] Submit one question.
- [ ] Upload a small image attachment and confirm it displays.
- [ ] Reviewer answers the question.
- [ ] FAQ/search page shows the answer.
- [ ] Admin can add/update roles.
- [ ] Team Chat creates a channel and sends a message.
- [ ] Mentions create notifications.
- [ ] Export CSV works.

## Netlify setup

- [ ] Connect the Git repository to Netlify.
- [ ] Set publish directory to `public`.
- [ ] Keep build command empty unless you later add a build step.
- [ ] Enable deploy previews for pull requests if available.
- [ ] Use a staging site before production for major changes.

## After deploying

- [ ] Save a database backup/export.
- [ ] Add the production URL to Supabase Auth redirect settings.
- [ ] Test login on the real production URL.
- [ ] Ask one staff user and one reviewer to test normal workflows.
