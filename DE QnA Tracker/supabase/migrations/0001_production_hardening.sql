-- 0001_production_hardening.sql
-- Purpose: safe production fixes found during the project audit.
-- Run this after 0000_baseline.sql, or run it alone if your existing Supabase project
-- already has the baseline tables.

begin;

-- 1) Frontend references admin_activity_log, but the original baseline did not create it.
create table if not exists public.admin_activity_log (
  id           uuid primary key default gen_random_uuid(),
  actor_email  text,
  action       text not null,
  entity_type  text,
  entity_id    text,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists idx_admin_activity_log_created on public.admin_activity_log(created_at desc);
create index if not exists idx_admin_activity_log_actor   on public.admin_activity_log(lower(actor_email));
create index if not exists idx_admin_activity_log_action  on public.admin_activity_log(action);

alter table public.admin_activity_log enable row level security;

drop policy if exists admin_activity_log_admin_read on public.admin_activity_log;
drop policy if exists admin_activity_log_admin_insert on public.admin_activity_log;

create policy admin_activity_log_admin_read on public.admin_activity_log
  for select to authenticated using (public.is_admin());

create policy admin_activity_log_admin_insert on public.admin_activity_log
  for insert to authenticated
  with check (
    public.is_admin()
    and (actor_email is null or lower(actor_email) = public.current_user_email())
  );

-- 2) Keep role values database-compatible. The frontend now maps "User" to staff
--    and "Reviewer Admin" to admin, but this also repairs any old rows if present.
alter table public.app_user_roles drop constraint if exists app_user_roles_role_check;
update public.app_user_roles set role = 'staff' where role in ('user','member');
update public.app_user_roles set role = 'admin' where role in ('reviewer_admin','revieweradmin','administrator');
alter table public.app_user_roles
  add constraint app_user_roles_role_check
  check (role in ('staff','reviewer','admin','primary_admin'));

alter table public.collab_profiles drop constraint if exists collab_profiles_role_check;
update public.collab_profiles set role = 'staff' where role in ('user','member');
update public.collab_profiles set role = 'admin' where role in ('reviewer_admin','revieweradmin','administrator');
alter table public.collab_profiles
  add constraint collab_profiles_role_check
  check (role in ('staff','reviewer','admin','primary_admin'));

-- 3) Tighten notification inserts. Authenticated users should not be able to create
--    notifications pretending to be another actor.
drop policy if exists collab_notifications_insert_authenticated on public.collab_notifications;
create policy collab_notifications_insert_authenticated on public.collab_notifications
  for insert to authenticated
  with check (
    recipient_email is not null
    and type is not null
    and (actor_email is null or lower(actor_email) = public.current_user_email() or public.is_admin())
  );

-- 4) Hide archived channels from normal users at the database policy level.
drop policy if exists collab_channels_select_visible on public.collab_channels;
create policy collab_channels_select_visible on public.collab_channels
  for select to authenticated
  using (
    (coalesce(is_archived, false) = false or public.is_admin())
    and (visibility = 'public' or public.can_access_collab_channel(id))
  );

-- 5) Add practical partial indexes for the most common production screens.
create index if not exists idx_questions_active_status_due
  on public.questions(status, due_at)
  where coalesce(is_archived, false) = false;

create index if not exists idx_questions_active_issue_submitted
  on public.questions(issue_field, submitted_at desc)
  where coalesce(is_archived, false) = false;

create index if not exists idx_collab_messages_channel_created_desc
  on public.collab_messages(channel_id, created_at desc)
  where deleted_at is null;

create index if not exists idx_collab_notifications_unread_created
  on public.collab_notifications(recipient_email, is_read, created_at desc);

commit;
