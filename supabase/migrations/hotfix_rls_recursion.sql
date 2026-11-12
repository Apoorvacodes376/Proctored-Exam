-- ============================================================
-- hotfix_rls_recursion.sql
-- Run this once in the Supabase SQL editor to fix the live DB.
-- The full migration file has already been updated to include
-- these changes for future fresh deployments.
-- ============================================================

-- 1. Create security definer helpers that bypass RLS.
--    These break the circular reference:
--    questions → exams (RLS) → exam_assignments (RLS) → exams → ∞

create or replace function public.exam_owned_by(p_exam_id uuid, p_faculty_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.exams
    where  id = p_exam_id and faculty_id = p_faculty_id
  );
$$;

create or replace function public.exam_assigned_to_email(p_exam_id uuid, p_email text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from   public.exam_assignments ea
    join   public.students         s on s.id = ea.student_id
    where  ea.exam_id = p_exam_id
      and  s.email    = p_email
  );
$$;


-- 2. Replace recursive policies on questions.

drop policy if exists "Faculty manage questions for own exams"     on public.questions;
drop policy if exists "Students view questions for assigned exams" on public.questions;

create policy "Faculty manage questions for own exams"
  on public.questions for all
  using     (public.exam_owned_by(exam_id, auth.uid()))
  with check (public.exam_owned_by(exam_id, auth.uid()));

create policy "Students view questions for assigned exams"
  on public.questions for select
  using (public.exam_assigned_to_email(exam_id, auth.email()));


-- 3. Replace recursive policies on exam_assignments.

drop policy if exists "Faculty manage assignments for own exams" on public.exam_assignments;
drop policy if exists "Students view own assignments"            on public.exam_assignments;

create policy "Faculty manage assignments for own exams"
  on public.exam_assignments for all
  using     (public.exam_owned_by(exam_id, auth.uid()))
  with check (public.exam_owned_by(exam_id, auth.uid()));

create policy "Students view own assignments"
  on public.exam_assignments for select
  using (
    exists (
      select 1 from public.students
      where  id    = exam_assignments.student_id
        and  email = auth.email()
    )
  );
