# Change Log — Release 2026.05.30

## Summary

This release implements all 22 sub-issues from the May 2026 review batch (#1 through #5). It addresses image upload reliability, silent form persistence, the load-spinner-stuck-forever problem on All Questions and Review, header navigation cleanup, profile picture support, and the broken admin announcement notifications.

---

## Database changes — apply `0003_attachments_and_channels.sql`

A new SQL migration is included at `supabase/migrations/0003_attachments_and_channels.sql`. It must be applied before the new frontend goes live. The migration:

1. Adds `attachments jsonb` column to `questions` (default `[]`).
2. Back-fills existing rows: extracts `[Attachment: name](url)` markdown tokens out of `question` text, into the new `attachments` column. Strips the tokens from the question text. Existing answer/comment text is untouched.
3. Seeds the two required default channels: `admin-announcement` and `general` (idempotent via `ON CONFLICT (slug) DO NOTHING`).
4. Replaces the `collab_messages_insert_visible` RLS policy to enforce that only admins can post to `#admin-announcement`. All other channels keep their previous behaviour.
5. Creates the `profile-pictures` storage bucket (public, 2 MB max, JPG/PNG/WEBP only) and adds RLS policies so users can manage their own folder (`{user_id}/`) and everyone can read public photos.

**Deployment steps:**
1. Run `0003_attachments_and_channels.sql` against the Supabase project.
2. Verify the `profile-pictures` bucket exists in Storage settings (the migration creates it, but if Supabase's storage schema differs, you can also create it manually via the dashboard: name `profile-pictures`, public, 2 MB limit, MIME types `image/jpeg, image/png, image/webp`).
3. Deploy the new `public/index.html` to Netlify.

---

## Frontend changes — `public/index.html`

All edits are in-place in the single `index.html` file. No new frontend files. No bundler step required.

### Issue 1 — Submit Question page

- **1A** Upload no longer silently fails on first attempt. Upload button now shows `Processing… / Uploading…` states; one silent retry occurs on first-attempt failure to cover Supabase Storage cold-start / first-token race.
- **1B** Silent form persistence — Bill ID, question text, and issue field are auto-saved to `localStorage` on every keystroke. Restored automatically after page refresh, tab close, or upload failure. No visible UI, no draft banner, no save button. 7-day expiry. Cleared on successful submit and on Clear button. Also saved on `beforeunload` and `visibilitychange` as a safety net.
- **1C** Images are resized to max 1280px wide at JPEG quality 0.80 before upload. Skips SVG and files already under 200 KB. Falls back to original file on compression failure.
- **1D** Image preview now appears instantly via `URL.createObjectURL` — no waiting for upload to complete before seeing the image.
- **1E** Preview moved to a dedicated container ABOVE the textarea, with a larger image display (up to 280px tall) and a visible Remove button on each item. The small thumbnail chip strip is hidden on the Submit page.
- **1F** Attachments are now stored in a dedicated `questions.attachments` JSONB column, decoupled from the question text. The textarea value stays clean — users never see raw Supabase URLs in the question box. Submit, Bulk Submit, the review modal, and the table cells all updated. Legacy rows with embedded `[Attachment:](url)` tokens still render correctly via the existing enhancement pipeline; the migration back-fills the new column for them.

### Issue 2 — Header & Profile

- **2A** "Ctrl K" text removed from the nav. Search icon and Ctrl+K keyboard shortcut both still work.
- **2B** Standalone "Profile" button removed. Clicking the user name or avatar opens profile settings.
- **2C** Nav shows the user's custom username instead of Google full name. While the collab profile loads (~1–2 seconds after login), the nav-name shows nothing (avatar/initials remain visible) — no flash of the full name.
- **2D** New users get `custom_username` seeded with their full name on first login (or with email prefix if full name is missing). Existing user's chosen username is never overwritten.
- **2E** Profile picture upload added to the profile settings modal. JPG/PNG/WEBP, max 2 MB, auto-cropped to a 256×256 square at JPEG quality 0.88. Photo appears in:
  - Nav avatar (replaces initials)
  - Team Chat message author avatars
  - @mention dropdown suggestions
  - Profile modal preview
  Remove button restores initials avatar. Profile modal also restructured: Username is now the primary editable field; Full Name is shown read-only with a "(from Google)" label.

### Issue 3 + Issue 4 — Page loading

- **3A / 4A** All Questions and Review pages no longer get stuck on "Loading questions…" on first visit. Added: in-flight guard (prevents concurrent re-loads), init-settled wait (defers data fetch by up to 3 seconds while init queries finish, showing "Connecting…"), 15-second timeout with a Retry button.
- **3B / 4B** Image flash during loading eliminated. The MutationObserver in `attachmentRenderingFix` now only scans the currently active page's elements, not the whole document. Stale `.td-q` cells in inactive pages no longer trigger spurious image renders during page transitions.
- **4C** Non-admin reviewers no longer silently redirected away from the Review page during permissions load. `canAccessRoute('review')` is now optimistic until `reviewersLoaded === true`. After permissions resolve, unauthorised users see an explicit "Access Denied" panel inside the page rather than being bounced to Submit.

### Issue 5 — Notifications & Admin Announcements

- **5A-1** "Question answered" notification click now uses Bill ID as the primary search key (Q-number as fallback). Bill ID is the user-facing identifier and matches what's shown in the Answered page.
- **5A-2** Answered page search now indexes `question_id` (Q-numbers) in addition to Bill ID, question text, answer text, submitter name, and issue field. Both `123456789` and `Q-072` find the right answer.
- **5B-1 / 5B-2** Admin announcements now post a real message to the `#admin-announcement` channel AND create notifications with the correct `link_type: 'channel'` and `link_ref: <channel_id>`. Clicking the notification deep-links straight to `#admin-announcement` in Team Chat. The announcement text is permanently visible in the channel — no more invisible notification-only messages.
- **5B-3** The two required default channels (`admin-announcement` and `general`) are auto-created for new deployments via `ensureDefaultChannels()` and seeded for existing deployments via migration 0003. `#admin-announcement` is read-only for non-admin users — the message composer is hidden and replaced with a "📢 This channel is read-only. Only admins can post announcements. Discuss in #general." notice. RLS enforces this at the database level as well.

---

## Files modified

- `public/index.html` — all 22 frontend fixes
- `supabase/migrations/0003_attachments_and_channels.sql` — new file (database changes)

No other files in the project were modified.

---

## Compatibility notes

- **Existing announcement notifications** (pre-fix, with `link_type: 'collab'`, `link_ref: null`) will still do nothing when clicked. They are already read, so this is acceptable per the pre-implementation approval.
- **Legacy attachment tokens** in questions submitted before migration 0003 are automatically extracted into the new `attachments` column by the migration. If the migration's regex extraction encounters edge cases (unusual filenames with `]` or `)` characters), those rows keep the legacy inline rendering as a fallback.
- **No existing user data is destroyed.** `custom_username` is only seeded when null; user-chosen usernames are preserved.
- **No auth flow changes.** Google OAuth, session management, and the `sb.auth.onAuthStateChange` flow are untouched.

---

## Testing checklist

See the pre-implementation plan for the full testing checklist. Critical verifications post-deploy:

1. Apply migration 0003 in a non-production Supabase project first; verify back-fill ran correctly with `SELECT id, task_id, length(question), jsonb_array_length(attachments) FROM questions WHERE jsonb_array_length(attachments) > 0 LIMIT 10;`
2. Verify both `admin-announcement` and `general` channels appear in the channel list after first page load.
3. Submit a question with an attached image; confirm the image renders in the review modal as a separate thumbnail, not inline in the question text.
4. Click on All Questions tab from Submit page on first load — should display data within a few seconds without needing a manual refresh.
5. As a non-admin user, attempt to post in `#admin-announcement` — composer should be hidden with a read-only notice. RLS should also block any direct insert attempts.
