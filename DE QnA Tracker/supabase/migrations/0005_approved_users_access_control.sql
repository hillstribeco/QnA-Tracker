-- Approved users access control
-- This table controls who is allowed to enter the app after Google login.

create table if not exists public.approved_users (
  email text primary key,
  role text not null default 'user',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Always keep owner access enabled.
insert into public.approved_users (email, role, active)
values ('hillstribeco@gmail.com', 'owner', true)
on conflict (email)
do update set
  role = 'owner',
  active = true;

-- Optional: add your first company users here.
-- Replace companyname.com with your real company domain.
-- Remove the -- before each line when ready.
--
-- insert into public.approved_users (email, role, active)
-- values
-- ('john@companyname.com', 'user', true),
-- ('sara@companyname.com', 'admin', true)
-- on conflict (email)
-- do update set
--   role = excluded.role,
--   active = excluded.active;