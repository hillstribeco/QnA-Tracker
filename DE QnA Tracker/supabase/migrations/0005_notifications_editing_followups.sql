-- Production-ready v1.5: notification coverage, edit indicators, and follow-up resolution sync

alter table public.questions
  add column if not exists question_edited_at timestamptz,
  add column if not exists question_edited_by text,
  add column if not exists answer_edited_at timestamptz,
  add column if not exists answer_edited_by text;

-- Allow the expanded notification event taxonomy used by the frontend.
alter table public.collab_notifications drop constraint if exists collab_notifications_type_check;
alter table public.collab_notifications add constraint collab_notifications_type_check check (type in (
  'QUESTION_ANSWERED',
  'ANSWER_EDITED',
  'QUESTION_EDITED',
  'USER_TAGGED',
  'REVIEW_ASSIGNED',
  'REVIEWER_ACTION',
  'STATUS_UPDATED',
  'COMMENT_ADDED',
  'COMMENT_REPLIED',
  'FOLLOWUP_RESOLVED',
  'ADMIN_ANNOUNCEMENT'
));

create index if not exists idx_questions_submitter_updated
  on public.questions (submitter_email, question_edited_at desc);

create index if not exists idx_questions_answer_edited
  on public.questions (answer_edited_at desc)
  where answer_edited_at is not null;

-- Let reviewers/admins resolve staff follow-ups when they reply from any entry point.
-- Existing owner-edit policy still protects text edits; this policy is only for authenticated reviewer/admin roles.
drop policy if exists comments_resolve_by_reviewers on public.question_comments;
create policy comments_resolve_by_reviewers on public.question_comments
  for update using (
    exists (
      select 1 from public.app_user_roles r
      where lower(r.email) = lower(auth.email())
        and r.role in ('reviewer','admin','primary_admin','reviewer_admin')
    )
  )
  with check (
    exists (
      select 1 from public.app_user_roles r
      where lower(r.email) = lower(auth.email())
        and r.role in ('reviewer','admin','primary_admin','reviewer_admin')
    )
  );
