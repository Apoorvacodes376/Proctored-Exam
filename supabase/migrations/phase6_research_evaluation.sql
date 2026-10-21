-- ============================================================
-- phase6_research_evaluation.sql
-- ProctorAI — Phase 6: Research, Audit & Evaluation
--
-- Covers:
--   • public.audit_log       — append-only compliance log of all
--                              significant system actions
--   • public.system_metrics  — per-exam aggregate stats for
--                              research export and dashboards
--   • public.feedback        — post-exam student feedback
--   • log_audit_event()      — helper function for audit inserts
--   • refresh_system_metrics() — aggregate function for metrics
--   • RLS policies for all three tables
--
-- Depends on: all prior phases (1–5)
-- This is the final phase; nothing depends on it.
-- ============================================================


-- ============================================================
-- 1. AUDIT LOG
-- Append-only record of significant actions for compliance.
-- Rows are never updated or deleted (enforced by RLS).
-- actor_id: the auth.uid() of the user who performed the action
-- target_table / target_id: the affected record
-- action: free-form verb (e.g. 'exam.created', 'session.submitted')
-- ============================================================

create table if not exists public.audit_log (
  id           uuid        primary key default gen_random_uuid(),
  actor_id     uuid        references public.profiles(id) on delete set null,
  actor_role   text,                    -- snapshot of role at time of action
  action       text        not null,    -- e.g. 'exam.created', 'event.flagged'
  target_table text,                    -- e.g. 'exams', 'proctoring_events'
  target_id    uuid,                    -- PK of the affected row
  metadata     jsonb,                   -- arbitrary context (diff, IP, etc.)
  occurred_at  timestamptz not null default now()
);

-- Audit log is append-only: no updated_at, no update trigger.
create index if not exists audit_log_actor_idx      on public.audit_log (actor_id);
create index if not exists audit_log_action_idx     on public.audit_log (action);
create index if not exists audit_log_target_idx     on public.audit_log (target_table, target_id);
create index if not exists audit_log_occurred_idx   on public.audit_log (occurred_at);


-- ============================================================
-- 2. SYSTEM METRICS
-- Aggregated per-exam statistics. Refreshed by the backend
-- after each exam session closes. Used for research export
-- and the faculty analytics dashboard.
-- ============================================================

create table if not exists public.system_metrics (
  id                    uuid         primary key default gen_random_uuid(),
  exam_id               uuid         not null unique
                          references public.exams(id) on delete cascade,
  total_sessions        integer      not null default 0,
  submitted_sessions    integer      not null default 0,
  flagged_sessions      integer      not null default 0,
  avg_score             numeric(5,2),
  avg_risk_score        numeric(5,4),
  total_events          integer      not null default 0,
  critical_events       integer      not null default 0,
  avg_duration_mins     numeric(6,2),
  last_refreshed_at     timestamptz  not null default now(),
  created_at            timestamptz  not null default now(),
  updated_at            timestamptz  not null default now()
);

create index if not exists system_metrics_exam_idx on public.system_metrics (exam_id);

drop trigger if exists system_metrics_updated_at on public.system_metrics;
create trigger system_metrics_updated_at
  before update on public.system_metrics
  for each row execute procedure public.set_updated_at();


-- ============================================================
-- 3. FEEDBACK
-- Post-exam student feedback. Optional; submitted after the
-- exam session is closed.
-- rating: 1–5 stars
-- ============================================================

create table if not exists public.feedback (
  id           uuid        primary key default gen_random_uuid(),
  session_id   uuid        not null unique
                 references public.exam_sessions(id) on delete cascade,
  student_id   uuid        not null references public.students(id) on delete cascade,
  exam_id      uuid        not null references public.exams(id)    on delete cascade,
  rating       smallint    check (rating between 1 and 5),
  comments     text,
  submitted_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index if not exists feedback_exam_idx     on public.feedback (exam_id);
create index if not exists feedback_student_idx  on public.feedback (student_id);


-- ============================================================
-- 4. FUNCTION: log_audit_event
-- Convenience wrapper called by backend services and database
-- triggers to append a row to audit_log.
-- ============================================================

create or replace function public.log_audit_event(
  p_actor_id     uuid,
  p_actor_role   text,
  p_action       text,
  p_target_table text  default null,
  p_target_id    uuid  default null,
  p_metadata     jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_log
    (actor_id, actor_role, action, target_table, target_id, metadata)
  values
    (p_actor_id, p_actor_role, p_action, p_target_table, p_target_id, p_metadata);
end;
$$;


-- ============================================================
-- 5. FUNCTION: refresh_system_metrics
-- Recomputes the system_metrics row for a given exam.
-- Called by the backend after each session closes.
-- ============================================================

create or replace function public.refresh_system_metrics(p_exam_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total       integer;
  v_submitted   integer;
  v_flagged     integer;
  v_avg_score   numeric(5,2);
  v_avg_risk    numeric(5,4);
  v_total_ev    integer;
  v_crit_ev     integer;
  v_avg_dur     numeric(6,2);
begin
  select
    count(*)                                                    as total,
    count(*) filter (where es.status = 'submitted')             as submitted,
    count(*) filter (where es.status = 'flagged')               as flagged,
    round(avg(er.marks_obtained)::numeric, 2)                   as avg_score,
    round(avg(rs.overall_score)::numeric, 4)                    as avg_risk,
    coalesce(sum(pe_counts.ev_total), 0)                        as total_events,
    coalesce(sum(pe_counts.ev_critical), 0)                     as critical_events,
    round(avg(
      extract(epoch from (es.submitted_at - es.started_at)) / 60
    )::numeric, 2)                                              as avg_duration
  into
    v_total, v_submitted, v_flagged,
    v_avg_score, v_avg_risk,
    v_total_ev, v_crit_ev,
    v_avg_dur
  from public.exam_sessions es
  left join public.exam_results       er  on er.session_id = es.id
  left join public.risk_scores        rs  on rs.exam_session_id = es.id
  left join (
    select
      ps.exam_session_id,
      count(*)                                        as ev_total,
      count(*) filter (where pe.severity = 'critical') as ev_critical
    from public.proctoring_sessions ps
    join public.proctoring_events   pe on pe.proctoring_session_id = ps.id
    group by ps.exam_session_id
  ) pe_counts on pe_counts.exam_session_id = es.id
  where es.exam_id = p_exam_id;

  insert into public.system_metrics
    (exam_id, total_sessions, submitted_sessions, flagged_sessions,
     avg_score, avg_risk_score, total_events, critical_events,
     avg_duration_mins, last_refreshed_at)
  values
    (p_exam_id, coalesce(v_total,0), coalesce(v_submitted,0), coalesce(v_flagged,0),
     v_avg_score, v_avg_risk, coalesce(v_total_ev,0), coalesce(v_crit_ev,0),
     v_avg_dur, now())
  on conflict (exam_id) do update
    set total_sessions     = excluded.total_sessions,
        submitted_sessions = excluded.submitted_sessions,
        flagged_sessions   = excluded.flagged_sessions,
        avg_score          = excluded.avg_score,
        avg_risk_score     = excluded.avg_risk_score,
        total_events       = excluded.total_events,
        critical_events    = excluded.critical_events,
        avg_duration_mins  = excluded.avg_duration_mins,
        last_refreshed_at  = excluded.last_refreshed_at,
        updated_at         = now();
end;
$$;


-- ============================================================
-- 6. RLS — AUDIT LOG
-- ============================================================

alter table public.audit_log enable row level security;

drop policy if exists "Authenticated users insert audit events" on public.audit_log;
drop policy if exists "Faculty read audit log"                  on public.audit_log;

-- Any authenticated user (or backend service) may append events.
-- No UPDATE or DELETE policies — the log is append-only by design.
create policy "Authenticated users insert audit events"
  on public.audit_log for insert
  with check (auth.uid() is not null);

-- Faculty may read audit events related to their own exams.
-- Broad read is intentionally restricted: faculty see only rows
-- where target_table = 'exams' and target_id is one of their exams,
-- OR where they are the actor.
create policy "Faculty read audit log"
  on public.audit_log for select
  using (
    actor_id = auth.uid()
    or (
      target_table = 'exams'
      and exists (
        select 1 from public.exams
        where  id = audit_log.target_id
          and  faculty_id = auth.uid()
      )
    )
  );


-- ============================================================
-- 7. RLS — SYSTEM METRICS
-- ============================================================

alter table public.system_metrics enable row level security;

drop policy if exists "Faculty view metrics for own exams" on public.system_metrics;
drop policy if exists "Backend manage system metrics"      on public.system_metrics;

-- Faculty: read metrics for their own exams.
create policy "Faculty view metrics for own exams"
  on public.system_metrics for select
  using (
    exists (
      select 1 from public.exams
      where  id = system_metrics.exam_id and faculty_id = auth.uid()
    )
  );

-- Backend: full management (upsert from refresh_system_metrics).
create policy "Backend manage system metrics"
  on public.system_metrics for all
  using     (auth.uid() is not null)
  with check (auth.uid() is not null);


-- ============================================================
-- 8. RLS — FEEDBACK
-- ============================================================

alter table public.feedback enable row level security;

drop policy if exists "Students submit own feedback"       on public.feedback;
drop policy if exists "Faculty view feedback for exams"    on public.feedback;

-- Students: insert their own feedback (one per session, enforced by unique).
create policy "Students submit own feedback"
  on public.feedback for insert
  with check (
    exists (
      select 1 from public.students
      where  id    = feedback.student_id
        and  email = auth.email()
    )
  );

-- Students: read their own submitted feedback.
create policy "Students view own feedback"
  on public.feedback for select
  using (
    exists (
      select 1 from public.students
      where  id    = feedback.student_id
        and  email = auth.email()
    )
  );

-- Faculty: read feedback for their own exams.
create policy "Faculty view feedback for exams"
  on public.feedback for select
  using (
    exists (
      select 1 from public.exams
      where  id = feedback.exam_id and faculty_id = auth.uid()
    )
  );
