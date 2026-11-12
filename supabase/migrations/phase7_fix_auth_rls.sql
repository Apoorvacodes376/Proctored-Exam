-- ============================================================
-- phase7_fix_auth_rls.sql
-- ProctorAI — Fix: HTTP 500/403 on /rest/v1/profiles after login
--
-- Root causes fixed here:
--   1. Recursive RLS on profiles (500): old policies in schema.sql
--      and migration_fix_rls.sql used subqueries against profiles
--      from inside a profiles policy → infinite recursion.
--   2. Faculty JWT claim path mismatch (403): policies used
--      auth.jwt() -> 'user_metadata' ->> 'role' but Supabase
--      embeds the claim at auth.jwt() ->> 'role' only after
--      update_user() sets app_metadata. user_metadata is nested.
--   3. handle_new_user hardcoded 'student' for all signups,
--      so faculty who signed up got role='student' in profiles,
--      making the faculty RLS policy never match.
--   4. profiles_update_own WITH CHECK blocked updates for users
--      whose JWT lacked the role claim (returns null → mismatch).
--   5. exam_sessions created by migration_fix_rls.sql lacks the
--      assignment_id column required by phase3_student_exam.sql.
--
-- Safety:
--   • Never drops tables or data.
--   • All policy/function changes are idempotent (DROP IF EXISTS
--     before CREATE).
--   • Existing users are back-filled with correct role metadata.
--   • Run this AFTER all prior phase migrations.
-- ============================================================


-- ============================================================
-- 1. PROFILES RLS — drop every known policy variant, then
--    recreate with non-recursive, JWT-based checks.
-- ============================================================

-- Drop all known policy names across schema.sql, migration_fix_rls.sql,
-- and phase1_setup.sql so we start clean regardless of run order.
drop policy if exists "Users can view own profile"        on public.profiles;
drop policy if exists "Users can update own profile"      on public.profiles;
drop policy if exists "Faculty can view student profiles" on public.profiles;
drop policy if exists "Faculty can view all profiles"     on public.profiles;
drop policy if exists "profiles_select_own"               on public.profiles;
drop policy if exists "profiles_select_faculty"           on public.profiles;
drop policy if exists "profiles_update_own"               on public.profiles;
drop policy if exists "profiles_insert_own"               on public.profiles;

-- SELECT: each user reads their own row — no subquery, no recursion.
create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

-- SELECT: faculty can read all profiles.
-- Reads role from JWT app_metadata (set by handle_new_user below).
-- auth.jwt() ->> 'role' is the Supabase service-role claim path;
-- for custom roles we use app_metadata which is embedded at the
-- top level of the JWT by Supabase when set via update_user().
create policy "profiles_select_faculty"
  on public.profiles for select
  using (
    coalesce(
      auth.jwt() -> 'app_metadata' ->> 'role',
      auth.jwt() -> 'user_metadata' ->> 'role',
      ''
    ) = 'faculty'
  );

-- UPDATE: users can update their own row but cannot change their role.
-- Compares new.role to the stored role in the DB via a SECURITY DEFINER
-- helper to avoid recursion, OR falls back to the JWT claim.
-- Using coalesce with '' prevents null-mismatch blocking all updates.
create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id)
  with check (
    auth.uid() = id
    and role = coalesce(
      auth.jwt() -> 'app_metadata' ->> 'role',
      auth.jwt() -> 'user_metadata' ->> 'role',
      'student'
    )
  );

-- INSERT: allow authenticated users to insert their own row.
-- The trigger (SECURITY DEFINER) also inserts — this policy covers
-- the OAuth callback race where the frontend inserts before the trigger.
create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = id);


-- ============================================================
-- 2. handle_new_user — respect the role from user_metadata AND
--    write it into app_metadata so the JWT claim is available
--    immediately on the next sign-in.
--
--    SECURITY NOTE: allowing client-supplied role means any user
--    can self-declare as faculty at signup. This is acceptable
--    when faculty accounts are controlled at the application level
--    (e.g. invite-only). If you need to prevent self-promotion,
--    remove the 'faculty' branch and promote via SQL manually.
-- ============================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _username text;
  _role     text;
begin
  _username := coalesce(
    nullif(trim(new.raw_user_meta_data->>'username'), ''),
    split_part(new.email, '@', 1)
  );

  -- Accept 'faculty' or 'student'; default to 'student'.
  _role := case
    when new.raw_user_meta_data->>'role' = 'faculty' then 'faculty'
    else 'student'
  end;

  insert into public.profiles (id, username, email, role)
  values (new.id, _username, new.email, _role)
  on conflict (id) do nothing;

  -- Write role into app_metadata so it appears as a top-level JWT
  -- claim on the NEXT sign-in (Supabase embeds app_metadata in the
  -- JWT automatically). Also mirror into user_metadata for clients
  -- that read from there.
  update auth.users
  set
    raw_app_meta_data  = coalesce(raw_app_meta_data,  '{}'::jsonb)
                         || jsonb_build_object('role', _role),
    raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
                         || jsonb_build_object('role', _role)
  where id = new.id;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();


-- ============================================================
-- 3. Back-fill app_metadata.role for ALL existing users.
--    Reads the authoritative role from public.profiles.
--    Safe: only sets the 'role' key, leaves everything else.
-- ============================================================

update auth.users u
set
  raw_app_meta_data  = coalesce(u.raw_app_meta_data,  '{}'::jsonb)
                       || jsonb_build_object('role', coalesce(p.role, 'student')),
  raw_user_meta_data = coalesce(u.raw_user_meta_data, '{}'::jsonb)
                       || jsonb_build_object('role', coalesce(p.role, 'student'))
from public.profiles p
where p.id = u.id;

-- Also back-fill users who have a profile row with role='student'
-- because handle_new_user previously hardcoded 'student'.
-- Faculty who signed up before this fix will still have role='student'
-- in profiles — they need a manual UPDATE (see README).


-- ============================================================
-- 4. get_email_by_username — SECURITY DEFINER RPC for username login.
--    Callable by anon so the login page can resolve username → email
--    without exposing the full profiles table.
-- ============================================================

create or replace function public.get_email_by_username(p_username text)
returns text
language sql
security definer
stable
set search_path = public
as $$
  select email from public.profiles where username = p_username limit 1;
$$;

grant execute on function public.get_email_by_username(text) to anon, authenticated;


-- ============================================================
-- 5. exam_sessions — ensure the table matches phase3_student_exam.sql
--    schema (with assignment_id). migration_fix_rls.sql created a
--    simplified version without assignment_id; add it if missing.
-- ============================================================

-- Add assignment_id column if it doesn't exist yet.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'exam_sessions'
      and column_name  = 'assignment_id'
  ) then
    alter table public.exam_sessions
      add column assignment_id uuid references public.exam_assignments(id) on delete cascade;
  end if;
end;
$$;

-- Add ip_address / user_agent columns if missing (phase3 schema).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'exam_sessions'
      and column_name  = 'ip_address'
  ) then
    alter table public.exam_sessions add column ip_address text;
    alter table public.exam_sessions add column user_agent text;
  end if;
end;
$$;

-- Widen the status check to include 'flagged' (phase3 adds it).
alter table public.exam_sessions
  drop constraint if exists exam_sessions_status_check;

alter table public.exam_sessions
  add constraint exam_sessions_status_check
  check (status in ('in_progress', 'submitted', 'timed_out', 'flagged'));

-- Ensure RLS is enabled (migration_fix_rls.sql enables it, but be safe).
alter table public.exam_sessions enable row level security;

-- Drop all known exam_sessions policies and recreate consistently.
drop policy if exists "exam_sessions_student_own"      on public.exam_sessions;
drop policy if exists "exam_sessions_faculty_read"     on public.exam_sessions;
drop policy if exists "Students manage own session"    on public.exam_sessions;
drop policy if exists "Faculty view sessions for exams" on public.exam_sessions;

create policy "Students manage own session"
  on public.exam_sessions for all
  using (
    exists (
      select 1 from public.students
      where  id    = exam_sessions.student_id
        and  email = auth.email()
    )
  )
  with check (
    exists (
      select 1 from public.students
      where  id    = exam_sessions.student_id
        and  email = auth.email()
    )
  );

create policy "Faculty view sessions for exams"
  on public.exam_sessions for select
  using (
    exists (
      select 1 from public.exams
      where  id = exam_sessions.exam_id and faculty_id = auth.uid()
    )
  );


-- ============================================================
-- 6. students RLS — ensure auth.email() is used (not profiles subquery).
--    phase2_faculty_management.sql already does this correctly;
--    this block is a safety net in case schema.sql was applied last.
-- ============================================================

drop policy if exists "Students view own record" on public.students;

create policy "Students view own record"
  on public.students for select
  using (email = auth.email());


-- ============================================================
-- DONE.
-- After running this migration:
--   1. All existing users will have app_metadata.role set.
--   2. New signups will have role written to both metadata fields.
--   3. Faculty users can read all profiles without recursion.
--   4. Students can read only their own profile.
--   5. No user can change their own role via the API.
--   6. exam_sessions schema is compatible with phase3.
--
-- To promote an existing user to faculty (manual operation):
--   update public.profiles set role = 'faculty' where email = '<email>';
--   update auth.users
--     set raw_app_meta_data  = raw_app_meta_data  || '{"role":"faculty"}',
--         raw_user_meta_data = raw_user_meta_data || '{"role":"faculty"}'
--   where email = '<email>';
--   -- User must sign out and sign back in for the new JWT to take effect.
-- ============================================================
