-- ============================================================
-- phase3_student_exam.sql
-- ProctorAI — Phase 3: Student Exam Taking
--
-- Covers:
--   • public.exam_sessions  — one row per student sitting an exam
--   • public.exam_answers   — one row per question answered
--   • public.exam_results   — final score and grading status
--   • updated_at triggers for exam_sessions and exam_results
--   • RLS policies for all three tables
--
-- Depends on: phase1_setup.sql, phase2_faculty_management.sql
-- Required before: phase4 (proctoring links to exam_sessions)
-- ============================================================


-- ============================================================
-- 1. EXAM SESSIONS
-- One row is created when a student starts an exam.
-- status: 'in_progress' | 'submitted' | 'timed_out' | 'flagged'
-- ============================================================

create table if not exists public.exam_sessions (
  id              uuid        primary key default gen_random_uuid(),
  exam_id         uuid        not null references public.exams(id)            on delete cascade,
  student_id      uuid        not null references public.students(id)         on delete cascade,
  assignment_id   uuid        not null references public.exam_assignments(id) on delete cascade,
  status          text        not null default 'in_progress'
                    check (status in ('in_progress', 'submitted', 'timed_out', 'flagged')),
  started_at      timestamptz not null default now(),
  submitted_at    timestamptz,
  ip_address      text,                  -- recorded at session start for audit
  user_agent      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- A student may only have one active session per exam.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.exam_sessions'::regclass
      and conname  = 'exam_sessions_exam_id_student_id_key'
  ) then
    alter table public.exam_sessions
      add constraint exam_sessions_exam_id_student_id_key
      unique (exam_id, student_id);
  end if;
end;
$$;

create index if not exists exam_sessions_exam_id_idx     on public.exam_sessions (exam_id);
create index if not exists exam_sessions_student_id_idx  on public.exam_sessions (student_id);
create index if not exists exam_sessions_status_idx      on public.exam_sessions (status);

drop trigger if exists exam_sessions_updated_at on public.exam_sessions;
create trigger exam_sessions_updated_at
  before update on public.exam_sessions
  for each row execute procedure public.set_updated_at();


-- ============================================================
-- 2. EXAM ANSWERS
-- One row per question per session. Upserted as the student
-- progresses; final state is read at grading time.
-- ============================================================

create table if not exists public.exam_answers (
  id              uuid        primary key default gen_random_uuid(),
  session_id      uuid        not null references public.exam_sessions(id) on delete cascade,
  question_id     uuid        not null references public.questions(id)     on delete cascade,
  answer_text     text,                  -- free text for descriptive; option index for MCQ
  is_correct      boolean,               -- null until auto-graded (MCQ) or manually graded
  marks_awarded   integer,               -- null until graded
  answered_at     timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One answer row per question per session.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.exam_answers'::regclass
      and conname  = 'exam_answers_session_id_question_id_key'
  ) then
    alter table public.exam_answers
      add constraint exam_answers_session_id_question_id_key
      unique (session_id, question_id);
  end if;
end;
$$;

create index if not exists exam_answers_session_id_idx  on public.exam_answers (session_id);
create index if not exists exam_answers_question_id_idx on public.exam_answers (question_id);

drop trigger if exists exam_answers_updated_at on public.exam_answers;
create trigger exam_answers_updated_at
  before update on public.exam_answers
  for each row execute procedure public.set_updated_at();


-- ============================================================
-- 3. EXAM RESULTS
-- One row per session, written when the exam is submitted or
-- timed out. MCQ marks are auto-calculated; descriptive marks
-- are filled in by faculty during Phase 5 review.
-- grading_status: 'pending' | 'auto_graded' | 'fully_graded'
-- ============================================================

create table if not exists public.exam_results (
  id               uuid        primary key default gen_random_uuid(),
  session_id       uuid        not null unique references public.exam_sessions(id) on delete cascade,
  exam_id          uuid        not null references public.exams(id)    on delete cascade,
  student_id       uuid        not null references public.students(id) on delete cascade,
  total_marks      integer     not null default 0,   -- max possible (copied from exam)
  marks_obtained   integer     not null default 0,
  percentage       numeric(5,2) generated always as (
                     case when total_marks > 0
                          then round((marks_obtained::numeric / total_marks) * 100, 2)
                          else 0
                     end
                   ) stored,
  grading_status   text        not null default 'pending'
                     check (grading_status in ('pending', 'auto_graded', 'fully_graded')),
  graded_by        uuid        references public.profiles(id) on delete set null,
  graded_at        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists exam_results_session_id_idx  on public.exam_results (session_id);
create index if not exists exam_results_exam_id_idx     on public.exam_results (exam_id);
create index if not exists exam_results_student_id_idx  on public.exam_results (student_id);

drop trigger if exists exam_results_updated_at on public.exam_results;
create trigger exam_results_updated_at
  before update on public.exam_results
  for each row execute procedure public.set_updated_at();


-- ============================================================
-- 4. FUNCTION: auto_grade_session
-- Called after a session is submitted. Scores all MCQ answers
-- automatically and writes an exam_results row.
-- Descriptive questions are left with marks_awarded = null.
-- ============================================================

create or replace function public.auto_grade_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exam_id      uuid;
  v_student_id   uuid;
  v_total_marks  integer;
  v_mcq_score    integer := 0;
begin
  -- Fetch session context
  select exam_id, student_id
  into   v_exam_id, v_student_id
  from   public.exam_sessions
  where  id = p_session_id;

  -- Total marks from exam definition
  select total_marks into v_total_marks
  from   public.exams
  where  id = v_exam_id;

  -- Auto-grade MCQ answers
  update public.exam_answers ea
  set
    is_correct    = (ea.answer_text = q.correct_answer),
    marks_awarded = case when ea.answer_text = q.correct_answer then q.marks else 0 end,
    updated_at    = now()
  from public.questions q
  where ea.question_id = q.id
    and ea.session_id  = p_session_id
    and q.question_type = 'mcq';

  -- Sum MCQ marks
  select coalesce(sum(marks_awarded), 0)
  into   v_mcq_score
  from   public.exam_answers
  where  session_id = p_session_id
    and  is_correct is not null;

  -- Upsert result row
  insert into public.exam_results
    (session_id, exam_id, student_id, total_marks, marks_obtained, grading_status)
  values
    (p_session_id, v_exam_id, v_student_id, v_total_marks, v_mcq_score, 'auto_graded')
  on conflict (session_id) do update
    set marks_obtained  = excluded.marks_obtained,
        grading_status  = excluded.grading_status,
        updated_at      = now();
end;
$$;


-- ============================================================
-- 5. RLS — EXAM SESSIONS
-- ============================================================

alter table public.exam_sessions enable row level security;

drop policy if exists "Students manage own session"       on public.exam_sessions;
drop policy if exists "Faculty view sessions for exams"   on public.exam_sessions;

-- Students: insert and update their own session rows only.
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

-- Faculty: read-only access to sessions for their own exams.
create policy "Faculty view sessions for exams"
  on public.exam_sessions for select
  using (
    exists (
      select 1 from public.exams
      where  id = exam_sessions.exam_id and faculty_id = auth.uid()
    )
  );


-- ============================================================
-- 6. RLS — EXAM ANSWERS
-- ============================================================

alter table public.exam_answers enable row level security;

drop policy if exists "Students manage own answers"     on public.exam_answers;
drop policy if exists "Faculty view answers for exams"  on public.exam_answers;

-- Students: full access to their own answer rows (via session ownership).
create policy "Students manage own answers"
  on public.exam_answers for all
  using (
    exists (
      select 1
      from   public.exam_sessions es
      join   public.students      s  on s.id = es.student_id
      where  es.id    = exam_answers.session_id
        and  s.email  = auth.email()
    )
  )
  with check (
    exists (
      select 1
      from   public.exam_sessions es
      join   public.students      s  on s.id = es.student_id
      where  es.id    = exam_answers.session_id
        and  s.email  = auth.email()
    )
  );

-- Faculty: read-only access to answers for their own exams.
create policy "Faculty view answers for exams"
  on public.exam_answers for select
  using (
    exists (
      select 1
      from   public.exam_sessions es
      join   public.exams         e  on e.id = es.exam_id
      where  es.id          = exam_answers.session_id
        and  e.faculty_id   = auth.uid()
    )
  );


-- ============================================================
-- 7. RLS — EXAM RESULTS
-- ============================================================

alter table public.exam_results enable row level security;

drop policy if exists "Students view own result"        on public.exam_results;
drop policy if exists "Faculty manage results for exams" on public.exam_results;

-- Students: read-only access to their own result.
create policy "Students view own result"
  on public.exam_results for select
  using (
    exists (
      select 1 from public.students
      where  id    = exam_results.student_id
        and  email = auth.email()
    )
  );

-- Faculty: full access to results for their own exams
-- (needed for manual grading of descriptive questions in Phase 5).
create policy "Faculty manage results for exams"
  on public.exam_results for all
  using (
    exists (
      select 1 from public.exams
      where  id = exam_results.exam_id and faculty_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.exams
      where  id = exam_results.exam_id and faculty_id = auth.uid()
    )
  );
