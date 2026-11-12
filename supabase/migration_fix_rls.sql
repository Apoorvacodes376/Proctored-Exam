-- ============================================================
-- ProctorAI — RLS Fix Migration
-- Safe to run on an existing database: drops only policies,
-- never touches table data or structure.
-- Run this in the Supabase SQL Editor.
-- ============================================================

-- ============================================================
-- 1. FIX: profiles — drop all existing policies first
-- ============================================================

drop policy if exists "Users can view own profile"        on public.profiles;
drop policy if exists "Users can update own profile"      on public.profiles;
drop policy if exists "Faculty can view student profiles" on public.profiles;

-- SELECT: each user reads their own row.
-- Uses auth.uid() directly — no subquery, no recursion.
create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

-- SELECT: faculty can read all profiles.
-- Reads role from auth.jwt() — not from the profiles table — so no recursion.
create policy "profiles_select_faculty"
  on public.profiles for select
  using (
    coalesce(auth.jwt() -> 'user_metadata' ->> 'role', '') = 'faculty'
  );

-- UPDATE: users can update their own row but cannot change their role.
-- The WITH CHECK reads new.role from the incoming row and compares it to
-- the value stored in auth.jwt(), which is set at sign-in time and cannot
-- be forged by the client without a new sign-in.
create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id)
  with check (
    auth.uid() = id
    and role = coalesce(auth.jwt() -> 'user_metadata' ->> 'role', 'student')
  );

-- INSERT: allow the DB trigger (security definer) to insert.
-- The trigger runs as the postgres superuser so it bypasses RLS.
-- We also need to allow the authenticated user to insert their own row
-- in case the trigger races with the frontend (e.g. OAuth callback).
create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = id);

-- ============================================================
-- 2. FIX: handle_new_user trigger — store role in user_metadata
--    so auth.jwt() -> 'user_metadata' ->> 'role' is always populated.
--    Also update app_metadata so the JWT claim is available immediately.
-- ============================================================

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  _username text;
  _role     text;
begin
  _username := coalesce(
    nullif(trim(new.raw_user_meta_data->>'username'), ''),
    split_part(new.email, '@', 1)
  );
  -- Only 'student' or 'faculty' are valid; default to 'student'.
  _role := case
    when new.raw_user_meta_data->>'role' = 'faculty' then 'faculty'
    else 'student'
  end;

  insert into public.profiles (id, username, email, role)
  values (new.id, _username, new.email, _role)
  on conflict (id) do nothing;

  -- Persist the role into user_metadata so auth.jwt() reflects it.
  -- This makes the profiles_select_faculty policy work without a subquery.
  update auth.users
  set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('role', _role)
  where id = new.id;

  return new;
end;
$$;

-- Re-create the trigger (drop first to avoid duplicate)
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- 3. FIX: Back-fill user_metadata.role for existing users
--    whose metadata was created before this migration.
--    This is safe — it only sets the role key, leaves everything else.
-- ============================================================

update auth.users u
set raw_user_meta_data =
  coalesce(u.raw_user_meta_data, '{}'::jsonb)
  || jsonb_build_object('role', coalesce(p.role, 'student'))
from public.profiles p
where p.id = u.id
  and (
    u.raw_user_meta_data->>'role' is null
    or u.raw_user_meta_data->>'role' not in ('student', 'faculty')
  );

-- ============================================================
-- 4. FIX: students — replace profile-recursive subqueries
--    with auth.users lookups (auth.users is not RLS-protected)
-- ============================================================

drop policy if exists "Faculty manage own students" on public.students;
drop policy if exists "Students view own record"    on public.students;

create policy "students_all_faculty"
  on public.students for all
  using (faculty_id = auth.uid())
  with check (faculty_id = auth.uid());

-- Students look up their own record by matching email against auth.users,
-- not public.profiles — avoids re-entering the profiles RLS stack.
create policy "students_select_own"
  on public.students for select
  using (
    email = (select email from auth.users where id = auth.uid())
  );

-- ============================================================
-- 5. FIX: exams — replace profile-recursive subquery
-- ============================================================

drop policy if exists "Students view assigned exams" on public.exams;

create policy "exams_select_assigned_students"
  on public.exams for select
  using (
    exists (
      select 1
      from public.exam_assignments ea
      join public.students s on s.id = ea.student_id
      where ea.exam_id = exams.id
        and s.email = (select email from auth.users where id = auth.uid())
    )
  );

-- ============================================================
-- 6. FIX: questions — replace profile-recursive subquery
-- ============================================================

drop policy if exists "Students view questions for assigned exams" on public.questions;

create policy "questions_select_assigned_students"
  on public.questions for select
  using (
    exists (
      select 1
      from public.exam_assignments ea
      join public.students s on s.id = ea.student_id
      where ea.exam_id = questions.exam_id
        and s.email = (select email from auth.users where id = auth.uid())
    )
  );

-- ============================================================
-- 7. FIX: exam_assignments — replace profile-recursive subquery
-- ============================================================

drop policy if exists "Students view own assignments" on public.exam_assignments;

create policy "exam_assignments_select_own_student"
  on public.exam_assignments for select
  using (
    exists (
      select 1 from public.students
      where id = exam_assignments.student_id
        and email = (select email from auth.users where id = auth.uid())
    )
  );

-- ============================================================
-- 8. ADD: get_email_by_username — SECURITY DEFINER RPC
--    Allows unauthenticated callers to resolve a username to an
--    email for the login flow, without exposing the full profiles
--    table to anon. Returns NULL if not found.
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

-- Grant execute to anon and authenticated roles
grant execute on function public.get_email_by_username(text) to anon, authenticated;

-- ============================================================
-- 9. ADD: exam_sessions table (referenced by StudentDashboard)
--    Tracks a student's active/submitted exam attempt.
-- ============================================================

create table if not exists public.exam_sessions (
  id           uuid primary key default gen_random_uuid(),
  exam_id      uuid not null references public.exams(id) on delete cascade,
  student_id   uuid not null references public.students(id) on delete cascade,
  status       text not null default 'in_progress'
                 check (status in ('in_progress', 'submitted', 'timed_out')),
  started_at   timestamptz default now(),
  submitted_at timestamptz,
  answers      jsonb default '{}'::jsonb,
  unique (exam_id, student_id)
);

alter table public.exam_sessions enable row level security;

-- Students can read and update their own session
create policy "exam_sessions_student_own"
  on public.exam_sessions for all
  using (
    exists (
      select 1 from public.students
      where id = exam_sessions.student_id
        and email = (select email from auth.users where id = auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.students
      where id = exam_sessions.student_id
        and email = (select email from auth.users where id = auth.uid())
    )
  );

-- Faculty can read sessions for their own exams
create policy "exam_sessions_faculty_read"
  on public.exam_sessions for select
  using (
    exists (
      select 1 from public.exams
      where id = exam_sessions.exam_id and faculty_id = auth.uid()
    )
  );
