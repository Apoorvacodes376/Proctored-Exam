-- ============================================================
-- phase2_patch_rls_recursion.sql
-- ProctorAI — fix: infinite recursion between exams ↔ exam_assignments RLS
--
-- Problem (in phase2_faculty_management.sql as written):
--   exams            "Students view assigned exams"             reads exam_assignments
--   exam_assignments "Faculty manage assignments for own exams" reads exams
-- PostgreSQL expands every permissive policy regardless of who is asking,
-- so ANY non-superuser query touching exams, exam_assignments, questions
-- or exam_sessions fails with:
--   ERROR: infinite recursion detected in policy for relation "exams"
--
-- Fix: the two cross-table checks go through SECURITY DEFINER helpers
-- (which read the other table without re-entering its RLS). Access rules
-- are unchanged:
--   - a student can see an exam iff they are assigned to it
--   - a faculty member can manage assignments iff they own the exam
--
-- Run after phase2_faculty_management.sql (any time; idempotent).
-- If phase2 is ever re-run, run this file again afterwards.
-- ============================================================

create or replace function public.is_exam_owner(p_exam_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.exams
    where  id = p_exam_id and faculty_id = auth.uid()
  );
$$;

create or replace function public.is_assigned_to_exam(p_exam_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from   public.exam_assignments ea
    join   public.students         s on s.id = ea.student_id
    where  ea.exam_id = p_exam_id
      and  s.email    = auth.email()
  );
$$;

revoke all on function public.is_exam_owner(uuid)       from public, anon;
revoke all on function public.is_assigned_to_exam(uuid) from public, anon;
grant execute on function public.is_exam_owner(uuid)       to authenticated;
grant execute on function public.is_assigned_to_exam(uuid) to authenticated;

drop policy if exists "Students view assigned exams" on public.exams;
create policy "Students view assigned exams"
  on public.exams for select
  using (public.is_assigned_to_exam(id));

drop policy if exists "Faculty manage assignments for own exams" on public.exam_assignments;
create policy "Faculty manage assignments for own exams"
  on public.exam_assignments for all
  using      (public.is_exam_owner(exam_id))
  with check (public.is_exam_owner(exam_id));
