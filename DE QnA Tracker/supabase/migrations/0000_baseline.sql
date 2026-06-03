-- ════════════════════════════════════════════════════════════════════════════
-- HillsTribe Q&A Management App — Consolidated Database Baseline
-- ════════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS FILE IS:
--   This single file replaces all 9 of your previous .sql files. It contains
--   everything needed to set up a fresh Supabase project: tables, indexes,
--   security policies, helper functions, and seed data.
--
-- HOW TO USE IT:
--   1. Go to Supabase → SQL Editor → New Query
--   2. Paste this entire file
--   3. Click "Run"
--   4. Wait for "Success" — that's it. The database is ready.
--
-- SAFE TO RE-RUN:
--   Every statement uses IF NOT EXISTS / ON CONFLICT / DROP IF EXISTS, so
--   running this file again on an existing database will not break anything.
--   It is safe to use on both fresh and existing installs.
--
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 0 — Extensions
-- ────────────────────────────────────────────────────────────────────────────
create extension if not exists pgcrypto;


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 1 — ROLE-BASED ACCESS CONTROL (RBAC)
-- The single source of truth for who can do what in the app.
-- ════════════════════════════════════════════════════════════════════════════

-- One row per user, mapping email → role. This replaces the older `reviewers`
-- table as the canonical source of permissions, but `reviewers` is kept for
-- backwards compatibility with existing frontend code.
create table if not exists public.app_user_roles (
  email        text primary key,
  role         text not null default 'staff'
               check (role in ('staff','reviewer','admin','primary_admin')),
  assigned_by  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_app_user_roles_role on public.app_user_roles(role);

-- Seed the primary admin. Change this email to your real admin address.
insert into public.app_user_roles (email, role, assigned_by)
values ('hillstribeco@gmail.com', 'primary_admin', 'system')
on conflict (email) do update set role = excluded.role, updated_at = now();

-- Legacy reviewer table — still referenced by frontend code. New deployments
-- should rely on app_user_roles, but we keep this in sync via the seed below.
create table if not exists public.reviewers (
  email       text primary key,
  created_at  timestamptz default now(),
  created_by  text
);

insert into public.reviewers (email, created_by)
values ('hillstribeco@gmail.com', 'system')
on conflict (email) do nothing;


-- ────────────────────────────────────────────────────────────────────────────
-- 1a — RBAC Helper Functions
-- These centralize "who is allowed to do this?" logic so policies stay simple.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.current_user_email()
returns text language sql stable as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer
set search_path = public as $$
  select exists (
    select 1 from public.app_user_roles
    where lower(email) = public.current_user_email()
      and role in ('admin','primary_admin')
  )
$$;

create or replace function public.is_reviewer()
returns boolean language sql stable security definer
set search_path = public as $$
  select public.is_admin()
      or exists (
        select 1 from public.app_user_roles
        where lower(email) = public.current_user_email()
          and role = 'reviewer'
      )
      or exists (
        select 1 from public.reviewers
        where lower(email) = public.current_user_email()
      )
$$;

grant execute on function public.current_user_email() to authenticated;
grant execute on function public.is_admin()           to authenticated;
grant execute on function public.is_reviewer()        to authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 2 — Q&A SYSTEM (core feature)
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.questions (
  id               uuid primary key default gen_random_uuid(),
  question_id      text,                        -- auto-generated, e.g. Q-001
  submitted_at     timestamptz default now(),
  submitter_name   text,
  submitter_email  text,
  task_id          text not null,               -- "Bill ID" in UI
  question         text not null,
  issue_field      text default 'Vendor',       -- category: Vendor, Expense, etc.
  priority         text default 'Vendor',       -- legacy mirror of issue_field (kept for frontend compatibility)
  links            text,
  status           text default 'Open'
                   check (status in ('Open','In Review','Answered','Closed')),
  answer           text,
  remarks          text,
  answered_by      text,
  answered_date    timestamptz,
  due_at           timestamptz,                 -- SLA deadline
  is_archived      boolean default false,
  archived_at      timestamptz,
  archived_by      text,
  archive_reason   text,
  custom_fields    jsonb not null default '{}'::jsonb
);

-- Migration safety: add columns to older installs that may already exist.
alter table public.questions drop constraint if exists questions_priority_check;
alter table public.questions add column if not exists issue_field    text default 'Vendor';
alter table public.questions add column if not exists due_at         timestamptz;
alter table public.questions add column if not exists is_archived    boolean default false;
alter table public.questions add column if not exists archived_at    timestamptz;
alter table public.questions add column if not exists archived_by    text;
alter table public.questions add column if not exists archive_reason text;
alter table public.questions add column if not exists custom_fields  jsonb not null default '{}'::jsonb;

-- Auto-generated human-readable question IDs (Q-001, Q-002, …)
create sequence if not exists public.question_seq;

do $$
declare max_existing bigint;
begin
  select coalesce(max(regexp_replace(question_id, '\D', '', 'g')::bigint), 0)
  into max_existing
  from public.questions
  where question_id ~ '^Q-[0-9]+$';
  if max_existing > 0 then
    perform setval('public.question_seq', max_existing, true);
  end if;
end $$;

create or replace function public.set_question_id()
returns trigger language plpgsql as $$
begin
  if new.question_id is null or trim(new.question_id) = '' then
    new.question_id := 'Q-' || lpad(nextval('public.question_seq')::text, 3, '0');
  end if;
  return new;
end;
$$;

drop trigger if exists trigger_set_question_id on public.questions;
create trigger trigger_set_question_id
  before insert on public.questions
  for each row execute function public.set_question_id();


-- ────────────────────────────────────────────────────────────────────────────
-- 2a — Question Comments (threaded follow-ups)
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.question_comments (
  id                 uuid primary key default gen_random_uuid(),
  question_id        uuid references public.questions(id) on delete cascade,
  user_email         text not null,
  user_name          text not null,
  text               text not null,
  is_reviewer_reply  boolean default false,
  is_resolved        boolean default false,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now(),
  parent_comment_id  uuid references public.question_comments(id) on delete cascade
);


-- ────────────────────────────────────────────────────────────────────────────
-- 2b — Question View Tracking (so the dashboard can show "seen by X people")
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.question_views (
  id            uuid primary key default gen_random_uuid(),
  question_id   uuid not null references public.questions(id) on delete cascade,
  viewer_name   text,
  viewer_email  text not null,
  session_key   text not null,
  viewed_at     timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  constraint question_views_one_per_session unique (question_id, viewer_email, session_key)
);


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 3 — ADMIN CONFIGURATION
-- ════════════════════════════════════════════════════════════════════════════

-- Issue categories that admins can manage from the UI.
create table if not exists public.issue_fields (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  description  text,
  color_class  text default 'info'
               check (color_class in ('info','purple','pink','green','amber','red','muted')),
  sort_order   integer default 100,
  is_active    boolean default true,
  created_at   timestamptz default now(),
  created_by   text,
  updated_at   timestamptz default now(),
  updated_by   text
);

insert into public.issue_fields (name, description, color_class, sort_order, created_by) values
  ('Expense Type', 'Questions about choosing the correct expense type.', 'info',   10, 'system'),
  ('Vendor',       'Vendor matching, naming, and correction questions.', 'purple', 20, 'system'),
  ('Expense',      'Expense coding, details, or policy questions.',      'pink',   30, 'system'),
  ('Payment',      'Payment status, timing, or reconciliation questions.','green', 40, 'system')
on conflict (name) do nothing;

-- SLA configuration (single-row table — id is always 1).
create table if not exists public.sla_settings (
  id                integer primary key default 1 check (id = 1),
  response_days     integer not null default 2 check (response_days between 1 and 30),
  exclude_weekends  boolean not null default true,
  timezone          text not null default 'Asia/Kathmandu',
  updated_at        timestamptz default now(),
  updated_by        text
);

insert into public.sla_settings (id, response_days, exclude_weekends, timezone, updated_by)
values (1, 2, true, 'Asia/Kathmandu', 'system')
on conflict (id) do nothing;

-- Generic key/value store for admin customization (JSONB so it's flexible).
create table if not exists public.app_settings (
  key         text primary key,
  value       jsonb not null default '{}'::jsonb,
  updated_by  text,
  updated_at  timestamptz not null default now()
);

insert into public.app_settings (key, value, updated_by)
values ('admin_customization_v1', '{}'::jsonb, 'system')
on conflict (key) do nothing;


-- ────────────────────────────────────────────────────────────────────────────
-- 3a — SLA Working-Day Calculation + Default Value Triggers
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.add_working_days(start_at timestamptz, work_days integer)
returns timestamptz language plpgsql stable as $$
declare
  result_at   timestamptz := coalesce(start_at, now());
  added       integer := 0;
  target_days integer := greatest(coalesce(work_days, 2), 1);
begin
  while added < target_days loop
    result_at := result_at + interval '1 day';
    if extract(isodow from result_at) < 6 then  -- skip Saturday(6) and Sunday(7)
      added := added + 1;
    end if;
  end loop;
  return result_at;
end;
$$;

create or replace function public.set_question_defaults()
returns trigger language plpgsql as $$
declare target_days integer := 2;
begin
  select coalesce(response_days, 2) into target_days from public.sla_settings where id = 1;

  -- Keep priority and issue_field in sync (legacy frontend compatibility).
  new.issue_field := coalesce(nullif(new.issue_field, ''), nullif(new.priority, ''), 'Vendor');
  new.priority    := new.issue_field;
  new.is_archived := coalesce(new.is_archived, false);

  if new.due_at is null then
    new.due_at := public.add_working_days(coalesce(new.submitted_at, now()), target_days);
  end if;

  if new.status = 'Answered' and new.answer is not null and new.answered_date is null then
    new.answered_date := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trigger_set_question_defaults on public.questions;
create trigger trigger_set_question_defaults
  before insert or update on public.questions
  for each row execute function public.set_question_defaults();


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 4 — ACTIVITY LOGGING (audit trail)
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.activity_log (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz default now(),
  actor_email   text,
  actor_name    text,
  action        text not null,
  target_table  text,
  target_id     uuid,
  target_label  text,
  details       jsonb default '{}'::jsonb
);

create table if not exists public.admin_customization_activity (
  id                uuid primary key default gen_random_uuid(),
  actor_email       text,
  actor_name        text,
  action            text not null,
  reason            text,
  settings_snapshot jsonb,
  created_at        timestamptz not null default now()
);


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 5 — TEAM CHAT (Slack-style collaboration)
-- ════════════════════════════════════════════════════════════════════════════

-- User profiles for mentions, avatars, and user details pages.
create table if not exists public.collab_profiles (
  email                text primary key,
  username             text not null unique,
  display_name         text,
  role                 text not null default 'staff'
                       check (role in ('staff','reviewer','admin','primary_admin')),
  avatar_url           text,
  last_seen_at         timestamptz default now(),
  user_id              uuid default gen_random_uuid(),
  custom_username      text,
  employee_join_date   date,
  performance_score    numeric(5,2),
  phone                text,
  employee_id          text,
  address              text,
  department           text,
  profile_picture_url  text,
  bio                  text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Chat channels (rooms).
create table if not exists public.collab_channels (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  slug         text not null unique,
  description  text,
  visibility   text not null default 'public' check (visibility in ('public','private')),
  created_by   text not null,
  is_archived  boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Who is in which channel.
create table if not exists public.collab_channel_members (
  channel_id  uuid not null references public.collab_channels(id) on delete cascade,
  user_email  text not null,
  role        text not null default 'member' check (role in ('owner','admin','member')),
  joined_at   timestamptz not null default now(),
  primary key (channel_id, user_email)
);

-- Messages (with soft-delete + edit metadata).
create table if not exists public.collab_messages (
  id            uuid primary key default gen_random_uuid(),
  channel_id    uuid not null references public.collab_channels(id) on delete cascade,
  author_email  text not null,
  author_name   text,
  body          text not null check (char_length(body) <= 4000),
  mentions      text[] not null default '{}',
  edited_at     timestamptz,
  deleted_at    timestamptz,
  deleted_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Emoji reactions on messages.
create table if not exists public.collab_message_reactions (
  channel_id   uuid not null references public.collab_channels(id) on delete cascade,
  message_id   uuid not null references public.collab_messages(id) on delete cascade,
  user_email   text not null,
  emoji        text not null check (char_length(emoji) <= 16),
  created_at   timestamptz not null default now(),
  primary key (message_id, user_email, emoji)
);

-- Read receipts (last message each user has seen).
create table if not exists public.collab_message_reads (
  channel_id  uuid not null references public.collab_channels(id) on delete cascade,
  message_id  uuid not null references public.collab_messages(id) on delete cascade,
  user_email  text not null,
  seen_at     timestamptz not null default now(),
  primary key (message_id, user_email)
);

-- "User is typing…" indicators (rows auto-expire via expires_at).
create table if not exists public.collab_typing (
  channel_id  uuid not null references public.collab_channels(id) on delete cascade,
  user_email  text not null,
  user_name   text,
  expires_at  timestamptz not null,
  primary key (channel_id, user_email)
);

-- In-app notifications (mentions, answers, comments, etc.).
create table if not exists public.collab_notifications (
  id               uuid primary key default gen_random_uuid(),
  recipient_email  text not null,
  actor_email      text,
  actor_name       text,
  type             text not null check (type in (
                     'QUESTION_ANSWERED','USER_TAGGED','REVIEW_ASSIGNED',
                     'STATUS_UPDATED','COMMENT_ADDED','COMMENT_REPLIED',
                     'ADMIN_ANNOUNCEMENT')),
  title            text,
  body             text,
  link_type        text,
  link_ref         text,
  metadata         jsonb not null default '{}'::jsonb,
  is_read          boolean not null default false,
  read_at          timestamptz,
  created_at       timestamptz not null default now()
);


-- ────────────────────────────────────────────────────────────────────────────
-- 5a — Chat Helper Functions
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.can_access_collab_channel(channel_uuid uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.collab_channels c
    where c.id = channel_uuid
      and c.is_archived = false
      and (
        c.visibility = 'public'
        or lower(c.created_by) = public.current_user_email()
        or exists (
          select 1 from public.collab_channel_members m
          where m.channel_id = c.id and lower(m.user_email) = public.current_user_email()
        )
      )
  )
$$;

create or replace function public.can_manage_collab_channel(channel_uuid uuid)
returns boolean language sql stable as $$
  select public.is_admin()
    or exists (
      select 1 from public.collab_channels c
      where c.id = channel_uuid and lower(c.created_by) = public.current_user_email()
    )
    or exists (
      select 1 from public.collab_channel_members m
      where m.channel_id = channel_uuid
        and lower(m.user_email) = public.current_user_email()
        and m.role in ('owner','admin')
    )
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 6 — APP-WIDE REACTIONS
-- (Was referenced by frontend but missing from older SQL — added here.)
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.app_reactions (
  id           uuid primary key default gen_random_uuid(),
  target_type  text not null,           -- e.g. 'question', 'comment'
  target_id    text not null,           -- target's UUID or ID as text
  emoji        text not null check (char_length(emoji) <= 16),
  user_email   text not null,
  user_name    text,
  created_at   timestamptz not null default now(),
  unique (target_type, target_id, emoji, user_email)
);

create index if not exists idx_app_reactions_target on public.app_reactions(target_type, target_id);


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 7 — INDEXES (performance)
-- ════════════════════════════════════════════════════════════════════════════

-- Questions
create index if not exists idx_questions_archived         on public.questions(is_archived, archived_at desc);
create index if not exists idx_questions_status           on public.questions(status);
create index if not exists idx_questions_issue_field      on public.questions(issue_field);
create index if not exists idx_questions_due_at           on public.questions(due_at);
create index if not exists idx_questions_submitted_at     on public.questions(submitted_at desc);
create index if not exists idx_questions_task_id          on public.questions(task_id);
create index if not exists idx_questions_submitter_email  on public.questions(lower(submitter_email));
create index if not exists idx_questions_submitter_name   on public.questions(lower(submitter_name));
create index if not exists idx_questions_answered_date    on public.questions(answered_date desc);
create index if not exists idx_questions_search_text on public.questions using gin (
  to_tsvector('english',
    coalesce(question_id,'')     || ' ' || coalesce(task_id,'')        || ' ' ||
    coalesce(question,'')        || ' ' || coalesce(answer,'')         || ' ' ||
    coalesce(submitter_name,'')  || ' ' || coalesce(submitter_email,'')|| ' ' ||
    coalesce(issue_field,'')
  )
);

-- Comments
create index if not exists idx_comments_question   on public.question_comments(question_id);
create index if not exists idx_comments_parent     on public.question_comments(parent_comment_id);
create index if not exists idx_comments_created    on public.question_comments(created_at desc);
create index if not exists idx_comments_search_text on public.question_comments using gin (
  to_tsvector('english',
    coalesce(text,'') || ' ' || coalesce(user_name,'') || ' ' || coalesce(user_email,'')
  )
);

-- Views, fields, activity
create index if not exists idx_question_views_question_id on public.question_views(question_id);
create index if not exists idx_question_views_viewer      on public.question_views(viewer_email);
create index if not exists idx_question_views_viewed_at   on public.question_views(viewed_at desc);
create index if not exists idx_issue_fields_sort          on public.issue_fields(is_active, sort_order, name);
create index if not exists idx_activity_created           on public.activity_log(created_at desc);
create index if not exists idx_activity_action            on public.activity_log(action);

-- Collab/chat
create index if not exists idx_collab_profiles_username    on public.collab_profiles(lower(username));
create index if not exists idx_collab_profiles_role        on public.collab_profiles(role);
create index if not exists idx_collab_profiles_department  on public.collab_profiles(department);
create index if not exists idx_collab_profiles_user_id     on public.collab_profiles(user_id);
create index if not exists idx_collab_channels_visibility  on public.collab_channels(visibility, is_archived);
create index if not exists idx_collab_members_user         on public.collab_channel_members(user_email);
create index if not exists idx_collab_messages_channel_at  on public.collab_messages(channel_id, created_at);
create index if not exists idx_collab_messages_edited      on public.collab_messages(edited_at) where edited_at is not null;
create index if not exists idx_collab_messages_deleted     on public.collab_messages(deleted_at) where deleted_at is not null;
create index if not exists idx_collab_notif_recipient_at   on public.collab_notifications(recipient_email, created_at desc);
create index if not exists idx_collab_notif_unread         on public.collab_notifications(recipient_email, is_read) where is_read = false;


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 8 — ROW LEVEL SECURITY (RLS)
-- All tables have RLS turned ON. Policies are added below.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.app_user_roles                enable row level security;
alter table public.reviewers                     enable row level security;
alter table public.questions                     enable row level security;
alter table public.question_comments             enable row level security;
alter table public.question_views                enable row level security;
alter table public.issue_fields                  enable row level security;
alter table public.sla_settings                  enable row level security;
alter table public.app_settings                  enable row level security;
alter table public.activity_log                  enable row level security;
alter table public.admin_customization_activity  enable row level security;
alter table public.collab_profiles               enable row level security;
alter table public.collab_channels               enable row level security;
alter table public.collab_channel_members        enable row level security;
alter table public.collab_messages               enable row level security;
alter table public.collab_message_reactions      enable row level security;
alter table public.collab_message_reads          enable row level security;
alter table public.collab_typing                 enable row level security;
alter table public.collab_notifications          enable row level security;
alter table public.app_reactions                 enable row level security;

-- Drop all existing collab policies cleanly (so this script is safely rerunnable).
do $$
declare p record;
begin
  for p in select schemaname, tablename, policyname
           from pg_policies where schemaname = 'public' and tablename like 'collab_%'
  loop
    execute format('drop policy if exists %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;

-- ─── app_user_roles ─────────────────────────────────────────────────────────
drop policy if exists app_user_roles_select        on public.app_user_roles;
drop policy if exists app_user_roles_insert_admin  on public.app_user_roles;
drop policy if exists app_user_roles_update_admin  on public.app_user_roles;
drop policy if exists app_user_roles_delete_admin  on public.app_user_roles;

create policy app_user_roles_select on public.app_user_roles
  for select to authenticated
  using (public.is_admin() or lower(email) = public.current_user_email());

create policy app_user_roles_insert_admin on public.app_user_roles
  for insert to authenticated with check (public.is_admin());

create policy app_user_roles_update_admin on public.app_user_roles
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy app_user_roles_delete_admin on public.app_user_roles
  for delete to authenticated using (public.is_admin());

-- ─── reviewers (legacy) ─────────────────────────────────────────────────────
drop policy if exists read_reviewers          on public.reviewers;
drop policy if exists admin_manage_reviewers  on public.reviewers;

create policy read_reviewers on public.reviewers
  for select to authenticated using (true);

create policy admin_manage_reviewers on public.reviewers
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ─── questions ──────────────────────────────────────────────────────────────
drop policy if exists "Anyone can submit"                   on public.questions;
drop policy if exists "Public can read answered"            on public.questions;
drop policy if exists "Reviewer can update"                 on public.questions;
drop policy if exists "Reviewer can delete"                 on public.questions;
drop policy if exists questions_insert_authenticated        on public.questions;
drop policy if exists questions_select_active_authenticated on public.questions;
drop policy if exists questions_update_reviewers            on public.questions;

create policy questions_insert_authenticated on public.questions
  for insert to authenticated
  with check (submitter_email = auth.email() or public.is_reviewer());

create policy questions_select_active_authenticated on public.questions
  for select to authenticated
  using (coalesce(is_archived, false) = false or public.is_admin());

create policy questions_update_reviewers on public.questions
  for update to authenticated
  using (public.is_reviewer()) with check (public.is_reviewer());
-- No DELETE policy — archive instead of deleting.

-- ─── question_comments ──────────────────────────────────────────────────────
drop policy if exists insert_comments              on public.question_comments;
drop policy if exists select_comments              on public.question_comments;
drop policy if exists update_own_comments          on public.question_comments;
drop policy if exists comments_insert_authenticated on public.question_comments;
drop policy if exists comments_select_authenticated on public.question_comments;
drop policy if exists comments_update_own           on public.question_comments;

create policy comments_insert_authenticated on public.question_comments
  for insert to authenticated with check (user_email = auth.email());

create policy comments_select_authenticated on public.question_comments
  for select to authenticated using (true);

create policy comments_update_own on public.question_comments
  for update to authenticated
  using (user_email = auth.email()) with check (user_email = auth.email());

-- ─── question_views ─────────────────────────────────────────────────────────
drop policy if exists question_views_insert_own            on public.question_views;
drop policy if exists question_views_select_authenticated  on public.question_views;
drop policy if exists question_views_update_own            on public.question_views;

create policy question_views_insert_own on public.question_views
  for insert to authenticated with check (viewer_email = auth.email());

create policy question_views_select_authenticated on public.question_views
  for select to authenticated using (true);

create policy question_views_update_own on public.question_views
  for update to authenticated
  using (viewer_email = auth.email()) with check (viewer_email = auth.email());

-- ─── issue_fields ───────────────────────────────────────────────────────────
drop policy if exists issue_fields_read          on public.issue_fields;
drop policy if exists issue_fields_admin_manage  on public.issue_fields;

create policy issue_fields_read on public.issue_fields
  for select to authenticated using (true);

create policy issue_fields_admin_manage on public.issue_fields
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ─── sla_settings ───────────────────────────────────────────────────────────
drop policy if exists sla_settings_read          on public.sla_settings;
drop policy if exists sla_settings_admin_manage  on public.sla_settings;

create policy sla_settings_read on public.sla_settings
  for select to authenticated using (true);

create policy sla_settings_admin_manage on public.sla_settings
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ─── app_settings ───────────────────────────────────────────────────────────
drop policy if exists app_settings_read_authenticated on public.app_settings;
drop policy if exists app_settings_admin_write        on public.app_settings;

create policy app_settings_read_authenticated on public.app_settings
  for select to authenticated using (true);

create policy app_settings_admin_write on public.app_settings
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ─── activity_log ───────────────────────────────────────────────────────────
drop policy if exists activity_log_admin_read              on public.activity_log;
drop policy if exists activity_log_authenticated_insert    on public.activity_log;

create policy activity_log_admin_read on public.activity_log
  for select to authenticated using (public.is_admin());

create policy activity_log_authenticated_insert on public.activity_log
  for insert to authenticated
  with check (actor_email = auth.email() or public.is_admin());

-- ─── admin_customization_activity ───────────────────────────────────────────
drop policy if exists admin_customization_activity_admin_read   on public.admin_customization_activity;
drop policy if exists admin_customization_activity_admin_insert on public.admin_customization_activity;

create policy admin_customization_activity_admin_read on public.admin_customization_activity
  for select to authenticated using (public.is_admin());

create policy admin_customization_activity_admin_insert on public.admin_customization_activity
  for insert to authenticated with check (public.is_admin());

-- ─── collab_profiles ────────────────────────────────────────────────────────
create policy collab_profiles_select on public.collab_profiles
  for select to authenticated using (true);

create policy collab_profiles_insert_own on public.collab_profiles
  for insert to authenticated
  with check (lower(email) = public.current_user_email() or public.is_admin());

create policy collab_profiles_update_own_or_admin on public.collab_profiles
  for update to authenticated
  using (lower(email) = public.current_user_email() or public.is_admin())
  with check (lower(email) = public.current_user_email() or public.is_admin());

-- ─── collab_channels ────────────────────────────────────────────────────────
create policy collab_channels_select_visible on public.collab_channels
  for select to authenticated
  using (visibility = 'public' or public.can_access_collab_channel(id));

create policy collab_channels_insert_reviewer on public.collab_channels
  for insert to authenticated
  with check (public.is_reviewer() and lower(created_by) = public.current_user_email());

create policy collab_channels_update_manager on public.collab_channels
  for update to authenticated
  using (public.can_manage_collab_channel(id))
  with check (public.can_manage_collab_channel(id));

-- ─── collab_channel_members ─────────────────────────────────────────────────
create policy collab_members_select_visible on public.collab_channel_members
  for select to authenticated
  using (
    lower(user_email) = public.current_user_email()
    or public.is_admin()
    or exists (
      select 1 from public.collab_channels c
      where c.id = channel_id
        and (c.visibility = 'public' or lower(c.created_by) = public.current_user_email())
    )
  );

create policy collab_members_insert_manager on public.collab_channel_members
  for insert to authenticated
  with check (
    public.can_manage_collab_channel(channel_id)
    or (public.is_reviewer() and lower(user_email) = public.current_user_email())
  );

create policy collab_members_delete_manager on public.collab_channel_members
  for delete to authenticated using (public.can_manage_collab_channel(channel_id));

-- ─── collab_messages ────────────────────────────────────────────────────────
create policy collab_messages_select_visible on public.collab_messages
  for select to authenticated using (public.can_access_collab_channel(channel_id));

create policy collab_messages_insert_visible on public.collab_messages
  for insert to authenticated
  with check (
    public.can_access_collab_channel(channel_id)
    and lower(author_email) = public.current_user_email()
  );

create policy collab_messages_update_author on public.collab_messages
  for update to authenticated
  using (lower(author_email) = public.current_user_email() or public.can_manage_collab_channel(channel_id))
  with check (lower(author_email) = public.current_user_email() or public.can_manage_collab_channel(channel_id));

-- ─── collab_message_reactions ───────────────────────────────────────────────
create policy collab_reactions_select_visible on public.collab_message_reactions
  for select to authenticated using (public.can_access_collab_channel(channel_id));

create policy collab_reactions_insert_own on public.collab_message_reactions
  for insert to authenticated
  with check (
    public.can_access_collab_channel(channel_id)
    and lower(user_email) = public.current_user_email()
  );

create policy collab_reactions_delete_own on public.collab_message_reactions
  for delete to authenticated using (lower(user_email) = public.current_user_email());

-- ─── collab_message_reads ───────────────────────────────────────────────────
create policy collab_reads_select_visible on public.collab_message_reads
  for select to authenticated using (public.can_access_collab_channel(channel_id));

create policy collab_reads_upsert_own on public.collab_message_reads
  for insert to authenticated
  with check (
    public.can_access_collab_channel(channel_id)
    and lower(user_email) = public.current_user_email()
  );

create policy collab_reads_update_own on public.collab_message_reads
  for update to authenticated
  using (lower(user_email) = public.current_user_email())
  with check (lower(user_email) = public.current_user_email());

-- ─── collab_typing ──────────────────────────────────────────────────────────
create policy collab_typing_select_visible on public.collab_typing
  for select to authenticated using (public.can_access_collab_channel(channel_id));

create policy collab_typing_upsert_own on public.collab_typing
  for insert to authenticated
  with check (
    public.can_access_collab_channel(channel_id)
    and lower(user_email) = public.current_user_email()
  );

create policy collab_typing_update_own on public.collab_typing
  for update to authenticated
  using (lower(user_email) = public.current_user_email())
  with check (lower(user_email) = public.current_user_email());

create policy collab_typing_delete_own on public.collab_typing
  for delete to authenticated using (lower(user_email) = public.current_user_email());

-- ─── collab_notifications ───────────────────────────────────────────────────
create policy collab_notifications_select_own on public.collab_notifications
  for select to authenticated using (lower(recipient_email) = public.current_user_email());

create policy collab_notifications_update_own on public.collab_notifications
  for update to authenticated
  using (lower(recipient_email) = public.current_user_email())
  with check (lower(recipient_email) = public.current_user_email());

create policy collab_notifications_insert_authenticated on public.collab_notifications
  for insert to authenticated
  with check (recipient_email is not null and type is not null);

-- ─── app_reactions ──────────────────────────────────────────────────────────
drop policy if exists app_reactions_select_authenticated on public.app_reactions;
drop policy if exists app_reactions_insert_own           on public.app_reactions;
drop policy if exists app_reactions_delete_own           on public.app_reactions;

create policy app_reactions_select_authenticated on public.app_reactions
  for select to authenticated using (true);

create policy app_reactions_insert_own on public.app_reactions
  for insert to authenticated with check (user_email = auth.email());

create policy app_reactions_delete_own on public.app_reactions
  for delete to authenticated using (user_email = auth.email() or public.is_admin());


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 9 — SUPABASE REALTIME (for live chat & notifications)
-- ════════════════════════════════════════════════════════════════════════════

do $$
begin
  begin alter publication supabase_realtime add table public.collab_messages;           exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.collab_message_reactions;  exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.collab_message_reads;      exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.collab_typing;             exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.collab_notifications;      exception when duplicate_object then null; end;
end $$;


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 10 — REPORTING VIEWS (used by admin dashboard)
-- ════════════════════════════════════════════════════════════════════════════

create or replace view public.v_dashboard_health as
select
  count(*) filter (where not coalesce(is_archived, false))                                         as active_questions,
  count(*) filter (where coalesce(is_archived, false))                                             as archived_questions,
  count(*) filter (where not coalesce(is_archived, false) and status = 'Open')                     as open_questions,
  count(*) filter (where not coalesce(is_archived, false) and status = 'Answered'
                   and answered_date <= due_at)                                                    as answered_on_time,
  count(*) filter (where not coalesce(is_archived, false) and status in ('Open','In Review')
                   and due_at::date = now()::date)                                                 as due_today,
  count(*) filter (where not coalesce(is_archived, false) and status in ('Open','In Review')
                   and due_at < now())                                                             as overdue
from public.questions;

create or replace view public.v_question_analytics as
select
  q.id,
  q.question_id,
  q.task_id as bill_id,
  q.submitter_name,
  q.submitter_email,
  coalesce(q.issue_field, q.priority, 'Vendor') as issue_field,
  q.status,
  q.submitted_at,
  q.due_at,
  q.answered_date,
  q.answered_by,
  coalesce(q.is_archived, false) as is_archived,
  case
    when q.answered_date is null or q.submitted_at is null then null
    else round(extract(epoch from (q.answered_date - q.submitted_at)) / 3600.0, 2)
  end as response_hours,
  case
    when coalesce(q.is_archived, false)                                            then 'Archived'
    when q.status in ('Answered','Closed') and q.answered_date <= q.due_at          then 'Answered on time'
    when q.status in ('Answered','Closed') and q.answered_date >  q.due_at          then 'Answered late'
    when q.status in ('Open','In Review')  and q.due_at::date = now()::date         then 'Due today'
    when q.status in ('Open','In Review')  and q.due_at < now()                     then 'Overdue'
    else 'On track'
  end as sla_status
from public.questions q;

create or replace view public.v_submitter_rollup as
select
  submitter_email,
  max(submitter_name)                                                  as submitter_name,
  count(*)            filter (where not coalesce(is_archived, false))  as active_questions,
  count(*)            filter (where not coalesce(is_archived, false)
                              and status = 'Answered')                 as answered_questions,
  round(avg(response_hours) filter (where response_hours is not null), 2) as avg_response_hours,
  max(submitted_at)                                                    as last_asked_at
from public.v_question_analytics
group by submitter_email;


-- ════════════════════════════════════════════════════════════════════════════
-- DONE. After running this, refresh your app — everything should work.
-- ════════════════════════════════════════════════════════════════════════════
