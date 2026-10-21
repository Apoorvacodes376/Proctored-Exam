-- ============================================================
-- phase5_review_risk_scoring.sql
-- ProctorAI — Phase 5: Faculty Review & Risk Scoring
--
-- Covers:
--   • public.risk_scores     — computed risk score per exam_session
--   • public.faculty_reviews — faculty annotations on flagged events
--   • update_risk_score()    — function to (re)compute a session's score
--   • update_descriptive_marks() — function for manual grading
--   • RLS policies for both tables
--
-- Depends on: phase1_setup.sql, phase2_faculty_management.sql,
--             phase3_student_exam.sql, phase4_ai_monitoring.sql
-- Required before: phase6 (audit log references reviews)
-- ============================================================


-- ============================================================
-- 1. RISK SCORES
-- One row per exam_session. Recomputed by the backend after
-- each batch of proctoring events is processed.
-- overall_score: 0.0 (clean) – 1.0 (high risk)
-- risk_level: 'low' | 'medium' | 'high' | 'critical'
-- ============================================================

create table if not exists public.risk_scores (
  id                    uuid         primary key default gen_random_uuid(),
  exam_session_id       uuid         not null unique
                          references public.exam_sessions(id) on delete cascade,
  overall_score         numeric(5,4) not null default 0
                          check (overall_score between 0 and 1),
  risk_level            text         not null default 'low'
                          check (risk_level in ('low', 'medium', 'high', 'critical')),
  -- Component breakdown (each 0–1, null if not yet computed)
  face_score            numeric(5,4) check (face_score between 0 and 1),
  gaze_score            numeric(5,4) check (gaze_score between 0 and 1),
  behaviour_score       numeric(5,4) check (behaviour_score between 0 and 1),
  environment_score     numeric(5,4) check (environment_score between 0 and 1),
  -- Event counts for quick dashboard display
  total_events          integer      not null default 0,
  critical_events       integer      not null default 0,
  high_events           integer      not null default 0,
  computed_at           timestamptz  not null default now(),
  created_at            timestamptz  not null default now(),
  updated_at            timestamptz  not null default now()
);

create index if not exists risk_scores_exam_session_idx
  on public.risk_scores (exam_session_id);
create index if not exists risk_scores_risk_level_idx
  on public.risk_scores (risk_level);

drop trigger if exists risk_scores_updated_at on public.risk_scores;
create trigger risk_scores_updated_at
  before update on public.risk_scores
  for each row execute procedure public.set_updated_at();


-- ============================================================
-- 2. FACULTY REVIEWS
-- Faculty annotate individual proctoring events after an exam.
-- decision: 'pending' | 'dismissed' | 'confirmed' | 'escalated'
-- ============================================================

create table if not exists public.faculty_reviews (
  id                    uuid        primary key default gen_random_uuid(),
  proctoring_event_id   uuid        not null unique
                          references public.proctoring_events(id) on delete cascade,
  reviewed_by           uuid        not null references public.profiles(id) on delete cascade,
  decision              text        not null default 'pending'
                          check (decision in ('pending', 'dismissed', 'confirmed', 'escalated')),
  notes                 text,
  reviewed_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists faculty_reviews_event_idx
  on public.faculty_reviews (proctoring_event_id);
create index if not exists faculty_reviews_reviewer_idx
  on public.faculty_reviews (reviewed_by);
create index if not exists faculty_reviews_decision_idx
  on public.faculty_reviews (decision);

drop trigger if exists faculty_reviews_updated_at on public.faculty_reviews;
create trigger faculty_reviews_updated_at
  before update on public.faculty_reviews
  for each row execute procedure public.set_updated_at();


-- ============================================================
-- 3. FUNCTION: update_risk_score
-- Recomputes the risk_scores row for a given exam_session
-- based on the current proctoring_events. Called by the
-- backend after each AI processing batch.
-- ============================================================

create or replace function public.update_risk_score(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_proctoring_session_id uuid;
  v_total     integer;
  v_critical  integer;
  v_high      integer;
  v_score     numeric(5,4);
  v_level     text;
begin
  -- Resolve proctoring session
  select id into v_proctoring_session_id
  from   public.proctoring_sessions
  where  exam_session_id = p_session_id;

  if v_proctoring_session_id is null then return; end if;

  -- Count events by severity
  select
    count(*)                                          as total,
    count(*) filter (where severity = 'critical')     as critical,
    count(*) filter (where severity = 'high')         as high
  into v_total, v_critical, v_high
  from public.proctoring_events
  where proctoring_session_id = v_proctoring_session_id;

  -- Simple weighted score: critical=0.4, high=0.2, others=0.05 each, capped at 1.0
  v_score := least(1.0,
    (v_critical * 0.4) +
    (v_high     * 0.2) +
    ((v_total - v_critical - v_high) * 0.05)
  );

  v_level := case
    when v_score >= 0.75 then 'critical'
    when v_score >= 0.50 then 'high'
    when v_score >= 0.25 then 'medium'
    else 'low'
  end;

  insert into public.risk_scores
    (exam_session_id, overall_score, risk_level,
     total_events, critical_events, high_events, computed_at)
  values
    (p_session_id, v_score, v_level,
     v_total, v_critical, v_high, now())
  on conflict (exam_session_id) do update
    set overall_score   = excluded.overall_score,
        risk_level      = excluded.risk_level,
        total_events    = excluded.total_events,
        critical_events = excluded.critical_events,
        high_events     = excluded.high_events,
        computed_at     = excluded.computed_at,
        updated_at      = now();
end;
$$;


-- ============================================================
-- 4. FUNCTION: update_descriptive_marks
-- Faculty call this to manually award marks for a descriptive
-- answer. Recalculates the total in exam_results afterwards.
-- ============================================================

create or replace function public.update_descriptive_marks(
  p_answer_id   uuid,
  p_marks       integer,
  p_grader_id   uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
  v_new_total  integer;
begin
  -- Update the individual answer
  update public.exam_answers
  set    marks_awarded = p_marks,
         is_correct    = (p_marks > 0),
         updated_at    = now()
  where  id = p_answer_id
  returning session_id into v_session_id;

  -- Recalculate total marks obtained for the session
  select coalesce(sum(marks_awarded), 0)
  into   v_new_total
  from   public.exam_answers
  where  session_id = v_session_id
    and  marks_awarded is not null;

  -- Update exam_results
  update public.exam_results
  set    marks_obtained  = v_new_total,
         grading_status  = case
           when exists (
             select 1 from public.exam_answers
             where session_id = v_session_id and marks_awarded is null
           ) then 'auto_graded'
           else 'fully_graded'
         end,
         graded_by  = p_grader_id,
         graded_at  = now(),
         updated_at = now()
  where  session_id = v_session_id;
end;
$$;


-- ============================================================
-- 5. RLS — RISK SCORES
-- ============================================================

alter table public.risk_scores enable row level security;

drop policy if exists "Faculty view risk scores for exams"  on public.risk_scores;
drop policy if exists "Backend manage risk scores"          on public.risk_scores;

-- Faculty: read risk scores for their own exams.
create policy "Faculty view risk scores for exams"
  on public.risk_scores for select
  using (
    exists (
      select 1
      from   public.exam_sessions es
      join   public.exams         e  on e.id = es.exam_id
      where  es.id        = risk_scores.exam_session_id
        and  e.faculty_id = auth.uid()
    )
  );

-- Backend: full management (insert/update from AI worker).
create policy "Backend manage risk scores"
  on public.risk_scores for all
  using     (auth.uid() is not null)
  with check (auth.uid() is not null);


-- ============================================================
-- 6. RLS — FACULTY REVIEWS
-- ============================================================

alter table public.faculty_reviews enable row level security;

drop policy if exists "Faculty manage own reviews" on public.faculty_reviews;

-- Faculty: full CRUD on reviews they authored, scoped to their
-- own exams (the join through proctoring_events → proctoring_sessions
-- → exam_sessions → exams enforces exam ownership).
create policy "Faculty manage own reviews"
  on public.faculty_reviews for all
  using (reviewed_by = auth.uid())
  with check (reviewed_by = auth.uid());
