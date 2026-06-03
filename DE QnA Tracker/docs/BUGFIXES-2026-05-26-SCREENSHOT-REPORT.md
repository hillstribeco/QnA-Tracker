# Screenshot Report Bug Fixes — 2026-05-26

This note documents the debugging pass based on `Bug report and screenshot.docx`.

## Fixed issues

1. **Reviewer answer action**
   - Added an inline `Answer` button directly under the reviewer answer textarea.
   - It calls the existing `saveAnswer()` workflow, so validation, status changes, answer metadata, notifications, local refresh, and activity logging continue to use the existing code path.

2. **Answered image previews/opening**
   - Rich text rendering now recognizes `[Attachment: name](url)` across Answered question text, answer previews, detail boxes, follow-up comments, notifications, and Team Chat messages.
   - Image attachments render as previews and open in a new browser tab when clicked.
   - Legacy raw `data:image/...` strings are also rendered as image previews when encountered.

3. **Reviewer/user image upload corruption**
   - Uploads no longer use `FileReader.readAsDataURL()` for saved content.
   - Files are uploaded to the Supabase Storage bucket `qna-attachments`. Only the public Storage URL is inserted into the existing textarea before saving.
   - Follow-up/comment length was increased from 500 to 2,000 characters so a normal reply plus one or more Storage-backed attachment links does not fail validation.

4. **Team Chat image uploads**
   - Team Chat uses the same Storage-backed upload flow and rich renderer as questions, answers, and follow-ups.
   - Main messages, thread replies, message edits, admin announcements, and bulk-submitted questions now flush pending attachments before save.
   - Clipboard image paste and drag/drop are routed through the upload flow instead of letting base64/file text land in the message body.
   - Pending attachment state is cleared when forms/replies/modals are cancelled so files do not accidentally attach to a later message.

5. **Pasted/clickable links**
   - Pasted `http://`, `https://`, `mailto:`, and bare-domain links such as `google.com` are rendered as clickable links.
   - Explicit `[Link: label](url)` attachments remain clickable.

6. **Aggressive capitalization**
   - The old forced sentence capitalization hook is now a no-op.
   - Browser `autocapitalize` is set to `none` for text/search inputs and textareas managed by the app.

7. **Dark mode contrast**
   - Added contrast overrides for privacy copy, cards, placeholders, comments, Team Chat messages, FAQ text, tables, modals, notification panels, attachment chips, and link chips.
   - The standalone `privacy.html` now respects system dark mode.

## Required database migration

Run this migration once in Supabase SQL Editor or through the Supabase CLI:

```text
supabase/migrations/0002_attachments_storage.sql
```

It creates the public `qna-attachments` bucket and Storage policies allowing authenticated users to upload/update/delete files under their own auth-user folder while everyone can read the public attachment URLs.

## Files changed

- `public/index.html` — UI behavior, upload flow, rich rendering, link handling, capitalization, and dark-mode overrides
- `public/privacy.html` — standalone privacy-page dark-mode/readability updates
- `supabase/migrations/0002_attachments_storage.sql`
- `README.md`
- `CHANGELOG.md`
- `docs/DEPLOYMENT.md`
- `docs/BUGFIXES-2026-05-26-SCREENSHOT-REPORT.md`

## Additional QA hardening

- The reviewer modal's real `openModal()` function is now wrapped after render so the Answer textarea receives Upload/Link/Emoji tools immediately, not only after the user focuses the textarea.
- Bare-domain linkification now avoids treating plain file names such as `Screenshot 2025-08-31 110438.png` as web domains. True image previews require the Storage URL created by the upload flow.
