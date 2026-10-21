-- ============================================================
-- phase6_patch_integrity_evaluation.sql
-- ProctorAI — Phase 6 patch: exam integrity fixes + research evaluation
--
-- Run AFTER phase6_research_evaluation.sql (and therefore after the
-- phase 2, 4 and 5 patches). Idempotent; safe to re-run.
--
-- Part A — fixes for problems found while writing the Phase 6 tests
--   A1. exams.time_zone + exam_window(): the scheduled window can be
--       enforced server-side (it was only checked in the browser)
--   A2. exam_sessions: students can no longer delete their session (which
--       cascaded to the proctoring evidence), reopen a submitted session,
--       backdate started_at, or start a session for an exam they are not
--       assigned to / outside the scheduled window
--   A3. exam_answers: students could write is_correct / marks_awarded on
--       their own answers (auto_grade_session then summed them) and could
--       keep changing answers after submitting or after time ran out
--   A4. grading runs automatically when a session closes;
--       auto_grade_session() now checks the caller; finalize_expired_sessions()
--       auto-submits sessions whose browser never came back
--   A5. update_descriptive_marks() let ANY signed-in user set marks on ANY
--       answer; now exam-owner only, closed sessions only, 0..question marks
--   A6. questions: students could read correct_answer through the API.
--       Students now load questions via get_exam_questions(), which omits it
--   A7. profiles: "Users can update own profile" compared against the JWT
--       'role' claim, which in Supabase is 'authenticated', so the check
--       never matched; it now compares against the stored role
--   A8. phase 6 base: audit rows could be forged with any actor_id;
--       system_metrics was writable by any user; refresh_system_metrics()
--       and log_audit_event() were callable by anyone; feedback could be
--       attached to someone else's session
--
-- Part B — research evaluation storage (all faculty-owned, students have
-- no access)
--   B1. evaluation_trials        ground-truth annotation of a session,
--                                with its provenance (live / scripted / simulated)
--   B2. ground_truth_intervals   when a behaviour actually happened
--   B3. identity_ground_truth    genuine vs impostor label per verification attempt
--   B4. monitoring_performance   per-module processing latency measured in
--                                the student's browser
--   B5. model_evaluations        imported model cards from
--                                backend/ml/train_risk_model.py
--   B6. compute_risk_breakdown_ex(..., p_ignore_reviews) and
--       risk_evaluation_data(): scores recomputed WITHOUT faculty
--       dismissals, so evaluating the score against faculty outcomes does
--       not leak the reviewers' own decisions into the score
-- ============================================================


-- ============================================================
-- 0. SHARED HELPERS
-- ============================================================

-- Late answers/submissions within this margin are accepted (network delay).
create or replace function public.submission_grace()
returns interval language sql immutable as $$ select interval '2 minutes' $$;

-- Stored role of a user (security definer: no RLS recursion on profiles).
create or replace function public.profile_role(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$ select role from public.profiles where id = p_user $$;

revoke all on function public.profile_role(uuid) from public, anon;
grant execute on function public.profile_role(uuid) to authenticated;


-- ============================================================
-- A1. EXAM TIME ZONE + SCHEDULED WINDOW
-- exam_date/start_time are stored without a time zone. The faculty
-- form now records the browser's IANA zone (e.g. 'Asia/Kolkata'); when
-- it is set the server enforces the window. Exams without a zone keep
-- the old behaviour (window checked in the browser only).
-- ============================================================

alter table public.exams add column if not exists time_zone text;

create or replace function public.validate_exam_time_zone()
returns trigger
language plpgsql
as $$
begin
  if new.time_zone is not null
     and not exists (select 1 from pg_timezone_names where name = new.time_zone) then
    raise exception 'unknown time zone: %', new.time_zone using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists exams_validate_time_zone on public.exams;
create trigger exams_validate_time_zone
  before insert or update of time_zone on public.exams
  for each row execute procedure public.validate_exam_time_zone();

create or replace function public.exam_window(
  p_exam_id uuid, out starts_at timestamptz, out ends_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select (e.exam_date + e.start_time) at time zone e.time_zone,
         ((e.exam_date + e.start_time) at time zone e.time_zone) + make_interval(mins => e.duration_mins)
  from   public.exams e
  where  e.id = p_exam_id and e.time_zone is not null
$$;

revoke all on function public.exam_window(uuid) from public, anon;
grant execute on function public.exam_window(uuid) to authenticated;


-- ============================================================
-- A2. EXAM SESSIONS — server-side rules for student writes
-- The guard only applies to direct client writes (current_user =
-- authenticated/anon). Security-definer functions (grading,
-- finalize_expired_sessions) and the service role are not affected.
-- ============================================================

create or replace function public.assignment_matches(p_assignment uuid, p_exam uuid, p_student uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- Answers only about the caller's own student records.
  select exists (select 1 from public.exam_assignments a join public.students s on s.id = a.student_id
                 where a.id = p_assignment and a.exam_id = p_exam and a.student_id = p_student
                   and s.email = auth.email())
$$;
-- Called by the (invoker) guard trigger, so the API role needs EXECUTE.
revoke all on function public.assignment_matches(uuid, uuid, uuid) from public, anon;
grant execute on function public.assignment_matches(uuid, uuid, uuid) to authenticated;

create or replace function public.guard_exam_session()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  w record;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if not public.assignment_matches(new.assignment_id, new.exam_id, new.student_id) then
      raise exception 'You are not assigned to this exam.' using errcode = '42501';
    end if;
    if new.status <> 'in_progress' then
      raise exception 'A new exam session must start in progress.' using errcode = '42501';
    end if;
    select * into w from public.exam_window(new.exam_id);
    if w.starts_at is not null and (now() < w.starts_at or now() > w.ends_at) then
      raise exception 'This exam is outside its scheduled window (% – %).', w.starts_at, w.ends_at
        using errcode = '42501';
    end if;
    new.started_at   := now();   -- server time; the client cannot backdate
    new.submitted_at := null;
    return new;
  end if;

  -- UPDATE
  if old.status <> 'in_progress' then
    raise exception 'This exam session is closed.' using errcode = '42501';
  end if;
  if new.exam_id is distinct from old.exam_id
     or new.student_id is distinct from old.student_id
     or new.assignment_id is distinct from old.assignment_id
     or new.started_at is distinct from old.started_at
     or new.created_at is distinct from old.created_at then
    raise exception 'Exam session details cannot be changed.' using errcode = '42501';
  end if;
  if new.status not in ('in_progress', 'submitted', 'timed_out') then
    raise exception 'Students can only submit their session.' using errcode = '42501';
  end if;
  new.submitted_at := case when new.status = 'in_progress' then null else now() end;
  return new;
end;
$$;

drop trigger if exists exam_sessions_guard on public.exam_sessions;
create trigger exam_sessions_guard
  before insert or update on public.exam_sessions
  for each row execute procedure public.guard_exam_session();

-- "for all" let students DELETE their session (and with it, by cascade,
-- every proctoring event and evidence reference).
drop policy if exists "Students manage own session" on public.exam_sessions;
drop policy if exists "Students view own session"   on public.exam_sessions;
drop policy if exists "Students start own session"  on public.exam_sessions;
drop policy if exists "Students submit own session" on public.exam_sessions;

create policy "Students view own session"
  on public.exam_sessions for select
  using (exists (select 1 from public.students where id = exam_sessions.student_id and email = auth.email()));

create policy "Students start own session"
  on public.exam_sessions for insert
  with check (exists (select 1 from public.students where id = exam_sessions.student_id and email = auth.email()));

create policy "Students submit own session"
  on public.exam_sessions for update
  using      (exists (select 1 from public.students where id = exam_sessions.student_id and email = auth.email()))
  with check (exists (select 1 from public.students where id = exam_sessions.student_id and email = auth.email()));


-- ============================================================
-- A3. EXAM ANSWERS — students write answer text only, while the
-- session is open and time remains (plus submission_grace()).
-- ============================================================

create or replace function public.answer_context(p_session_id uuid, p_question_id uuid,
  out status text, out deadline timestamptz, out question_in_exam boolean)
language sql
stable
security definer
set search_path = public
as $$
  select es.status,
         es.started_at + make_interval(mins => e.duration_mins),
         exists (select 1 from public.questions q where q.id = p_question_id and q.exam_id = es.exam_id)
  from   public.exam_sessions es
  join   public.exams e on e.id = es.exam_id
  join   public.students s on s.id = es.student_id
  where  es.id = p_session_id and s.email = auth.email()   -- caller's own session only
$$;
revoke all on function public.answer_context(uuid, uuid) from public, anon;
grant execute on function public.answer_context(uuid, uuid) to authenticated;

create or replace function public.guard_exam_answer()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  c record;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'UPDATE' and (new.session_id <> old.session_id or new.question_id <> old.question_id) then
    raise exception 'An answer cannot be moved to another question or session.' using errcode = '42501';
  end if;

  select * into c from public.answer_context(new.session_id, new.question_id);
  if c.status is null then
    raise exception 'This is not your exam session.' using errcode = '42501';
  end if;
  if c.status <> 'in_progress' then
    raise exception 'This exam session is closed; answers can no longer be changed.' using errcode = '42501';
  end if;
  if now() > c.deadline + public.submission_grace() then
    raise exception 'Time is up; answers can no longer be changed.' using errcode = '42501';
  end if;
  if not c.question_in_exam then
    raise exception 'That question is not part of this exam.' using errcode = '42501';
  end if;

  -- Grading fields are written only by grading functions.
  new.is_correct    := null;
  new.marks_awarded := null;
  if tg_op = 'INSERT' then new.answered_at := now(); end if;
  return new;
end;
$$;

drop trigger if exists exam_answers_guard on public.exam_answers;
create trigger exam_answers_guard
  before insert or update on public.exam_answers
  for each row execute procedure public.guard_exam_answer();

drop policy if exists "Students manage own answers" on public.exam_answers;
drop policy if exists "Students view own answers"   on public.exam_answers;
drop policy if exists "Students save own answers"   on public.exam_answers;
drop policy if exists "Students update own answers" on public.exam_answers;

create policy "Students view own answers"
  on public.exam_answers for select
  using (exists (select 1 from public.exam_sessions es join public.students s on s.id = es.student_id
                 where es.id = exam_answers.session_id and s.email = auth.email()));

create policy "Students save own answers"
  on public.exam_answers for insert
  with check (exists (select 1 from public.exam_sessions es join public.students s on s.id = es.student_id
                      where es.id = exam_answers.session_id and s.email = auth.email()));

create policy "Students update own answers"
  on public.exam_answers for update
  using      (exists (select 1 from public.exam_sessions es join public.students s on s.id = es.student_id
                      where es.id = exam_answers.session_id and s.email = auth.email()))
  with check (exists (select 1 from public.exam_sessions es join public.students s on s.id = es.student_id
                      where es.id = exam_answers.session_id and s.email = auth.email()));


-- ============================================================
-- A4. GRADING + AUTOMATIC SUBMISSION
-- ============================================================

-- Internal grading (body of the original auto_grade_session). A result
-- already marked fully_graded by faculty keeps that status.
create or replace function public.grade_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exam_id     uuid;
  v_student_id  uuid;
  v_total_marks integer;
  v_score       integer := 0;
begin
  select exam_id, student_id into v_exam_id, v_student_id
  from   public.exam_sessions where id = p_session_id;
  if not found then return; end if;

  select total_marks into v_total_marks from public.exams where id = v_exam_id;

  update public.exam_answers ea
  set    is_correct    = (ea.answer_text = q.correct_answer),
         marks_awarded = case when ea.answer_text = q.correct_answer then q.marks else 0 end,
         updated_at    = now()
  from   public.questions q
  where  ea.question_id = q.id
    and  ea.session_id  = p_session_id
    and  q.question_type = 'mcq';

  select coalesce(sum(marks_awarded), 0) into v_score
  from   public.exam_answers
  where  session_id = p_session_id and is_correct is not null;

  insert into public.exam_results as er
    (session_id, exam_id, student_id, total_marks, marks_obtained, grading_status)
  values
    (p_session_id, v_exam_id, v_student_id, v_total_marks, v_score, 'auto_graded')
  on conflict (session_id) do update
    set marks_obtained = excluded.marks_obtained,
        grading_status = case when er.grading_status = 'fully_graded' then 'fully_graded'
                              else excluded.grading_status end,
        updated_at     = now();
end;
$$;
revoke all on function public.grade_session(uuid) from public, anon, authenticated;

-- Client RPC (kept for compatibility with ExamRoom): the session's own
-- student or the exam owner, and only once the session is closed.
create or replace function public.auto_grade_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v record;
begin
  select es.exam_id, es.status, s.email
  into   v
  from   public.exam_sessions es join public.students s on s.id = es.student_id
  where  es.id = p_session_id;
  if not found then
    raise exception 'exam session not found' using errcode = 'P0002';
  end if;
  if auth.uid() is not null and v.email is distinct from auth.email() and not public.owns_exam(v.exam_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v.status = 'in_progress' then
    raise exception 'session is still in progress' using errcode = '42501';
  end if;
  perform public.grade_session(p_session_id);
end;
$$;
revoke all on function public.auto_grade_session(uuid) from public, anon;
grant execute on function public.auto_grade_session(uuid) to authenticated;

create or replace function public.grade_on_close()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status = 'in_progress' and new.status <> 'in_progress' then
    perform public.grade_session(new.id);
  end if;
  return null;
end;
$$;

drop trigger if exists exam_sessions_grade_on_close on public.exam_sessions;
create trigger exam_sessions_grade_on_close
  after update of status on public.exam_sessions
  for each row execute procedure public.grade_on_close();

-- Sessions whose time ran out but whose browser never submitted (closed
-- tab, crash, lost network) are closed as timed_out at their deadline.
-- Called from the faculty pages (own exam) or by the service role / a
-- scheduled job (all exams):
--   select cron.schedule('finalize-exams', '* * * * *',
--                        $$ select public.finalize_expired_sessions() $$);
create or replace function public.finalize_expired_sessions(p_exam_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if auth.uid() is not null and (p_exam_id is null or not public.owns_exam(p_exam_id)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  update public.exam_sessions es
  set    status       = 'timed_out',
         submitted_at = es.started_at + make_interval(mins => e.duration_mins)
  from   public.exams e
  where  e.id = es.exam_id
    and  es.status = 'in_progress'
    and  now() > es.started_at + make_interval(mins => e.duration_mins) + public.submission_grace()
    and  (p_exam_id is null or es.exam_id = p_exam_id);
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.finalize_expired_sessions(uuid) from public, anon;
grant execute on function public.finalize_expired_sessions(uuid) to authenticated;


-- ============================================================
-- A5. update_descriptive_marks — exam owner only
-- (p_grader_id is kept for signature compatibility; signed-in callers
-- are always recorded as themselves.)
-- ============================================================

create or replace function public.update_descriptive_marks(
  p_answer_id uuid,
  p_marks     integer,
  p_grader_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v          record;
  v_total    integer;
begin
  select ea.session_id, es.exam_id, es.status, q.question_type, q.marks
  into   v
  from   public.exam_answers ea
  join   public.exam_sessions es on es.id = ea.session_id
  join   public.questions q      on q.id  = ea.question_id
  where  ea.id = p_answer_id;
  if not found then
    raise exception 'answer not found' using errcode = 'P0002';
  end if;
  if auth.uid() is not null and not public.owns_exam(v.exam_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v.question_type <> 'descriptive' then
    raise exception 'only descriptive answers are graded manually' using errcode = '22023';
  end if;
  if v.status = 'in_progress' then
    raise exception 'the exam session is still in progress' using errcode = '42501';
  end if;
  if p_marks is null or p_marks < 0 or p_marks > v.marks then
    raise exception 'marks must be between 0 and %', v.marks using errcode = '22023';
  end if;

  update public.exam_answers
  set    marks_awarded = p_marks, is_correct = (p_marks > 0), updated_at = now()
  where  id = p_answer_id;

  select coalesce(sum(marks_awarded), 0) into v_total
  from   public.exam_answers where session_id = v.session_id and marks_awarded is not null;

  perform public.grade_session(v.session_id) where not exists
    (select 1 from public.exam_results where session_id = v.session_id);

  update public.exam_results
  set    marks_obtained = v_total,
         grading_status = case when exists (select 1 from public.exam_answers
                                            where session_id = v.session_id and marks_awarded is null)
                               then 'auto_graded' else 'fully_graded' end,
         graded_by  = coalesce(auth.uid(), p_grader_id),
         graded_at  = now(),
         updated_at = now()
  where  session_id = v.session_id;
end;
$$;
revoke all on function public.update_descriptive_marks(uuid, integer, uuid) from public, anon;
grant execute on function public.update_descriptive_marks(uuid, integer, uuid) to authenticated;


-- ============================================================
-- A6. QUESTIONS — students never receive correct_answer
-- ============================================================

drop policy if exists "Students view questions for assigned exams" on public.questions;

create or replace function public.get_exam_questions(p_exam_id uuid)
returns table (id uuid, question_text text, question_type text, options jsonb, marks integer, order_index integer)
language sql
stable
security definer
set search_path = public
as $$
  select q.id, q.question_text, q.question_type, q.options, q.marks, q.order_index
  from   public.questions q
  where  q.exam_id = p_exam_id
    and  public.is_assigned_to_exam(p_exam_id)
    and  (
           -- the student's own open session
           exists (select 1 from public.exam_sessions es join public.students s on s.id = es.student_id
                   where es.exam_id = p_exam_id and es.status = 'in_progress' and s.email = auth.email())
           -- or, for scheduled exams, only inside the window
        or not exists (select 1 from public.exam_window(p_exam_id) w where w.starts_at is not null)
        or exists (select 1 from public.exam_window(p_exam_id) w where now() between w.starts_at and w.ends_at)
         )
  order  by q.order_index
$$;
revoke all on function public.get_exam_questions(uuid) from public, anon;
grant execute on function public.get_exam_questions(uuid) to authenticated;


-- ============================================================
-- A7. PROFILES — role cannot be changed by its owner
-- ============================================================

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
  on public.profiles for update
  using      (auth.uid() = id)
  with check (auth.uid() = id and role = public.profile_role(auth.uid()));


-- ============================================================
-- A8. PHASE 6 BASE FIXES — audit log, system metrics, feedback
-- ============================================================

-- Audit rows written by clients are stamped with the real caller.
create or replace function public.stamp_audit_log()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.actor_id    := auth.uid();
    new.actor_role  := public.profile_role(auth.uid());
    new.occurred_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists audit_log_stamp on public.audit_log;
create trigger audit_log_stamp
  before insert on public.audit_log
  for each row execute procedure public.stamp_audit_log();

drop policy if exists "Authenticated users insert audit events" on public.audit_log;
drop policy if exists "Users append own audit events"           on public.audit_log;
create policy "Users append own audit events"
  on public.audit_log for insert
  with check (auth.uid() is not null and actor_id = auth.uid());

-- log_audit_event() takes the actor as a parameter: internal only.
revoke all on function public.log_audit_event(uuid, text, text, text, uuid, jsonb) from public, anon, authenticated;

-- system_metrics: read-only for faculty; written only by refresh_system_metrics().
drop policy if exists "Backend manage system metrics" on public.system_metrics;
revoke all on function public.refresh_system_metrics(uuid) from public, anon, authenticated;

create or replace function public.refresh_exam_metrics(p_exam_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not public.owns_exam(p_exam_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform public.refresh_system_metrics(p_exam_id);
end;
$$;
revoke all on function public.refresh_exam_metrics(uuid) from public, anon;
grant execute on function public.refresh_exam_metrics(uuid) to authenticated;

-- feedback: only for the student's own, closed session of that exam.
create or replace function public.is_own_closed_session(p_session uuid, p_exam uuid, p_student uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.exam_sessions es join public.students s on s.id = es.student_id
    where es.id = p_session and es.exam_id = p_exam and es.student_id = p_student
      and es.status <> 'in_progress' and s.email = auth.email())
$$;
revoke all on function public.is_own_closed_session(uuid, uuid, uuid) from public, anon;
grant execute on function public.is_own_closed_session(uuid, uuid, uuid) to authenticated;

drop policy if exists "Students submit own feedback" on public.feedback;
create policy "Students submit own feedback"
  on public.feedback for insert
  with check (public.is_own_closed_session(session_id, exam_id, student_id));


-- ============================================================
-- B. RESEARCH EVALUATION STORAGE
--
-- Provenance (data_kind) is recorded on every ground-truth row and
-- metrics are never pooled across kinds:
--   live       a real exam session, annotated afterwards from an
--              independent record (e.g. a consented external recording)
--   scripted   a consenting participant performed a written script of
--              behaviours at recorded times — real detector output,
--              staged conditions
--   simulated  events were injected/synthetic, not produced by the
--              detectors — exercises the pipeline only, measures nothing
--              about detection accuracy
-- ============================================================

create or replace function public.evaluation_categories()
returns text[] language sql immutable as
$$ select array['face_absence', 'multiple_people', 'object', 'speech', 'noise', 'tab_switch'] $$;

-- B1. evaluation_trials ---------------------------------------
create table if not exists public.evaluation_trials (
  id                   uuid        primary key default gen_random_uuid(),
  exam_session_id      uuid        not null unique references public.exam_sessions(id) on delete cascade,
  exam_id              uuid        not null references public.exams(id) on delete cascade,
  data_kind            text        not null check (data_kind in ('live', 'scripted', 'simulated')),
  -- Categories whose ground truth was annotated COMPLETELY for this
  -- session. Recall is computed only for these; an unannotated category
  -- is "unknown", not "nothing happened".
  annotated_categories text[]      not null default '{}'
                         check (annotated_categories <@ public.evaluation_categories()),
  annotation_method    text,
  notes                text,
  created_by           uuid        references public.profiles(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists evaluation_trials_exam_idx on public.evaluation_trials (exam_id);

drop trigger if exists evaluation_trials_updated_at on public.evaluation_trials;
create trigger evaluation_trials_updated_at
  before update on public.evaluation_trials
  for each row execute procedure public.set_updated_at();

create or replace function public.stamp_evaluation_trial()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select exam_id into new.exam_id from public.exam_sessions where id = new.exam_session_id;
  if tg_op = 'INSERT' then new.created_by := coalesce(auth.uid(), new.created_by); end if;
  return new;
end;
$$;

drop trigger if exists evaluation_trials_stamp on public.evaluation_trials;
create trigger evaluation_trials_stamp
  before insert or update on public.evaluation_trials
  for each row execute procedure public.stamp_evaluation_trial();

-- B2. ground_truth_intervals ----------------------------------
create table if not exists public.ground_truth_intervals (
  id         uuid        primary key default gen_random_uuid(),
  trial_id   uuid        not null references public.evaluation_trials(id) on delete cascade,
  category   text        not null check (category = any (public.evaluation_categories())),
  starts_at  timestamptz not null,
  ends_at    timestamptz,                  -- null = instantaneous
  label      text,                         -- e.g. object class ('cell phone', 'book')
  notes      text,
  created_by uuid        references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint ground_truth_intervals_order check (ends_at is null or ends_at >= starts_at)
);
create index if not exists ground_truth_intervals_trial_idx on public.ground_truth_intervals (trial_id, category);

create or replace function public.stamp_ground_truth()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('authenticated', 'anon') then new.created_by := auth.uid(); end if;
  return new;
end;
$$;

drop trigger if exists ground_truth_intervals_stamp on public.ground_truth_intervals;
create trigger ground_truth_intervals_stamp
  before insert on public.ground_truth_intervals
  for each row execute procedure public.stamp_ground_truth();

create or replace function public.owns_trial(p_trial_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.evaluation_trials t join public.exams e on e.id = t.exam_id
                 where t.id = p_trial_id and e.faculty_id = auth.uid())
$$;
revoke all on function public.owns_trial(uuid) from public, anon;
grant execute on function public.owns_trial(uuid) to authenticated;

-- B3. identity_ground_truth -----------------------------------
create table if not exists public.identity_ground_truth (
  verification_id uuid        primary key references public.identity_verifications(id) on delete cascade,
  exam_id         uuid        not null references public.exams(id) on delete cascade,
  is_genuine      boolean     not null,   -- true: the enrolled student; false: impostor attempt
  data_kind       text        not null check (data_kind in ('live', 'scripted', 'simulated')),
  notes           text,
  labelled_by     uuid        references public.profiles(id) on delete set null,
  labelled_at     timestamptz not null default now()
);
create index if not exists identity_ground_truth_exam_idx on public.identity_ground_truth (exam_id);

create or replace function public.stamp_identity_ground_truth()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select exam_id into new.exam_id from public.identity_verifications where id = new.verification_id;
  new.labelled_by := coalesce(auth.uid(), new.labelled_by);
  new.labelled_at := now();
  return new;
end;
$$;

drop trigger if exists identity_ground_truth_stamp on public.identity_ground_truth;
create trigger identity_ground_truth_stamp
  before insert or update on public.identity_ground_truth
  for each row execute procedure public.stamp_identity_ground_truth();

-- B4. monitoring_performance ----------------------------------
-- Summaries of per-frame/per-window processing time, measured with
-- performance.now() in the student's browser and written by the
-- student's own client during the exam (so: device-dependent and
-- self-reported).
create table if not exists public.monitoring_performance (
  id                uuid         primary key default gen_random_uuid(),
  exam_session_id   uuid         not null references public.exam_sessions(id) on delete cascade,
  exam_id           uuid         not null references public.exams(id) on delete cascade,
  module            text         not null check (module in ('face', 'objects', 'audio')),
  samples           integer      not null check (samples > 0 and samples <= 100000),
  mean_ms           numeric(10,2) not null check (mean_ms >= 0),
  p50_ms            numeric(10,2) not null check (p50_ms >= 0),
  p95_ms            numeric(10,2) not null check (p95_ms >= 0),
  max_ms            numeric(10,2) not null check (max_ms >= 0),
  window_started_at timestamptz  not null,
  window_ended_at   timestamptz  not null,
  device            jsonb        check (device is null or pg_column_size(device) <= 2048),
  created_at        timestamptz  not null default now()
);
create index if not exists monitoring_performance_exam_idx on public.monitoring_performance (exam_id, module);

create or replace function public.stamp_monitoring_performance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select exam_id into new.exam_id from public.exam_sessions where id = new.exam_session_id;
  new.created_at := now();
  return new;
end;
$$;

drop trigger if exists monitoring_performance_stamp on public.monitoring_performance;
create trigger monitoring_performance_stamp
  before insert on public.monitoring_performance
  for each row execute procedure public.stamp_monitoring_performance();

-- B5. model_evaluations ---------------------------------------
create table if not exists public.model_evaluations (
  id          uuid        primary key default gen_random_uuid(),
  exam_id     uuid        references public.exams(id) on delete cascade,  -- null = across the faculty's exams
  created_by  uuid        not null default auth.uid() references public.profiles(id) on delete cascade,
  card        jsonb       not null check (card ? 'cross_validation' and card ? 'labelled_sessions'
                                          and pg_column_size(card) <= 262144),
  source      text        not null default 'backend/ml/train_risk_model.py',
  imported_at timestamptz not null default now()
);
create index if not exists model_evaluations_creator_idx on public.model_evaluations (created_by);

-- B6. scores without faculty review input ---------------------
-- Same body as compute_risk_breakdown() in phase5_patch_monitoring_review.sql,
-- with one change: when p_ignore_reviews is true, events a faculty member
-- dismissed are scored like any other event.
create or replace function public.compute_risk_breakdown_ex(
  p_exam_session_id uuid,
  p_now             timestamptz,
  p_ignore_reviews  boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_es          record;
  v_ps_id       uuid;
  v_cfg         jsonb;
  v_end         timestamptz;
  v_window      numeric;
  v_min_conf    numeric;
  v_max_ep      numeric;
  v_type_map    jsonb := '{}'::jsonb;   -- event_type → {cat, factor}
  v_cats        jsonb := '{}'::jsonb;
  v_events      jsonb := '[]'::jsonb;
  v_type_counts jsonb := '{}'::jsonb;
  v_severity    jsonb := '{}'::jsonb;
  c             record;
  t             record;
  r             record;
  v_cat         text;
  v_factor      numeric;
  v_conf        numeric;
  v_dur         numeric;
  v_spu         numeric;
  v_points      numeric;
  v_status      text;
  v_key         text;
  v_last_key    text;
  v_last_end    timestamptz;
  v_open        integer := 0;
  v_total       integer := 0;
  v_wsum        numeric := 0;
  v_score       numeric := 0;
  v_norm        numeric;
  v_level       text;
  v_review      numeric;
  v_high        numeric;
  v_id          record;
  v_id_flag     boolean := false;
  v_id_reasons  text[] := '{}';
  v_reasons     text[] := '{}';
begin
  select es.id, es.exam_id, es.student_id, es.status, es.started_at, es.submitted_at
  into   v_es
  from   public.exam_sessions es
  where  es.id = p_exam_session_id;
  if not found then return null; end if;

  select id into v_ps_id from public.proctoring_sessions where exam_session_id = v_es.id;

  v_cfg      := public.effective_risk_config(v_es.exam_id);
  v_window   := (v_cfg ->> 'dedupe_window_s')::numeric;
  v_min_conf := (v_cfg ->> 'min_confidence')::numeric;
  v_max_ep   := (v_cfg ->> 'max_episode_s')::numeric;
  v_review   := (v_cfg ->> 'review_threshold')::numeric;
  v_high     := (v_cfg ->> 'high_threshold')::numeric;
  -- Open episodes stop growing when the exam is submitted.
  v_end      := least(p_now, coalesce(v_es.submitted_at, p_now));

  for c in select key, value from jsonb_each(v_cfg -> 'categories') loop
    v_cats := v_cats || jsonb_build_object(c.key, jsonb_build_object(
      'label', c.value -> 'label', 'weight', (c.value ->> 'weight')::numeric,
      'saturation', (c.value ->> 'saturation')::numeric,
      'seconds_per_unit', (c.value ->> 'seconds_per_unit')::numeric,
      'events', 0, 'counted', 0, 'duplicates', 0, 'dismissed', 0, 'below_confidence', 0,
      'duration_s', 0, 'effective', 0));
    for t in select key, value from jsonb_each(c.value -> 'types') loop
      v_type_map := v_type_map || jsonb_build_object(t.key,
        jsonb_build_object('cat', c.key, 'factor', (t.value #>> '{}')::numeric));
    end loop;
  end loop;

  for r in
    select pe.id, pe.event_type, pe.severity, pe.occurred_at, pe.ended_at, pe.confidence,
           pe.metadata, pe.snapshot_id, fr.decision,
           coalesce(pe.metadata ->> 'class_name', '') as sub_key
    from   public.proctoring_events pe
    left   join public.faculty_reviews fr on fr.proctoring_event_id = pe.id
    where  pe.proctoring_session_id = v_ps_id
    order  by pe.event_type, sub_key, pe.occurred_at, pe.id
  loop
    v_total := v_total + 1;
    v_type_counts := jsonb_set(v_type_counts, array[r.event_type],
      to_jsonb(coalesce((v_type_counts ->> r.event_type)::int, 0) + 1));
    v_severity := jsonb_set(v_severity, array[r.severity],
      to_jsonb(coalesce((v_severity ->> r.severity)::int, 0) + 1));

    v_cat    := v_type_map -> r.event_type ->> 'cat';
    v_factor := coalesce((v_type_map -> r.event_type ->> 'factor')::numeric, 0);
    v_conf   := coalesce(r.confidence, 1);
    v_spu    := coalesce((v_cats -> v_cat ->> 'seconds_per_unit')::numeric, 0);

    -- Duration: closed episodes use ended_at; open ones run to now/submission.
    if r.ended_at is not null then
      v_dur := greatest(0, extract(epoch from (r.ended_at - r.occurred_at)));
    elsif public.is_episodic_event(r.event_type) then
      v_dur  := greatest(0, extract(epoch from (v_end - r.occurred_at)));
      v_open := v_open + 1;
    else
      v_dur := null;
    end if;
    -- (LEAST ignores NULL, so guard it: instant events have no duration.)
    if v_dur is not null then v_dur := least(v_dur, v_max_ep); end if;

    v_key := r.event_type || ':' || r.sub_key;
    v_points := 0;
    if v_cat is null then
      v_status := 'not_scored';
    elsif r.decision = 'dismissed' and not p_ignore_reviews then
      v_status := 'dismissed';
    elsif r.confidence is not null and r.confidence < v_min_conf then
      v_status := 'below_confidence';
    elsif v_key = v_last_key
          and r.occurred_at <= v_last_end + make_interval(secs => v_window) then
      v_status := 'duplicate';
      v_points := v_factor * v_conf * (case when v_spu > 0 then coalesce(v_dur, 0) / v_spu else 0 end);
      v_last_end := greatest(v_last_end, r.occurred_at + make_interval(secs => coalesce(v_dur, 0)));
    else
      v_status := 'counted';
      v_points := v_factor * v_conf * (1 + case when v_spu > 0 then coalesce(v_dur, 0) / v_spu else 0 end);
      v_last_key := v_key;
      v_last_end := r.occurred_at + make_interval(secs => coalesce(v_dur, 0));
    end if;

    if v_cat is not null then
      v_cats := jsonb_set(v_cats, array[v_cat], (v_cats -> v_cat) || jsonb_build_object(
        'events',     (v_cats -> v_cat ->> 'events')::int + 1,
        'counted',    (v_cats -> v_cat ->> 'counted')::int    + (v_status = 'counted')::int,
        'duplicates', (v_cats -> v_cat ->> 'duplicates')::int + (v_status = 'duplicate')::int,
        'dismissed',  (v_cats -> v_cat ->> 'dismissed')::int  + (v_status = 'dismissed')::int,
        'below_confidence', (v_cats -> v_cat ->> 'below_confidence')::int + (v_status = 'below_confidence')::int,
        'duration_s', (v_cats -> v_cat ->> 'duration_s')::numeric
                        + case when v_status in ('counted', 'duplicate') then coalesce(v_dur, 0) else 0 end,
        'effective',  (v_cats -> v_cat ->> 'effective')::numeric + v_points));
    end if;

    if jsonb_array_length(v_events) < 500 then
      v_events := v_events || jsonb_build_object(
        'id', r.id, 'type', r.event_type, 'category', v_cat, 'severity', r.severity,
        'occurred_at', r.occurred_at, 'ended_at', r.ended_at,
        'duration_s', round(v_dur, 1), 'confidence', r.confidence,
        'status', v_status, 'points', round(v_points, 3),
        'snapshot_id', r.snapshot_id, 'decision', r.decision);
    end if;
  end loop;

  -- Normalise and weight.
  for c in select key, value from jsonb_each(v_cats) loop
    v_norm := least(1, (c.value ->> 'effective')::numeric / (c.value ->> 'saturation')::numeric);
    v_wsum := v_wsum + (c.value ->> 'weight')::numeric;
    v_score := v_score + (c.value ->> 'weight')::numeric * v_norm;
    v_cats := jsonb_set(v_cats, array[c.key], c.value || jsonb_build_object(
      'effective',  round((c.value ->> 'effective')::numeric, 3),
      'duration_s', round((c.value ->> 'duration_s')::numeric, 1),
      'normalised', round(v_norm, 4)));
  end loop;
  v_score := case when v_wsum > 0 then round(100 * v_score / v_wsum, 2) else 0 end;
  for c in select key, value from jsonb_each(v_cats) loop
    v_cats := jsonb_set(v_cats, array[c.key], c.value || jsonb_build_object(
      'contribution', case when v_wsum > 0
        then round(100 * (c.value ->> 'weight')::numeric * (c.value ->> 'normalised')::numeric / v_wsum, 2)
        else 0 end));
  end loop;

  -- Identity verification — reported separately, never added to the score.
  select count(*) filter (where result = 'failed')                  as failed,
         count(*) filter (where result = 'inconclusive')            as inconclusive,
         count(*) filter (where result = 'passed')                  as passed,
         bool_or(result = 'manual_review_requested')                as manual,
         bool_or(result in ('no_reference_face', 'no_reference_photo')) as no_reference,
         count(*)                                                   as attempts,
         (array_agg(result order by attempted_at desc))[1]          as last_result,
         min(distance) filter (where result = 'passed')             as best_distance
  into   v_id
  from   public.identity_verifications
  where  exam_id = v_es.exam_id and student_id = v_es.student_id;

  if coalesce(v_id.manual, false) then v_id_reasons := v_id_reasons || 'manual_review_requested'::text; end if;
  if coalesce(v_id.no_reference, false) then v_id_reasons := v_id_reasons || 'no_reference'::text; end if;
  if v_id.failed + v_id.inconclusive >= (v_cfg #>> '{identity,failed_attempts_for_review}')::numeric then
    v_id_reasons := v_id_reasons || 'repeated_failures'::text;
  end if;
  if v_id.attempts > 0 and v_id.passed = 0 then v_id_reasons := v_id_reasons || 'never_passed'::text; end if;
  v_id_flag := cardinality(v_id_reasons) > 0;

  v_level := case
    when v_score >= v_high           then 'critical'
    when v_score >= v_review         then 'high'
    when v_score >= v_review / 2     then 'medium'
    else 'low'
  end;
  if v_score >= v_review then v_reasons := v_reasons || 'risk_score'::text; end if;
  if v_id_flag then v_reasons := v_reasons || 'identity'::text; end if;

  return jsonb_build_object(
    'score',            v_score,
    'level',            v_level,
    'needs_review',     cardinality(v_reasons) > 0,
    'review_reasons',   to_jsonb(v_reasons),
    'review_threshold', v_review,
    'high_threshold',   v_high,
    'total_events',     v_total,
    'open_episodes',    v_open,
    'type_counts',      v_type_counts,
    'severity_counts',  v_severity,
    'categories',       v_cats,
    'events',           v_events,
    'identity', jsonb_build_object(
      'attempts',       v_id.attempts,
      'passed',         v_id.passed,
      'failed',         v_id.failed,
      'inconclusive',   v_id.inconclusive,
      'manual_review_requested', coalesce(v_id.manual, false),
      'last_result',    v_id.last_result,
      'best_distance',  v_id.best_distance,
      'flag',           v_id_flag,
      'reasons',        to_jsonb(v_id_reasons)),
    'config',           v_cfg,
    'computed_at',      p_now,
    'ignores_reviews',  p_ignore_reviews
  );
end;
$$;


-- The live score keeps its Phase 5 behaviour (dismissed events excluded).
create or replace function public.compute_risk_breakdown(
  p_exam_session_id uuid,
  p_now             timestamptz default now()
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$ select public.compute_risk_breakdown_ex(p_exam_session_id, p_now, false) $$;

revoke all on function public.compute_risk_breakdown_ex(uuid, timestamptz, boolean) from public, anon, authenticated;
revoke all on function public.compute_risk_breakdown(uuid, timestamptz)              from public, anon, authenticated;

-- Per closed session: live score, score recomputed WITHOUT faculty
-- dismissals, and the faculty outcome (the label). Exam owner or
-- service role only.
create or replace function public.risk_evaluation_data(p_exam_id uuid)
returns table (
  exam_session_id           uuid,
  status                    text,
  live_score                numeric,
  score_without_reviews     numeric,
  review_threshold          numeric,
  outcome                   text,
  decided_at                timestamptz,
  breakdown_without_reviews jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not public.owns_exam(p_exam_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    select es.id, es.status, rs.score,
           (b.b ->> 'score')::numeric, (b.b ->> 'review_threshold')::numeric,
           sr.outcome, sr.decided_at, b.b - 'events'
    from   public.exam_sessions es
    cross  join lateral (select public.compute_risk_breakdown_ex(
                           es.id, coalesce(es.submitted_at, now()), true) as b) b
    left   join public.risk_scores     rs on rs.exam_session_id = es.id
    left   join public.session_reviews sr on sr.exam_session_id = es.id
    where  es.exam_id = p_exam_id and es.status <> 'in_progress'
    order  by es.started_at;
end;
$$;
revoke all on function public.risk_evaluation_data(uuid) from public, anon;
grant execute on function public.risk_evaluation_data(uuid) to authenticated;


-- ============================================================
-- B7. RLS — research tables (exam owner only; no student access)
-- ============================================================

alter table public.evaluation_trials      enable row level security;
alter table public.ground_truth_intervals enable row level security;
alter table public.identity_ground_truth  enable row level security;
alter table public.monitoring_performance enable row level security;
alter table public.model_evaluations      enable row level security;

drop policy if exists "Faculty manage trials for own exams"       on public.evaluation_trials;
drop policy if exists "Faculty manage ground truth for own exams" on public.ground_truth_intervals;
drop policy if exists "Faculty label identity attempts"           on public.identity_ground_truth;
drop policy if exists "Students report own performance"           on public.monitoring_performance;
drop policy if exists "Faculty view performance for own exams"    on public.monitoring_performance;
drop policy if exists "Faculty import model evaluations"          on public.model_evaluations;
drop policy if exists "Faculty view own model evaluations"        on public.model_evaluations;
drop policy if exists "Faculty delete own model evaluations"      on public.model_evaluations;

create policy "Faculty manage trials for own exams"
  on public.evaluation_trials for all
  using      (public.owns_exam(exam_id))
  with check (public.owns_exam(exam_id));   -- exam_id is stamped from the session by trigger

create policy "Faculty manage ground truth for own exams"
  on public.ground_truth_intervals for all
  using      (public.owns_trial(trial_id))
  with check (public.owns_trial(trial_id));

create policy "Faculty label identity attempts"
  on public.identity_ground_truth for all
  using      (public.owns_exam(exam_id))
  with check (public.owns_exam(exam_id));

create policy "Students report own performance"
  on public.monitoring_performance for insert
  with check (public.is_own_active_exam_session(exam_session_id));

create policy "Faculty view performance for own exams"
  on public.monitoring_performance for select
  using (public.owns_exam(exam_id));

create policy "Faculty import model evaluations"
  on public.model_evaluations for insert
  with check (created_by = auth.uid()
              and public.profile_role(auth.uid()) = 'faculty'
              and (exam_id is null or public.owns_exam(exam_id)));

create policy "Faculty view own model evaluations"
  on public.model_evaluations for select
  using (created_by = auth.uid() or (exam_id is not null and public.owns_exam(exam_id)));

create policy "Faculty delete own model evaluations"
  on public.model_evaluations for delete
  using (created_by = auth.uid());


-- ============================================================
-- C. NO ANONYMOUS ACCESS TO SECURITY-DEFINER FUNCTIONS
-- Supabase grants EXECUTE on new public functions to `anon` by default.
-- None of the security-definer functions is meant for signed-out users.
-- ============================================================

do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
    from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where  n.nspname = 'public' and p.prosecdef and p.prorettype <> 'trigger'::regtype
  loop
    execute format('revoke execute on function %s from public, anon', f);
  end loop;
end;
$$;
