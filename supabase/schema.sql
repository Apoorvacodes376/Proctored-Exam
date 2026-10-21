-- ============================================================
-- ProctorAI - Supabase Schema (Phase 1)
-- Run this in the Supabase SQL Editor
-- ============================================================

-- Profiles table (extends auth.users)
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text unique not null,
  email       text not null,
  role        text not null default 'student' check (role in ('student', 'faculty')),
  created_at  timestamptz default now()
);

-- Auto-create profile on new user signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    new.email,
    coalesce(new.raw_user_meta_data->>'role', 'student')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- Row Level Security - Profiles
-- ============================================================

alter table public.profiles enable row level security;

create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id and role = (select role from public.profiles where id = auth.uid()));

create policy "Faculty can view student profiles"
  on public.profiles for select
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role = 'faculty'
    )
  );

-- ============================================================
-- Phase 2: Student Records
-- ============================================================

create table if not exists public.students (
  id            uuid primary key default gen_random_uuid(),
  faculty_id    uuid not null references public.profiles(id) on delete cascade,
  name          text not null,
  email         text not null,
  student_id    text not null,
  photo_url     text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  unique (faculty_id, student_id),
  unique (faculty_id, email)
);

alter table public.students enable row level security;

create policy "Faculty manage own students"
  on public.students for all
  using (faculty_id = auth.uid())
  with check (faculty_id = auth.uid());

create policy "Students view own record"
  on public.students for select
  using (
    email = (select email from public.profiles where id = auth.uid())
  );

-- ============================================================
-- Phase 2: Exams
-- ============================================================

create table if not exists public.exams (
  id            uuid primary key default gen_random_uuid(),
  faculty_id    uuid not null references public.profiles(id) on delete cascade,
  title         text not null,
  subject       text not null,
  exam_date     date not null,
  start_time    time not null,
  duration_mins integer not null check (duration_mins > 0),
  total_marks   integer not null default 0,
  instructions  text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

alter table public.exams enable row level security;

create policy "Faculty manage own exams"
  on public.exams for all
  using (faculty_id = auth.uid())
  with check (faculty_id = auth.uid());

create policy "Students view assigned exams"
  on public.exams for select
  using (
    exists (
      select 1 from public.exam_assignments ea
      join public.students s on s.id = ea.student_id
      where ea.exam_id = exams.id
        and s.email = (select email from public.profiles where id = auth.uid())
    )
  );

-- ============================================================
-- Phase 2: Questions
-- ============================================================

create table if not exists public.questions (
  id              uuid primary key default gen_random_uuid(),
  exam_id         uuid not null references public.exams(id) on delete cascade,
  question_text   text not null,
  question_type   text not null check (question_type in ('mcq', 'descriptive')),
  options         jsonb,           -- array of strings for MCQ
  correct_answer  text,            -- option index (0-3) for MCQ
  marks           integer not null default 1,
  order_index     integer not null default 0,
  created_at      timestamptz default now()
);

alter table public.questions enable row level security;

create policy "Faculty manage questions for own exams"
  on public.questions for all
  using (
    exists (
      select 1 from public.exams
      where id = questions.exam_id and faculty_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.exams
      where id = questions.exam_id and faculty_id = auth.uid()
    )
  );

create policy "Students view questions for assigned exams"
  on public.questions for select
  using (
    exists (
      select 1 from public.exam_assignments ea
      join public.students s on s.id = ea.student_id
      join public.exams e on e.id = questions.exam_id
      where ea.exam_id = questions.exam_id
        and s.email = (select email from public.profiles where id = auth.uid())
    )
  );

-- ============================================================
-- Phase 2: Exam Assignments (student <-> exam)
-- ============================================================

create table if not exists public.exam_assignments (
  id          uuid primary key default gen_random_uuid(),
  exam_id     uuid not null references public.exams(id) on delete cascade,
  student_id  uuid not null references public.students(id) on delete cascade,
  assigned_at timestamptz default now(),
  unique (exam_id, student_id)
);

alter table public.exam_assignments enable row level security;

create policy "Faculty manage assignments for own exams"
  on public.exam_assignments for all
  using (
    exists (
      select 1 from public.exams
      where id = exam_assignments.exam_id and faculty_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.exams
      where id = exam_assignments.exam_id and faculty_id = auth.uid()
    )
  );

create policy "Students view own assignments"
  on public.exam_assignments for select
  using (
    exists (
      select 1 from public.students
      where id = exam_assignments.student_id
        and email = (select email from public.profiles where id = auth.uid())
    )
  );

-- ============================================================
-- Auto-update updated_at timestamps
-- ============================================================

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger students_updated_at before update on public.students
  for each row execute procedure public.set_updated_at();

create trigger exams_updated_at before update on public.exams
  for each row execute procedure public.set_updated_at();

-- ============================================================
-- Storage bucket for student reference photos
-- Run this block once in Supabase SQL Editor
-- ============================================================
insert into storage.buckets (id, name, public)
values ('student-photos', 'student-photos', false)
on conflict (id) do nothing;

create policy "Faculty upload photos"
  on storage.objects for insert
  with check (bucket_id = 'student-photos' and auth.role() = 'authenticated');

create policy "Faculty read photos"
  on storage.objects for select
  using (bucket_id = 'student-photos' and auth.role() = 'authenticated');

create policy "Faculty delete photos"
  on storage.objects for delete
  using (bucket_id = 'student-photos' and auth.role() = 'authenticated');
