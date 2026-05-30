# Changelog

A running log of meaningful changes. Add a new entry whenever you make a real change to schema, security, or behavior. Newest entries go at the top.

## 2026-05-27 — UI update (revision 2): hide page-intro heros + sticky admin tabs

Four page-intro removals plus an Admin tab-header sticky enhancement.
Added as a second additive patch block in `public/index.html` directly
below the revision-1 bug-fix patch, marked
`<!-- UI UPDATE PATCH — 2026-05-27 (revision 2) -->`. Removing that
block fully restores the previous look. The two patches are
independent — either can be reverted without affecting the other.

- **All Questions** — "All Questions" title and the "View all questions submitted by the team — read only." description are no longer rendered; the filter row sits directly under the nav.
- **Review** — the "Reviewer Dashboard" title and "Review incoming questions, add answers, and update statuses." description are removed; the reviewer alert / stats row is now the first thing visible.
- **Team Chat** — the dark hero with "Team Chat / Slack-style channels…" is removed; the channel sidebar + chat pane fill the page directly under the nav. (The flex layout from the rev-1 patch already handled the redistribution of vertical space — nothing else needed.)
- **Admin** — the "Operational Control Center" hero is removed; the admin tab bar is now the first thing visible.
- **Admin tab bar — sticky for real**. The base CSS had `position: sticky` but a weak, semi-transparent treatment; the new rule pins it under the nav with a solid surface, a 1-px bottom rule, and a soft drop shadow so it reads as a distinct layer above scrolling content. Dark theme has its own opaque override.
- **Mobile**: the admin tab strip switches from wrap-to-multiple-rows to a horizontal-scroll strip (Slack / Linear / Notion pattern). A small helper auto-scrolls the active tab into view after every `switchAdminTab()` call.

Implementation: CSS `display: none !important`, not markup deletion. The admin Customization tab still writes text into these heros via `applyAdminCustomization()` at runtime (Review title, All Questions subtitle, etc.); keeping the markup means those inputs continue to bind to live elements, so the customizer doesn't quietly break. Reverting the patch brings everything back.

See `docs/UI-UPDATE-2026-05-27-rev2.md` for full rationale, z-index notes, mobile behavior, and rollback instructions.

## 2026-05-27 — Interaction & scroll polish (Issues #1–#4)

Four reported interaction / scroll bugs fixed, plus a small audit pass of the surrounding flows. All changes are additive — a single `<style>` block and a single `<script>` block at the end of `public/index.html`, marked with `BUGFIX PATCH — 2026-05-27`. Delete that block to fully revert.

- **All Questions** — clicking an image, image link, or "▶ 📷 …" expand chevron no longer navigates to the Answered page. The click is now isolated to the image preview / expand.
- **Reviewer Dashboard** — clicking an image, expand chevron, or attachment link in a row no longer also opens the Reviewer Answer modal. Collapsing an open image no longer reopens the modal.
- **Team Chat** — laid out Slack-style. The page is exactly viewport-height; the channel sidebar scrolls independently; the message list scrolls independently; the channel header is sticky; the composer is pinned at the bottom; the page itself no longer scrolls. Mobile (≤900px) keeps the previous natural-flow layout.
- **Answered** — search bar widened to 880px and the inner clear-wrapper is now a flex child so the input fully fills its container. The "×" clear button (which already existed) now sits cleanly inside the pill on the right.
- **Targeted audit add-ons**: links and attachment chips inside the question cell of All Questions / Review tables now follow the link instead of triggering the row; the FAQ card's image chevron no longer collapses the card; the `<summary>` chevron now shows a hover state and a keyboard `:focus-visible` outline; the two Team Chat scroll panes get a consistent 8-px scrollbar (light + dark) and `overscroll-behavior: contain` so scrolling doesn't bounce the rest of the window.

See `docs/BUGFIXES-2026-05-27.md` for full root-cause analysis, the rationale for using bubble-phase per-element listeners (instead of a capture-phase document listener, which a previous fix had to remove), and rollback instructions.

## 2026-05-26 — Reported screenshot bug pass

Fixed the bugs reported in `Bug report and screenshot.docx`:

- Added an inline **Answer** action next to the reviewer answer editor that calls the existing save-answer workflow.
- Replaced base64 inline attachment storage with Supabase Storage uploads to the new `qna-attachments` bucket. The text fields now store short `[Attachment: name](https://...)` references instead of giant data URLs.
- Rendered image attachments as previews in Answered, Review modal follow-ups, and Team Chat, with click-to-open behavior; legacy raw `data:image/...` content is rendered as an image when possible.
- Kept pasted URLs and explicit link attachments clickable in Team Chat, Answers, and Follow-ups, including bare domains such as `google.com`, without turning plain image filenames into fake web links.
- Disabled forced text mutation/capitalization while keeping browser spellcheck available for likely-English text.
- Added dark-mode contrast overrides for the in-app Privacy page, standalone privacy page, comments, answers, cards, placeholders, tables, modals, notifications, and attachment/link chips.
- Increased follow-up/comment capacity to 2,000 characters so Storage-backed attachment links do not trip the old 500-character validation.

Schema/config addition: run `supabase/migrations/0002_attachments_storage.sql` before testing uploads in production.

## 2026-05-26 — Bug fixes (comment/attachment UI)

Three pre-existing bugs fixed (not caused by the restructuring):

- **Comment-form buttons (Reply, Clear, Upload, Link, Emoji) were unresponsive** on FAQ, Review, and Follow-up pages. Caused by a document-level capture-phase click listener calling `stopPropagation()` before the event reached the buttons. Removed the broken listener.
- **Attachment × remove button didn't react** until page refresh. Same root cause as above; fixed by the same change.
- **Uploaded images displayed as a long base64 text string** instead of inline images. Added a self-contained rendering patch that converts `[Attachment: name](url)` markdown into `<img>` or `<a>` elements. Also hardened against unsafe URL schemes (`javascript:`, etc.).

See `docs/BUGFIXES-2026-05-26.md` for full diagnosis, repro steps, and rollback instructions.

## 2026-05-26 — HTML cleanup

- Removed 30 duplicate function definitions from `index.html` (the V1 block was dead code overridden by V2 OVERRIDES). 761 lines / 33 KB removed.
- Extracted Supabase credentials from inline JavaScript into `public/config.js`.
- Added `<script src="config.js"></script>` include before the inline scripts.
- Renamed `index_production_refactored_qa_hardened.html` → `index.html`.
- All 75 unique helper functions from the V1 block preserved (still called by V2 code).
- Both inline script blocks pass Node.js syntax check.
- No HTML markup, CSS, or business logic was modified.
- See `docs/HTML-CLEANUP-NOTES.md` for the full diff.

## 2026-05-26 — Project restructuring

- Consolidated 9 scattered SQL files into a single baseline migration `supabase/migrations/0000_baseline.sql`.
- Added missing `app_reactions` table (was referenced by frontend but undefined in old SQL).
- Established `app_user_roles` as the canonical role store; kept `reviewers` for legacy compatibility.
- Centralized role-check helpers: `is_admin()`, `is_reviewer()`, `current_user_email()`.
- Created folder structure now maintained as `public/`, `supabase/migrations/`, `docs/`, and helper scripts.
- Wrote `README.md`, `ARCHITECTURE.md`, `DATABASE.md`, `DEPLOYMENT.md`, `SECURITY.md`, `MAINTENANCE.md`, `MIGRATION-GUIDE.md`.
- Extracted Supabase credentials into `public/config.js`.

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
