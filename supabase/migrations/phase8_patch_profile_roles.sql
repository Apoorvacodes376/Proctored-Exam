-- ============================================================
-- phase8_patch_profile_roles.sql
-- ProctorAI — Fix: users could make themselves faculty
--
-- Problem (introduced by phase7_fix_auth_rls.sql):
--   1. handle_new_user() copied the "role" the signup form sent in
--      user_metadata into public.profiles, so anyone could sign up as
--      faculty.
--   2. The profiles policies compared roles with the JWT claim
--      auth.jwt() -> 'user_metadata' ->> 'role'. user_metadata is
--      writable by the signed-in user
--      (supabase.auth.updateUser({ data: { role: 'faculty' } })), so an
--      existing student could set that claim and then read every
--      profile or update their own role to 'faculty'.
--
-- Fix:
--   • Every new account is a student; the client cannot choose a role.
--   • The role is read from public.profiles (via the SECURITY DEFINER
--     helper profile_role() from phase6_patch_integrity_evaluation.sql),
--     never from a token claim the user can edit.
--   • The stray "role" key is removed from every user_metadata, and
--     app_metadata (which only the server can write) mirrors the stored
--     role.
--   • Optional: schedules finalize_expired_sessions() every minute if
--     the pg_cron extension is already enabled.
--
-- Run AFTER phase7_fix_auth_rls.sql. Idempotent.
--
-- Existing faculty accounts keep their role. Review them with:
--   select email, role from public.profiles where role = 'faculty';
-- and demote any that should not be faculty:
--   update public.profiles set role = 'student' where email = '...';
-- ============================================================


-- ============================================================
-- 1. handle_new_user — always a student
-- ============================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _username text;
begin
  _username := coalesce(
    nullif(trim(new.raw_user_meta_data->>'username'), ''),
    split_part(new.email, '@', 1)
  );

  -- SECURITY: the role is never taken from client-supplied metadata.
  -- Faculty are promoted by an administrator (see README, "Promoting a
  -- user to faculty").
  insert into public.profiles (id, username, email, role)
  values (new.id, _username, new.email, 'student')
  on conflict (id) do nothing;

  -- app_metadata can only be written by the server; mirror the stored
  -- role there and drop any client-supplied "role" from user_metadata.
  update auth.users u
  set
    raw_app_meta_data  = coalesce(u.raw_app_meta_data,  '{}'::jsonb)
                         || jsonb_build_object('role', (select p.role from public.profiles p where p.id = new.id)),
    raw_user_meta_data = coalesce(u.raw_user_meta_data, '{}'::jsonb) - 'role'
  where u.id = new.id;

  return new;
end;
$$;


-- ============================================================
-- 2. profiles RLS — role comes from the table, not from the token
-- ============================================================

drop policy if exists "profiles_select_own"     on public.profiles;
drop policy if exists "profiles_select_faculty" on public.profiles;
drop policy if exists "profiles_update_own"     on public.profiles;
drop policy if exists "profiles_insert_own"     on public.profiles;
drop policy if exists "Users can update own profile" on public.profiles;

create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

-- profile_role() is SECURITY DEFINER, so this does not recurse.
create policy "profiles_select_faculty"
  on public.profiles for select
  using (public.profile_role(auth.uid()) = 'faculty');

-- A user may edit their own row but never change their role.
create policy "profiles_update_own"
  on public.profiles for update
  using      (auth.uid() = id)
  with check (auth.uid() = id and role = public.profile_role(auth.uid()));

-- Covers the OAuth callback race where the browser inserts before the
-- trigger runs. Only a student row can be created this way.
create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = id and role = 'student');


-- ============================================================
-- 3. Back-fill existing users
--    app_metadata mirrors the stored role; user_metadata loses "role".
-- ============================================================

update auth.users u
set
  raw_app_meta_data  = coalesce(u.raw_app_meta_data,  '{}'::jsonb) || jsonb_build_object('role', p.role),
  raw_user_meta_data = coalesce(u.raw_user_meta_data, '{}'::jsonb) - 'role'
from public.profiles p
where p.id = u.id;


-- ============================================================
-- 4. Optional: close overdue sessions every minute
--    Only if pg_cron is already enabled (Dashboard → Database →
--    Extensions). Otherwise a notice is printed and nothing changes;
--    the faculty Monitor/Review pages still call the function.
-- ============================================================

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('finalize-exams', '* * * * *', 'select public.finalize_expired_sessions()');
    raise notice 'Scheduled finalize-exams (every minute).';
  else
    raise notice 'pg_cron is not enabled; finalize_expired_sessions() was not scheduled.';
  end if;
exception when others then
  raise notice 'Could not schedule finalize-exams: %', sqlerrm;
end
$$;
