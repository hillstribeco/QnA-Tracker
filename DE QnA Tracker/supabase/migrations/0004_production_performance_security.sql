-- Production performance + security hardening
-- Safe to run repeatedly after the baseline migrations.

-- Fast common dashboard and filter paths.
create index if not exists idx_questions_active_submitted_at
  on public.questions (submitted_at desc)
  where coalesce(is_archived, false) = false;

create index if not exists idx_questions_status_answered_date
  on public.questions (status, answered_date desc)
  where coalesce(is_archived, false) = false;

create index if not exists idx_questions_task_submitter
  on public.questions (task_id, lower(submitter_email));

create index if not exists idx_question_comments_question_created
  on public.question_comments (question_id, created_at);

create index if not exists idx_collab_messages_channel_created
  on public.collab_messages (channel_id, created_at);

create index if not exists idx_collab_notifications_recipient_created
  on public.collab_notifications (recipient_email, created_at desc);

-- Basic server-side validation so malformed or oversized client input is rejected
-- even if a browser bypasses frontend checks.
create or replace function public.validate_question_row()
returns trigger
language plpgsql
as $$
begin
  new.submitter_email := lower(trim(coalesce(new.submitter_email, auth.email())));
  new.task_id := trim(coalesce(new.task_id, ''));
  new.question := trim(coalesce(new.question, ''));
  new.status := coalesce(nullif(trim(new.status), ''), 'Open');

  if new.submitter_email = '' or new.submitter_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'A valid submitter email is required';
  end if;

  if length(new.task_id) < 2 or length(new.task_id) > 80 then
    raise exception 'Bill ID must be 2-80 characters';
  end if;

  if length(new.question) < 10 or length(new.question) > 500 then
    raise exception 'Question must be 10-500 characters';
  end if;

  if new.answer is not null and length(new.answer) > 4000 then
    raise exception 'Answer must be 4000 characters or less';
  end if;

  if new.status not in ('Open','In Review','Answered','Closed') then
    raise exception 'Invalid question status';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_question_row_trigger on public.questions;
create trigger validate_question_row_trigger
  before insert or update on public.questions
  for each row execute function public.validate_question_row();

create or replace function public.validate_question_comment_row()
returns trigger
language plpgsql
as $$
begin
  new.user_email := lower(trim(coalesce(new.user_email, auth.email())));
  new.text := trim(coalesce(new.text, ''));

  if new.user_email = '' or new.user_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'A valid user email is required';
  end if;

  if length(new.text) < 5 or length(new.text) > 2000 then
    raise exception 'Comment must be 5-2000 characters';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_question_comment_row_trigger on public.question_comments;
create trigger validate_question_comment_row_trigger
  before insert or update on public.question_comments
  for each row execute function public.validate_question_comment_row();

-- Tighten the legacy reviewers table so users can only verify their own reviewer row; admins can read/manage all.
drop policy if exists read_reviewers on public.reviewers;
drop policy if exists read_reviewers_admin_only on public.reviewers;
drop policy if exists read_reviewers_self_or_admin on public.reviewers;
drop policy if exists admin_manage_reviewers on public.reviewers;

create policy read_reviewers_self_or_admin on public.reviewers
  for select to authenticated
  using (public.is_admin() or lower(email) = public.current_user_email());

create policy admin_manage_reviewers on public.reviewers
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Staff can read their own role; admins can read all roles.
drop policy if exists app_user_roles_select on public.app_user_roles;
create policy app_user_roles_select on public.app_user_roles
  for select to authenticated
  using (public.is_admin() or lower(email) = public.current_user_email());
