-- ============================================================
-- phase2_faculty_management.sql
-- ProctorAI — Phase 2: Faculty Management
--
-- Covers:
--   • public.students          — student records owned by faculty
--   • public.exams             — exam definitions
--   • public.questions         — per-exam questions (MCQ + descriptive)
--   • public.exam_assignments  — student ↔ exam join table
--   • updated_at triggers for students and exams
--   • RLS policies for all four tables
--   • storage.buckets: student-photos
--   • Storage RLS policies for student-photos
--
-- Safety:
--   Phase 2 has already been partially applied to the live
--   database. Every statement is idempotent.
--
-- Depends on: phase1_setup.sql (public.profiles must exist)
-- Required before: phase3 and all later phases
-- ============================================================


-- ============================================================
-- 1. STUDENTS
-- ============================================================

create table if not exists public.students (
  id         uuid        primary key default gen_random_uuid(),
  faculty_id uuid        not null references public.profiles(id) on delete cascade,
  name       text        not null,
  email      text        not null,
  student_id text        not null,
  photo_url  text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Unique constraints wrapped in DO blocks so re-runs skip silently.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.students'::regclass
      and conname  = 'students_faculty_id_student_id_key'
  ) then
    alter table public.students
      add constraint students_faculty_id_student_id_key
      unique (faculty_id, student_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.students'::regclass
      and conname  = 'students_faculty_id_email_key'
  ) then
    alter table public.students
      add constraint students_faculty_id_email_key
      unique (faculty_id, email);
  end if;
end;
$$;

create index if not exists students_faculty_id_idx on public.students (faculty_id);
create index if not exists students_email_idx      on public.students (email);

-- updated_at trigger
drop trigger if exists students_updated_at on public.students;
create trigger students_updated_at
  before update on public.students
  for each row execute procedure public.set_updated_at();


-- ============================================================
-- 2. EXAMS
-- ============================================================

create table if not exists public.exams (
  id            uuid        primary key default gen_random_uuid(),
  faculty_id    uuid        not null references public.profiles(id) on delete cascade,
  title         text        not null,
  subject       text        not null,
  exam_date     date        not null,
  start_time    time        not null,
  duration_mins integer     not null check (duration_mins > 0),
  total_marks   integer     not null default 0,
  instructions  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists exams_faculty_id_idx on public.exams (faculty_id);
create index if not exists exams_exam_date_idx  on public.exams (exam_date);

-- updated_at trigger
drop trigger if exists exams_updated_at on public.exams;
create trigger exams_updated_at
  before update on public.exams
  for each row execute procedure public.set_updated_at();


-- ============================================================
-- 3. QUESTIONS
-- ============================================================

create table if not exists public.questions (
  id             uuid        primary key default gen_random_uuid(),
  exam_id        uuid        not null references public.exams(id) on delete cascade,
  question_text  text        not null,
  question_type  text        not null check (question_type in ('mcq', 'descriptive')),
  options        jsonb,                  -- array of option strings for MCQ
  correct_answer text,                   -- '0'–'3' index for MCQ; null for descriptive
  marks          integer     not null default 1 check (marks > 0),
  order_index    integer     not null default 0,
  created_at     timestamptz not null default now()
);

create index if not exists questions_exam_id_idx on public.questions (exam_id);


-- ============================================================
-- 4. EXAM ASSIGNMENTS  (student ↔ exam join table)
-- ============================================================

create table if not exists public.exam_assignments (
  id          uuid        primary key default gen_random_uuid(),
  exam_id     uuid        not null references public.exams(id)    on delete cascade,
  student_id  uuid        not null references public.students(id) on delete cascade,
  assigned_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.exam_assignments'::regclass
      and conname  = 'exam_assignments_exam_id_student_id_key'
  ) then
    alter table public.exam_assignments
      add constraint exam_assignments_exam_id_student_id_key
      unique (exam_id, student_id);
  end if;
end;
$$;

create index if not exists exam_assignments_exam_id_idx    on public.exam_assignments (exam_id);
create index if not exists exam_assignments_student_id_idx on public.exam_assignments (student_id);


-- ============================================================
-- 5. RLS — STUDENTS
-- ============================================================

alter table public.students enable row level security;

drop policy if exists "Faculty manage own students" on public.students;
drop policy if exists "Students view own record"    on public.students;

-- Faculty: full CRUD on students they created.
create policy "Faculty manage own students"
  on public.students for all
  using     (faculty_id = auth.uid())
  with check (faculty_id = auth.uid());

-- Students: read-only access to their own record.
-- Uses auth.email() (JWT) — no subquery against profiles.
create policy "Students view own record"
  on public.students for select
  using (email = auth.email());


-- ============================================================
-- 6. RLS — EXAMS
-- ============================================================

alter table public.exams enable row level security;

drop policy if exists "Faculty manage own exams"     on public.exams;
drop policy if exists "Students view assigned exams" on public.exams;

-- Faculty: full CRUD on exams they own.
create policy "Faculty manage own exams"
  on public.exams for all
  using     (faculty_id = auth.uid())
  with check (faculty_id = auth.uid());

-- Students: read-only, only for exams they are assigned to.
-- Uses auth.email() (JWT) — no subquery against profiles.
create policy "Students view assigned exams"
  on public.exams for select
  using (
    exists (
      select 1
      from   public.exam_assignments ea
      join   public.students         s on s.id = ea.student_id
      where  ea.exam_id = exams.id
        and  s.email    = auth.email()
    )
  );


-- ============================================================
-- 6b. SECURITY DEFINER helpers — break RLS circular references
--
-- Policies on questions and exam_assignments need to look up the
-- faculty_id on exams, but exams itself has RLS enabled.  A plain
-- subquery re-enters the exams RLS check, which in turn queries
-- exam_assignments, causing infinite recursion.
--
-- The fix: wrap the cross-table lookups in SECURITY DEFINER
-- functions that run as the table owner (bypassing RLS) and
-- return only a boolean.  The functions are intentionally minimal
-- and expose no data beyond the boolean result.
-- ============================================================

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


-- ============================================================
-- 7. RLS — QUESTIONS
-- ============================================================

alter table public.questions enable row level security;

drop policy if exists "Faculty manage questions for own exams"     on public.questions;
drop policy if exists "Students view questions for assigned exams" on public.questions;

create policy "Faculty manage questions for own exams"
  on public.questions for all
  using     (public.exam_owned_by(exam_id, auth.uid()))
  with check (public.exam_owned_by(exam_id, auth.uid()));

create policy "Students view questions for assigned exams"
  on public.questions for select
  using (public.exam_assigned_to_email(exam_id, auth.email()));


-- ============================================================
-- 8. RLS — EXAM ASSIGNMENTS
-- ============================================================

alter table public.exam_assignments enable row level security;

drop policy if exists "Faculty manage assignments for own exams" on public.exam_assignments;
drop policy if exists "Students view own assignments"            on public.exam_assignments;

create policy "Faculty manage assignments for own exams"
  on public.exam_assignments for all
  using     (public.exam_owned_by(exam_id, auth.uid()))
  with check (public.exam_owned_by(exam_id, auth.uid()));

-- Students: read-only, only their own assignment rows.
-- Uses auth.email() (JWT) — no subquery against profiles.
create policy "Students view own assignments"
  on public.exam_assignments for select
  using (
    exists (
      select 1 from public.students
      where  id    = exam_assignments.student_id
        and  email = auth.email()
    )
  );


-- ============================================================
-- 9. STORAGE — student-photos bucket
-- ============================================================

-- Create bucket (idempotent). Public so photo URLs work in the browser.
insert into storage.buckets (id, name, public)
values ('student-photos', 'student-photos', true)
on conflict (id) do update set public = true;

-- Drop all known prior policy names (from schema.sql and 007_storage.sql)
-- before recreating, so this file is safe regardless of prior state.
drop policy if exists "Faculty upload photos"       on storage.objects;
drop policy if exists "Faculty read photos"         on storage.objects;
drop policy if exists "Faculty delete photos"       on storage.objects;
drop policy if exists "Faculty upload own photos"   on storage.objects;
drop policy if exists "Faculty read own photos"     on storage.objects;
drop policy if exists "Faculty update own photos"   on storage.objects;
drop policy if exists "Faculty delete own photos"   on storage.objects;
drop policy if exists "Students read own photo"     on storage.objects;

-- Path convention: <faculty_uid>/<student_uuid>.<ext>
-- This scopes every operation to the faculty's own folder,
-- preventing cross-faculty file access.

create policy "Faculty upload own photos"
  on storage.objects for insert
  with check (
    bucket_id = 'student-photos'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Faculty read own photos"
  on storage.objects for select
  using (
    bucket_id = 'student-photos'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Faculty update own photos"
  on storage.objects for update
  using (
    bucket_id = 'student-photos'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'student-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Faculty delete own photos"
  on storage.objects for delete
  using (
    bucket_id = 'student-photos'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Students may read only the photo whose filename (without extension)
-- matches their own student UUID, and only if that student record
-- belongs to their authenticated email.
create policy "Students read own photo"
  on storage.objects for select
  using (
    bucket_id = 'student-photos'
    and auth.uid() is not null
    and exists (
      select 1 from public.students
      where  id    = (split_part(storage.filename(name), '.', 1))::uuid
        and  email = auth.email()
    )
  );
