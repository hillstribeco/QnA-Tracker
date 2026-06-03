-- 0002_attachments_storage.sql
-- Purpose: storage-backed attachments for questions, answers, follow-ups, and Team Chat.
-- The frontend uploads files to this public bucket and stores only the resulting
-- Supabase Storage URL in the existing text/body fields.

begin;

insert into storage.buckets (id, name, public)
values ('qna-attachments', 'qna-attachments', true)
on conflict (id) do update set public = true;

drop policy if exists qna_attachments_public_read on storage.objects;
drop policy if exists qna_attachments_authenticated_insert on storage.objects;
drop policy if exists qna_attachments_owner_update on storage.objects;
drop policy if exists qna_attachments_owner_delete on storage.objects;

create policy qna_attachments_public_read on storage.objects
  for select to public
  using (bucket_id = 'qna-attachments');

create policy qna_attachments_authenticated_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'qna-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy qna_attachments_owner_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'qna-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'qna-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy qna_attachments_owner_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'qna-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

commit;
