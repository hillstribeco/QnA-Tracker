-- ════════════════════════════════════════════════════════════════════════════
-- MIGRATION 0003 — Attachments column, default channels, profile pictures
-- ════════════════════════════════════════════════════════════════════════════
-- Adds:
--  1. questions.attachments (jsonb) column + back-fill from existing tokens
--  2. Default channels: admin-announcement (read-only) + general
--  3. Read-only RLS for admin-announcement channel
--  4. profile-pictures storage bucket + RLS policies
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. Attachments column for questions ──────────────────────────────────────
alter table public.questions
  add column if not exists attachments jsonb not null default '[]'::jsonb;

create index if not exists idx_questions_has_attachments
  on public.questions ((jsonb_array_length(attachments) > 0))
  where jsonb_array_length(attachments) > 0;

-- ─── 2. Back-fill: extract [Attachment: name](url) tokens from question text ──
-- For every row whose question text contains attachment markdown tokens,
-- extract all (name, url) pairs into the new attachments column and
-- strip the tokens from the question text. Existing answer text is untouched.
update public.questions
set
  attachments = coalesce(
    (
      select jsonb_agg(jsonb_build_object('name', trim(m[1]), 'url', trim(m[2])))
      from regexp_matches(question, '\[Attachment:\s*([^\]]+)\]\(([^)]+)\)', 'g') as m
    ),
    '[]'::jsonb
  ),
  question = trim(both E' \n\r\t' from
    regexp_replace(question, '\s*\[Attachment:[^\]]+\]\([^)]+\)\s*', ' ', 'g')
  )
where question like '%[Attachment:%';

-- ─── 3. Default channels: admin-announcement + general ────────────────────────
-- Idempotent insert — runs safely even if channels already exist.
insert into public.collab_channels (name, slug, description, visibility, created_by)
values
  ('admin-announcement', 'admin-announcement',
   'Admin announcements. Read-only — only admins can post.',
   'public', 'system'),
  ('general', 'general',
   'Team-wide chat, questions, and updates. Everyone can post.',
   'public', 'system')
on conflict (slug) do nothing;

-- ─── 4. Read-only RLS for admin-announcement channel ──────────────────────────
-- Replace the existing collab_messages insert policy with one that enforces
-- broadcast semantics for admin-announcement while keeping prior behavior
-- for every other channel.
drop policy if exists collab_messages_insert_visible on public.collab_messages;
create policy collab_messages_insert_visible on public.collab_messages
  for insert to authenticated
  with check (
    case
      when (select slug from public.collab_channels where id = channel_id) = 'admin-announcement'
        then public.can_manage_collab_channel(channel_id)
             and lower(author_email) = public.current_user_email()
      else
        public.can_access_collab_channel(channel_id)
        and lower(author_email) = public.current_user_email()
    end
  );

-- ─── 5. Profile pictures storage bucket ───────────────────────────────────────
-- 2 MB limit, JPG/PNG/WEBP only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'profile-pictures',
  'profile-pictures',
  true,
  2097152,
  array['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Storage RLS — owners can write to their own folder, everyone can read.
drop policy if exists profile_pictures_upload on storage.objects;
create policy profile_pictures_upload on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'profile-pictures'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists profile_pictures_update on storage.objects;
create policy profile_pictures_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'profile-pictures'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'profile-pictures'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists profile_pictures_delete on storage.objects;
create policy profile_pictures_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'profile-pictures'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists profile_pictures_public_read on storage.objects;
create policy profile_pictures_public_read on storage.objects
  for select to public
  using (bucket_id = 'profile-pictures');

-- ─── End of migration 0003 ────────────────────────────────────────────────────
