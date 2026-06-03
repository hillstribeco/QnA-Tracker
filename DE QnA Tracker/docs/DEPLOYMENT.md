# Deployment Guide

This is the start-to-finish guide for getting the app running on the public internet.

You'll do this **once**. After that, every change just needs a `git push` and Netlify deploys it automatically.

---

## What you'll need

- A **GitHub** account (free) — [github.com](https://github.com)
- A **Netlify** account (free) — [netlify.com](https://netlify.com)
- A **Supabase** account (free) — [supabase.com](https://supabase.com)
- A **Google Cloud** account (free) — [console.cloud.google.com](https://console.cloud.google.com)

Total cost so far: **$0 / month** for typical office usage.

---

## Step 1 — Create the Supabase project

1. Sign in at [supabase.com](https://supabase.com) → **New project**.
2. Pick a name (e.g. `qa-app`), set a strong database password (save it somewhere safe), pick a region close to your users (Frankfurt or Stockholm for Europe; Singapore for Asia).
3. Wait ~2 minutes for the project to provision.
4. Go to **SQL Editor** → **New query** → paste the **entire contents** of `supabase/migrations/0000_baseline.sql` → click **Run**.
5. Run `supabase/migrations/0001_production_hardening.sql`.
6. Run `supabase/migrations/0002_attachments_storage.sql`. This creates the public `qna-attachments` Storage bucket used by image/file uploads.
7. Confirm: go to **Table Editor** in the left sidebar — you should see the app tables. In **Storage**, confirm the `qna-attachments` bucket exists.
8. Go to **Settings** → **API**:
   - Copy the **Project URL** (looks like `https://xxxxxxxxxxxxx.supabase.co`).
   - Copy the **anon / public key** (a long string starting with `sb_publishable_...` or `eyJ...`).
   - Save these — you'll paste them into the frontend in Step 4.

---

## Step 2 — Set up Google OAuth

This lets staff sign in with their company Google accounts.

### 2a. Get OAuth credentials from Google

1. Go to [console.cloud.google.com](https://console.cloud.google.com).
2. Create a new project (or pick an existing one).
3. Search **"OAuth consent screen"** → configure it. For an internal-only app, choose **Internal** if you have a Google Workspace; otherwise **External** with test users.
4. Search **"Credentials"** → **Create Credentials** → **OAuth client ID**.
5. Application type: **Web application**.
6. Authorized redirect URIs: paste this exact URL (replace `xxx` with your Supabase project ref):
   ```
   https://xxxxxxxxxxxxx.supabase.co/auth/v1/callback
   ```
   You'll find this URL in Supabase under **Authentication → Providers → Google → Callback URL**.
7. Click **Create**. Copy the **Client ID** and **Client Secret**.

### 2b. Connect Google to Supabase

1. In Supabase: **Authentication** → **Providers** → click **Google**.
2. Toggle **Enable**.
3. Paste in **Client ID** and **Client Secret** from Step 2a.
4. Click **Save**.

---

## Step 3 — Put the code on GitHub

1. Create a new **private** repo on GitHub (e.g. `qa-management-app`).
2. On your computer, in the project folder:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin git@github.com:YOUR_USERNAME/qa-management-app.git
   git push -u origin main
   ```

> **Don't commit secrets!** Make sure `public/config.js` is either using *only* the Supabase public anon key (safe to commit), or is replaced at deploy time. See [`SECURITY.md`](SECURITY.md) for details.

---

## Step 4 — Wire up the frontend credentials

Open `public/config.js` and paste in the values from Step 1:

```javascript
window.APP_CONFIG = {
  SUPABASE_URL: 'https://xxxxxxxxxxxxx.supabase.co',   // ← from Supabase Settings → API
  SUPABASE_ANON_KEY: 'eyJhbGciOi...',                  // ← anon / public key, NOT service_role
  PRIMARY_ADMIN_EMAIL: 'hillstribeco@gmail.com'
};
```

The **anon key is safe to expose in browser code** — Supabase is designed that way. The database is protected by Row Level Security, not by the key itself. **Never** commit the `service_role` key.

---

## Step 5 — Deploy to Netlify

1. Sign in at [netlify.com](https://netlify.com) → **Add new site** → **Import from Git**.
2. Pick your `qa-management-app` repo.
3. Build settings:
   - **Build command:** *(leave blank)* — there's no build step.
   - **Publish directory:** `public`
4. Click **Deploy site**.
5. Wait ~30 seconds. Netlify gives you a random URL like `https://wonderful-quokka-12345.netlify.app`.
6. (Optional) **Site settings** → **Change site name** → pick a friendly one like `qa-hillstribe`.
7. (Optional) **Domain management** → add your own custom domain (e.g. `qa.hillstribetech.com`).

---

## Step 6 — Tell Supabase about your Netlify URL

So that Google OAuth knows it's allowed to redirect there.

1. In Supabase → **Authentication** → **URL Configuration**.
2. Set **Site URL** to your Netlify URL (e.g. `https://qa-hillstribe.netlify.app`).
3. Under **Redirect URLs**, add the same URL (and any custom domain you set up).
4. Click **Save**.

You may also need to add the Netlify URL to your Google OAuth client's "Authorized JavaScript origins" in the Google Cloud Console.

---

## Step 7 — Test it

1. Open your Netlify URL in an incognito window.
2. Click **Sign in with Google** → sign in with the email you set as `primary_admin` in `00_baseline.sql`.
3. You should land on the Review page (admins/reviewers see Review by default).
4. Submit a test question → check it appears in the dashboard.
5. Upload a small image in a question/follow-up/Team Chat message → confirm it shows a preview and opens when clicked.

---

## You're done

From now on:

- **Frontend changes:** edit, commit, push → Netlify auto-deploys after the deploy pipeline runs.
- **Database changes:** add a file to `supabase/migrations/` → run it once in Supabase SQL Editor.
- **New admins:** sign them in, then mark their `app_user_roles.role` as `admin` in Supabase Table Editor or via the in-app Admin Dashboard.

---

## Backups (do this!)

Supabase automatically backs up your database daily on the free tier, but **you should also export the schema yourself periodically**:

1. Supabase → **Database** → **Backups** — confirm daily backups are happening.
2. Once a month, go to **SQL Editor** → run:
   ```sql
   -- Quick "what's in my database" check
   select table_name from information_schema.tables
   where table_schema = 'public' order by table_name;
   ```
3. For a full export, use the Supabase CLI: `supabase db dump`.

---

## When usage grows

The free tier handles plenty of internal-office traffic — typically thousands of users and millions of rows. Watch for these signs that you need to upgrade:

| Signal                                                  | Plan needed                          |
|---------------------------------------------------------|--------------------------------------|
| Database > 500 MB                                       | Supabase Pro ($25/mo)                |
| > 50 GB egress / month                                  | Supabase Pro                         |
| Need point-in-time recovery                             | Supabase Pro                         |
| Need scheduled jobs (e.g. weekly digest emails)         | Supabase Pro (pg_cron) or Edge Functions |
| Custom domain on Netlify                                | Free (just add DNS)                  |
| > 100 GB bandwidth / mo on Netlify                      | Netlify Pro ($19/mo)                 |

For an internal office tool, **you will likely never hit any of these.** Plan to revisit once a year.
