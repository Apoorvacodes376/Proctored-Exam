-- ============================================================
-- phase5_patch_monitoring_review.sql
-- ProctorAI — Phase 5 patch: live monitoring, transparent risk
-- scoring, and faculty review workflow
--
-- Run AFTER phase5_review_risk_scoring.sql and
-- phase4_patch_monitoring.sql (uses is_own_active_exam_session()).
-- Idempotent. Independent of phase 6.
--
-- Covers:
--   1. Rule-based risk configuration (defaults + per-exam overrides)
--   2. identity_verifications — every verification attempt, kept
--      separate from behavioural events
--   3. Live status heartbeats on proctoring_sessions (report_live_status)
--   4. compute_risk_breakdown() / update_risk_score(): transparent,
--      normalised, de-duplicated score with a stored breakdown
--   5. Triggers that keep risk_scores current
--   6. faculty_reviews: exam-ownership enforced; session_reviews +
--      append-only history for decisions and explanations
--   7. RLS fixes (risk_scores was writable by any authenticated user)
--   8. Realtime (WebSocket) publication for the faculty dashboard
--
-- A risk score is an indicator for human review. Nothing here changes
-- an exam session's status, grade or eligibility automatically.
-- ============================================================


-- ============================================================
-- 1. RISK CONFIGURATION
-- ============================================================
--
-- score (0–100) = Σ weight_c × normalised_c  /  Σ weight_c × 100
-- normalised_c  = min(1, effective_c / saturation_c)
-- effective_c   = Σ over counted events of
--                   type_factor × confidence × (1 + duration_s / seconds_per_unit)
--                 + Σ over merged duplicates of
--                   type_factor × confidence × (duration_s / seconds_per_unit)
--
--   - confidence defaults to 1 when the detector provides none;
--     events below min_confidence are listed but not scored.
--   - an event of the same type (and object class) starting within
--     dedupe_window_s of the previous one is a duplicate: it adds its
--     duration but not another count.
--   - events a faculty member dismissed are listed but not scored.
--   - episode durations are capped at max_episode_s; seconds_per_unit = 0
--     means duration is ignored for that category.
--   - identity verification is NOT part of the score; it raises its own
--     review flag.

create or replace function public.default_risk_config()
returns jsonb
language sql
immutable
as $$
  select '{
    "version": 1,
    "review_threshold": 40,
    "high_threshold": 70,
    "dedupe_window_s": 30,
    "min_confidence": 0.3,
    "max_episode_s": 600,
    "categories": {
      "face_absence":    {"label": "Face not visible",           "weight": 20, "saturation": 4, "seconds_per_unit": 30, "types": {"face_not_detected": 1}},
      "multiple_people": {"label": "Multiple people",            "weight": 25, "saturation": 2, "seconds_per_unit": 30, "types": {"multiple_faces": 1}},
      "objects":         {"label": "Prohibited objects",         "weight": 25, "saturation": 2, "seconds_per_unit": 0,  "types": {"phone_detected": 1, "object_detected": 0.6}},
      "tab_switching":   {"label": "Leaving the exam",           "weight": 15, "saturation": 5, "seconds_per_unit": 30, "types": {"tab_switch": 1, "focus_lost": 0.5, "fullscreen_exit": 0.5}},
      "audio":           {"label": "Audio anomalies",            "weight": 10, "saturation": 4, "seconds_per_unit": 30, "types": {"speech_detected": 1, "audio_detected": 0.5, "unusual_noise": 0.3}},
      "media":           {"label": "Camera / mic interruptions", "weight": 5,  "saturation": 2, "seconds_per_unit": 60, "types": {"camera_interrupted": 1, "mic_interrupted": 0.5}}
    },
    "identity": {"failed_attempts_for_review": 2}
  }'::jsonb;
$$;

-- Recursive object merge: b overrides a, key by key.
create or replace function public.jsonb_merge_deep(a jsonb, b jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  k text;
  result jsonb;
begin
  if a is null then return b; end if;
  if b is null then return a; end if;
  if jsonb_typeof(a) <> 'object' or jsonb_typeof(b) <> 'object' then return b; end if;
  result := a;
  for k in select jsonb_object_keys(b) loop
    result := jsonb_set(result, array[k], public.jsonb_merge_deep(a -> k, b -> k), true);
  end loop;
  return result;
end;
$$;

-- Returns a list of problems; empty array = valid.
create or replace function public.risk_config_errors(cfg jsonb)
returns text[]
language plpgsql
immutable
as $$
declare
  errs text[] := '{}';
  c record;
  t record;
  num_ok constant text := 'number';
begin
  if cfg is null or jsonb_typeof(cfg) <> 'object' then return array['config must be an object']; end if;

  if jsonb_typeof(cfg -> 'review_threshold') <> num_ok
     or (cfg ->> 'review_threshold')::numeric not between 0 and 100 then
    errs := errs || 'review_threshold must be a number between 0 and 100';
  end if;
  if jsonb_typeof(cfg -> 'high_threshold') <> num_ok
     or (cfg ->> 'high_threshold')::numeric not between 0 and 100 then
    errs := errs || 'high_threshold must be a number between 0 and 100';
  elsif jsonb_typeof(cfg -> 'review_threshold') = num_ok
     and (cfg ->> 'high_threshold')::numeric < (cfg ->> 'review_threshold')::numeric then
    errs := errs || 'high_threshold must be at least review_threshold';
  end if;
  if jsonb_typeof(cfg -> 'dedupe_window_s') <> num_ok or (cfg ->> 'dedupe_window_s')::numeric not between 0 and 3600 then
    errs := errs || 'dedupe_window_s must be between 0 and 3600';
  end if;
  if jsonb_typeof(cfg -> 'min_confidence') <> num_ok or (cfg ->> 'min_confidence')::numeric not between 0 and 1 then
    errs := errs || 'min_confidence must be between 0 and 1';
  end if;
  if jsonb_typeof(cfg -> 'max_episode_s') <> num_ok or (cfg ->> 'max_episode_s')::numeric <= 0 then
    errs := errs || 'max_episode_s must be positive';
  end if;
  if jsonb_typeof(cfg #> '{identity,failed_attempts_for_review}') <> num_ok
     or (cfg #>> '{identity,failed_attempts_for_review}')::numeric < 1 then
    errs := errs || 'identity.failed_attempts_for_review must be at least 1';
  end if;

  if jsonb_typeof(cfg -> 'categories') <> 'object' then
    return errs || 'categories must be an object'::text;
  end if;
  for c in select key, value from jsonb_each(cfg -> 'categories') loop
    if jsonb_typeof(c.value -> 'weight') <> num_ok or (c.value ->> 'weight')::numeric < 0 then
      errs := errs || format('categories.%s.weight must be ≥ 0', c.key);
    end if;
    if jsonb_typeof(c.value -> 'saturation') <> num_ok or (c.value ->> 'saturation')::numeric <= 0 then
      errs := errs || format('categories.%s.saturation must be > 0', c.key);
    end if;
    if jsonb_typeof(c.value -> 'seconds_per_unit') <> num_ok or (c.value ->> 'seconds_per_unit')::numeric < 0 then
      errs := errs || format('categories.%s.seconds_per_unit must be ≥ 0', c.key);
    end if;
    if jsonb_typeof(c.value -> 'types') <> 'object' then
      errs := errs || format('categories.%s.types must be an object', c.key);
    else
      for t in select key, value from jsonb_each(c.value -> 'types') loop
        if jsonb_typeof(t.value) <> num_ok or (t.value #>> '{}')::numeric not between 0 and 1 then
          errs := errs || format('categories.%s.types.%s must be between 0 and 1', c.key, t.key);
        end if;
      end loop;
    end if;
  end loop;
  if not exists (
    select 1 from jsonb_each(cfg -> 'categories') x where (x.value ->> 'weight')::numeric > 0
  ) then
    errs := errs || 'at least one category needs a positive weight'::text;
  end if;
  return errs;
exception when others then
  return errs || ('invalid config: ' || sqlerrm);
end;
$$;

create table if not exists public.exam_risk_settings (
  exam_id     uuid        primary key references public.exams(id) on delete cascade,
  config      jsonb       not null default '{}'::jsonb,   -- overrides merged onto default_risk_config()
  updated_by  uuid        references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'exam_risk_settings_config_valid') then
    alter table public.exam_risk_settings
      add constraint exam_risk_settings_config_valid
      check (cardinality(public.risk_config_errors(
               public.jsonb_merge_deep(public.default_risk_config(), config))) = 0);
  end if;
end;
$$;

drop trigger if exists exam_risk_settings_updated_at on public.exam_risk_settings;
create trigger exam_risk_settings_updated_at
  before update on public.exam_risk_settings
  for each row execute procedure public.set_updated_at();

-- Internal: effective config (no ownership check — not granted to clients).
create or replace function public.effective_risk_config(p_exam_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.jsonb_merge_deep(
    public.default_risk_config(),
    coalesce((select config from public.exam_risk_settings where exam_id = p_exam_id), '{}'::jsonb)
  );
$$;

-- Client RPC: effective config for an exam the caller owns.
create or replace function public.get_risk_config(p_exam_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.exams where id = p_exam_id and faculty_id = auth.uid()) then
    raise exception 'not your exam' using errcode = '42501';
  end if;
  return public.effective_risk_config(p_exam_id);
end;
$$;


-- ============================================================
-- 2. IDENTITY VERIFICATION ATTEMPTS
-- Logged before the exam session exists, so keyed by exam + student.
-- ============================================================

create table if not exists public.identity_verifications (
  id           uuid         primary key default gen_random_uuid(),
  exam_id      uuid         not null references public.exams(id)    on delete cascade,
  student_id   uuid         not null references public.students(id) on delete cascade,
  result       text         not null check (result in (
                 'passed', 'failed', 'inconclusive',
                 'manual_review_requested', 'no_reference_face', 'no_reference_photo')),
  distance     numeric(6,4),          -- face-embedding distance (lower = more similar)
  threshold    numeric(6,4),          -- threshold in force for the attempt
  attempted_at timestamptz  not null default now()
);

create index if not exists identity_verifications_exam_student_idx
  on public.identity_verifications (exam_id, student_id);

create or replace function public.is_own_assignment(p_exam_id uuid, p_student_id uuid)
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
    where  ea.exam_id    = p_exam_id
      and  ea.student_id = p_student_id
      and  s.email       = auth.email()
  );
$$;

create or replace function public.owns_exam(p_exam_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.exams where id = p_exam_id and faculty_id = auth.uid());
$$;

-- Server sets the time; the client cannot backdate attempts.
create or replace function public.stamp_identity_verification()
returns trigger
language plpgsql
as $$
begin
  new.attempted_at := now();
  return new;
end;
$$;

drop trigger if exists identity_verifications_stamp on public.identity_verifications;
create trigger identity_verifications_stamp
  before insert on public.identity_verifications
  for each row execute procedure public.stamp_identity_verification();

alter table public.identity_verifications enable row level security;

drop policy if exists "Students log own verification attempts"    on public.identity_verifications;
drop policy if exists "Faculty view verification attempts"        on public.identity_verifications;

create policy "Students log own verification attempts"
  on public.identity_verifications for insert
  with check (public.is_own_assignment(exam_id, student_id));

create policy "Faculty view verification attempts"
  on public.identity_verifications for select
  using (public.owns_exam(exam_id));


-- ============================================================
-- 3. LIVE STATUS (heartbeats)
-- ============================================================

alter table public.proctoring_sessions
  add column if not exists exam_id           uuid references public.exams(id) on delete cascade,
  add column if not exists live_status       jsonb,
  add column if not exists last_heartbeat_at timestamptz;

update public.proctoring_sessions ps
set    exam_id = es.exam_id
from   public.exam_sessions es
where  es.id = ps.exam_session_id and ps.exam_id is null;

create index if not exists proctoring_sessions_exam_idx on public.proctoring_sessions (exam_id);

create or replace function public.stamp_proctoring_session()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select exam_id into new.exam_id from public.exam_sessions where id = new.exam_session_id;
  return new;
end;
$$;

drop trigger if exists proctoring_sessions_stamp on public.proctoring_sessions;
create trigger proctoring_sessions_stamp
  before insert on public.proctoring_sessions
  for each row execute procedure public.stamp_proctoring_session();

-- Student heartbeat. Only whitelisted, scalar fields are stored; the
-- timestamp is the server's. Values are self-reported by the browser.
create or replace function public.report_live_status(p_exam_session_id uuid, p_status jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clean jsonb;
begin
  if not public.is_own_active_exam_session(p_exam_session_id) then
    raise exception 'not your active exam session' using errcode = '42501';
  end if;
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
  into   v_clean
  from   jsonb_each(coalesce(p_status, '{}'::jsonb))
  where  key in ('camera', 'microphone', 'face', 'objects', 'audio', 'away', 'logging')
    and  jsonb_typeof(value) in ('string', 'boolean', 'number')
    and  length(value::text) <= 40;

  update public.proctoring_sessions
  set    live_status       = v_clean,
         last_heartbeat_at = now()
  where  exam_session_id   = p_exam_session_id;
end;
$$;


-- ============================================================
-- 4. RISK COMPUTATION
-- ============================================================

alter table public.risk_scores
  add column if not exists exam_id        uuid references public.exams(id) on delete cascade,
  add column if not exists score          numeric(5,2) check (score between 0 and 100),
  add column if not exists breakdown      jsonb,
  add column if not exists needs_review   boolean not null default false,
  add column if not exists identity_flag  boolean not null default false,
  add column if not exists review_reasons text[]  not null default '{}',
  add column if not exists open_episodes  integer not null default 0;

create index if not exists risk_scores_exam_idx on public.risk_scores (exam_id);

-- Event types that are logged once per episode and closed with ended_at.
create or replace function public.is_episodic_event(p_type text)
returns boolean
language sql
immutable
as $$
  select p_type = any (array[
    'face_not_detected', 'multiple_faces', 'tab_switch', 'focus_lost',
    'speech_detected', 'unusual_noise', 'camera_interrupted', 'mic_interrupted'
  ]);
$$;

create or replace function public.compute_risk_breakdown(
  p_exam_session_id uuid,
  p_now             timestamptz default now()
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
    elsif r.decision = 'dismissed' then
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
    'computed_at',      p_now
  );
end;
$$;

-- Same signature as phase 5; now stores the transparent breakdown.
create or replace function public.update_risk_score(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  b jsonb;
begin
  b := public.compute_risk_breakdown(p_session_id, now());
  if b is null then return; end if;

  insert into public.risk_scores as rs (
    exam_session_id, exam_id, overall_score, score, risk_level,
    face_score, behaviour_score, environment_score,
    total_events, critical_events, high_events,
    breakdown, needs_review, identity_flag, review_reasons, open_episodes, computed_at)
  select
    p_session_id, es.exam_id, (b ->> 'score')::numeric / 100, (b ->> 'score')::numeric, b ->> 'level',
    (b #>> '{categories,face_absence,normalised}')::numeric,
    (b #>> '{categories,tab_switching,normalised}')::numeric,
    greatest((b #>> '{categories,objects,normalised}')::numeric,
             (b #>> '{categories,multiple_people,normalised}')::numeric,
             (b #>> '{categories,audio,normalised}')::numeric),
    (b ->> 'total_events')::int,
    coalesce((b #>> '{severity_counts,critical}')::int, 0),
    coalesce((b #>> '{severity_counts,high}')::int, 0),
    b, (b ->> 'needs_review')::boolean, (b #>> '{identity,flag}')::boolean,
    array(select jsonb_array_elements_text(b -> 'review_reasons')),
    (b ->> 'open_episodes')::int, now()
  from public.exam_sessions es where es.id = p_session_id
  on conflict (exam_session_id) do update set
    exam_id           = excluded.exam_id,
    overall_score     = excluded.overall_score,
    score             = excluded.score,
    risk_level        = excluded.risk_level,
    face_score        = excluded.face_score,
    behaviour_score   = excluded.behaviour_score,
    environment_score = excluded.environment_score,
    total_events      = excluded.total_events,
    critical_events   = excluded.critical_events,
    high_events       = excluded.high_events,
    breakdown         = excluded.breakdown,
    needs_review      = excluded.needs_review,
    identity_flag     = excluded.identity_flag,
    review_reasons    = excluded.review_reasons,
    open_episodes     = excluded.open_episodes,
    computed_at       = excluded.computed_at,
    updated_at        = now();
end;
$$;

-- Internal functions: not callable by clients (compute exposes any session).
revoke all on function public.compute_risk_breakdown(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.update_risk_score(uuid)                    from public, anon, authenticated;
revoke all on function public.effective_risk_config(uuid)                from public, anon, authenticated;
grant execute on function public.get_risk_config(uuid)                   to authenticated;
grant execute on function public.report_live_status(uuid, jsonb)         to authenticated;
grant execute on function public.default_risk_config()                   to authenticated;
grant execute on function public.risk_config_errors(jsonb)               to authenticated;


-- ============================================================
-- 5. TRIGGERS THAT KEEP risk_scores CURRENT
-- ============================================================

create or replace function public.risk_on_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.update_risk_score(ps.exam_session_id)
  from public.proctoring_sessions ps where ps.id = new.proctoring_session_id;
  return null;
end;
$$;

drop trigger if exists proctoring_events_risk on public.proctoring_events;
create trigger proctoring_events_risk
  after insert or update on public.proctoring_events
  for each row execute procedure public.risk_on_event();

create or replace function public.risk_on_review()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.update_risk_score(ps.exam_session_id)
  from public.proctoring_events pe
  join public.proctoring_sessions ps on ps.id = pe.proctoring_session_id
  where pe.id = case when tg_op = 'DELETE' then old.proctoring_event_id else new.proctoring_event_id end;
  return null;
end;
$$;

drop trigger if exists faculty_reviews_risk on public.faculty_reviews;
create trigger faculty_reviews_risk
  after insert or update or delete on public.faculty_reviews
  for each row execute procedure public.risk_on_review();

create or replace function public.risk_on_exam_session()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.update_risk_score(new.id);
  return null;
end;
$$;

drop trigger if exists exam_sessions_risk on public.exam_sessions;
create trigger exam_sessions_risk
  after insert or update of status, submitted_at on public.exam_sessions
  for each row execute procedure public.risk_on_exam_session();

create or replace function public.risk_on_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.update_risk_score(es.id)
  from public.exam_sessions es
  where es.exam_id = new.exam_id and es.student_id = new.student_id;
  return null;
end;
$$;

drop trigger if exists identity_verifications_risk on public.identity_verifications;
create trigger identity_verifications_risk
  after insert on public.identity_verifications
  for each row execute procedure public.risk_on_identity();

create or replace function public.risk_on_settings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.update_risk_score(es.id)
  from public.exam_sessions es
  where es.exam_id = case when tg_op = 'DELETE' then old.exam_id else new.exam_id end;
  return null;
end;
$$;

drop trigger if exists exam_risk_settings_risk on public.exam_risk_settings;
create trigger exam_risk_settings_risk
  after insert or update or delete on public.exam_risk_settings
  for each row execute procedure public.risk_on_settings();

-- Heartbeats refresh the score only while an episode is open, so the
-- duration of an ongoing absence/interruption is reflected live.
create or replace function public.risk_on_heartbeat()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.proctoring_events
    where  proctoring_session_id = new.id
      and  ended_at is null
      and  public.is_episodic_event(event_type)
  ) then
    perform public.update_risk_score(new.exam_session_id);
  end if;
  return null;
end;
$$;

drop trigger if exists proctoring_sessions_risk on public.proctoring_sessions;
create trigger proctoring_sessions_risk
  after update of last_heartbeat_at on public.proctoring_sessions
  for each row execute procedure public.risk_on_heartbeat();

-- Back-fill scores for existing sessions.
do $$
declare s record;
begin
  for s in select id from public.exam_sessions loop
    perform public.update_risk_score(s.id);
  end loop;
end;
$$;


-- ============================================================
-- 6. FACULTY REVIEW WORKFLOW
-- ============================================================

-- 6a. Per-event review (existing table). decision:
--   pending   — not yet reviewed
--   dismissed — false alarm / not a concern (excluded from the score)
--   confirmed — the detected behaviour did happen (not a misconduct finding)
--   escalated — needs further investigation
create or replace function public.is_event_owner(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from   public.proctoring_events  pe
    join   public.proctoring_sessions ps on ps.id = pe.proctoring_session_id
    join   public.exam_sessions      es on es.id = ps.exam_session_id
    join   public.exams              e  on e.id  = es.exam_id
    where  pe.id = p_event_id and e.faculty_id = auth.uid()
  );
$$;

create or replace function public.stamp_faculty_review()
returns trigger
language plpgsql
as $$
begin
  new.reviewed_by := auth.uid();
  new.reviewed_at := case when new.decision = 'pending' then null else now() end;
  return new;
end;
$$;

drop trigger if exists faculty_reviews_stamp on public.faculty_reviews;
create trigger faculty_reviews_stamp
  before insert or update on public.faculty_reviews
  for each row execute procedure public.stamp_faculty_review();

drop policy if exists "Faculty manage own reviews"         on public.faculty_reviews;
drop policy if exists "Faculty manage reviews for own exams" on public.faculty_reviews;

create policy "Faculty manage reviews for own exams"
  on public.faculty_reviews for all
  using      (public.is_event_owner(proctoring_event_id))
  with check (public.is_event_owner(proctoring_event_id) and reviewed_by = auth.uid());

-- 6b. Per-session decision: does this exam need further review before
-- evaluation? status:
--   not_reviewed   — default
--   in_review      — faculty has started reviewing
--   cleared        — may proceed to evaluation
--   further_review — hold: needs further review before evaluation
-- outcome (optional, faculty's own conclusion): no_misconduct |
--   misconduct | inconclusive. Never set automatically.
create table if not exists public.session_reviews (
  exam_session_id uuid        primary key references public.exam_sessions(id) on delete cascade,
  exam_id         uuid        not null references public.exams(id) on delete cascade,
  status          text        not null default 'not_reviewed'
                    check (status in ('not_reviewed', 'in_review', 'cleared', 'further_review')),
  outcome         text        check (outcome in ('no_misconduct', 'misconduct', 'inconclusive')),
  explanation     text,
  decided_by      uuid        references public.profiles(id) on delete set null,
  decided_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint session_reviews_decision_explained check (
    status in ('not_reviewed', 'in_review')
    or length(trim(coalesce(explanation, ''))) >= 10
  ),
  constraint session_reviews_outcome_explained check (
    outcome is null or length(trim(coalesce(explanation, ''))) >= 10
  )
);

create index if not exists session_reviews_exam_idx on public.session_reviews (exam_id);

create table if not exists public.session_review_history (
  id              uuid        primary key default gen_random_uuid(),
  exam_session_id uuid        not null references public.exam_sessions(id) on delete cascade,
  exam_id         uuid        not null references public.exams(id) on delete cascade,
  status          text        not null,
  outcome         text,
  explanation     text,
  decided_by      uuid        references public.profiles(id) on delete set null,
  score_at_decision numeric(5,2),
  decided_at      timestamptz not null default now()
);

create index if not exists session_review_history_session_idx
  on public.session_review_history (exam_session_id, decided_at);

create or replace function public.stamp_session_review()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select exam_id into new.exam_id from public.exam_sessions where id = new.exam_session_id;
  new.decided_by := auth.uid();
  new.decided_at := now();
  if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  return new;
end;
$$;

drop trigger if exists session_reviews_stamp on public.session_reviews;
create trigger session_reviews_stamp
  before insert or update on public.session_reviews
  for each row execute procedure public.stamp_session_review();

create or replace function public.log_session_review()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.session_review_history
    (exam_session_id, exam_id, status, outcome, explanation, decided_by, score_at_decision, decided_at)
  values
    (new.exam_session_id, new.exam_id, new.status, new.outcome, new.explanation, new.decided_by,
     (select score from public.risk_scores where exam_session_id = new.exam_session_id), new.decided_at);
  return null;
end;
$$;

drop trigger if exists session_reviews_history on public.session_reviews;
create trigger session_reviews_history
  after insert or update on public.session_reviews
  for each row execute procedure public.log_session_review();

alter table public.session_reviews        enable row level security;
alter table public.session_review_history enable row level security;
alter table public.exam_risk_settings     enable row level security;

drop policy if exists "Faculty manage session reviews"     on public.session_reviews;
drop policy if exists "Faculty view session review history" on public.session_review_history;
drop policy if exists "Faculty manage exam risk settings"  on public.exam_risk_settings;

create policy "Faculty manage session reviews"
  on public.session_reviews for all
  using      (public.owns_exam(exam_id))
  with check (public.owns_exam(exam_id)
              and exists (select 1 from public.exam_sessions es
                          where es.id = exam_session_id and es.exam_id = session_reviews.exam_id));

-- History is append-only (written by trigger); faculty can only read it.
create policy "Faculty view session review history"
  on public.session_review_history for select
  using (public.owns_exam(exam_id));

create policy "Faculty manage exam risk settings"
  on public.exam_risk_settings for all
  using      (public.owns_exam(exam_id))
  with check (public.owns_exam(exam_id));


-- ============================================================
-- 7. RLS FIX — risk_scores
-- Was writable by any authenticated user. Scores are now written only
-- by the security-definer functions above (and the service role).
-- ============================================================

drop policy if exists "Backend manage risk scores" on public.risk_scores;


-- ============================================================
-- 8. REALTIME (WebSocket) for the faculty dashboard
-- Supabase Realtime streams these tables' changes over a WebSocket and
-- delivers each change only to subscribers whose RLS allows the row.
-- ============================================================

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'publication supabase_realtime not found — skipping (not a Supabase database?)';
    return;
  end if;
  foreach t in array array[
    'exam_sessions', 'proctoring_sessions', 'proctoring_events', 'risk_scores',
    'identity_verifications', 'faculty_reviews', 'session_reviews'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;
