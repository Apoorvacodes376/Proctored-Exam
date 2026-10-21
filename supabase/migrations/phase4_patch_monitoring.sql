-- ============================================================
-- phase4_patch_monitoring.sql
-- ProctorAI — Phase 4 patch: browser monitoring modules
--
-- Run AFTER phase4_ai_monitoring.sql (and before or after phase 5/6 —
-- it only touches Phase 4 objects). Idempotent; nothing is dropped
-- except policies/constraints that are recreated here.
--
-- Covers:
--   1. proctoring_events: student_id, exam_id, ended_at, duration_ms
--      (student/exam filled server-side from the session — not trusted
--      from the client)
--   2. New event types for the browser monitors
--   3. close_proctoring_event() — records when an alert episode ended
--      (face back, camera restored, student returned to tab) without
--      logging a second event
--   4. RLS tightened: students may only create/append to THEIR OWN
--      in-progress session; they cannot read, edit or delete events or
--      evidence. Replaces the "any authenticated user" policies.
--   5. Evidence storage: path <exam_session_id>/<event_id>.jpg, students
--      upload-only for their own session, faculty read/delete for their
--      own exams, JPEG only, 2 MB cap.
--
-- Depends on: phase3_student_exam.sql, phase4_ai_monitoring.sql
-- ============================================================


-- ============================================================
-- 1. EVENT COLUMNS
-- ============================================================

alter table public.proctoring_events
  add column if not exists student_id  uuid references public.students(id) on delete cascade,
  add column if not exists exam_id     uuid references public.exams(id)    on delete cascade,
  add column if not exists ended_at    timestamptz,
  add column if not exists duration_ms integer check (duration_ms >= 0);

create index if not exists proctoring_events_student_idx on public.proctoring_events (student_id);
create index if not exists proctoring_events_exam_idx    on public.proctoring_events (exam_id);

-- Back-fill rows written before this patch.
update public.proctoring_events pe
set    student_id = es.student_id,
       exam_id    = es.exam_id
from   public.proctoring_sessions ps
join   public.exam_sessions       es on es.id = ps.exam_session_id
where  ps.id = pe.proctoring_session_id
  and  (pe.student_id is null or pe.exam_id is null);


-- ============================================================
-- 2. EVENT TYPES
-- Existing types are kept so historical rows stay valid.
--   speech_detected     sustained speech-like audio
--   unusual_noise       loud non-speech sound (bang, ringtone, …)
--   camera_interrupted  camera stream missing / ended / muted / revoked
--   mic_interrupted     microphone stream missing / ended / muted / revoked
--   focus_lost          exam window lost focus while tab stayed visible
-- ============================================================

alter table public.proctoring_events
  drop constraint if exists proctoring_events_event_type_check;

alter table public.proctoring_events
  add constraint proctoring_events_event_type_check check (event_type in (
    'face_not_detected', 'multiple_faces', 'gaze_away',
    'tab_switch', 'fullscreen_exit', 'audio_detected',
    'phone_detected', 'object_detected', 'copy_paste',
    'idle_timeout',
    'speech_detected', 'unusual_noise',
    'camera_interrupted', 'mic_interrupted', 'focus_lost'
  ));


-- ============================================================
-- 3. TRIGGER: stamp student_id / exam_id from the session
-- ============================================================

create or replace function public.stamp_proctoring_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select es.student_id, es.exam_id
  into   new.student_id, new.exam_id
  from   public.proctoring_sessions ps
  join   public.exam_sessions       es on es.id = ps.exam_session_id
  where  ps.id = new.proctoring_session_id;
  return new;
end;
$$;

drop trigger if exists proctoring_events_stamp on public.proctoring_events;
create trigger proctoring_events_stamp
  before insert on public.proctoring_events
  for each row execute procedure public.stamp_proctoring_event();


-- ============================================================
-- 4. RPC: close an alert episode
-- Only the student who owns the event may close it, only once.
-- ============================================================

create or replace function public.close_proctoring_event(
  p_event_id uuid,
  p_ended_at timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.proctoring_events pe
  set    ended_at    = least(greatest(p_ended_at, pe.occurred_at), now()),
         duration_ms = (extract(epoch from
                          least(greatest(p_ended_at, pe.occurred_at), now()) - pe.occurred_at
                        ) * 1000)::integer
  where  pe.id = p_event_id
    and  pe.ended_at is null
    and  exists (
           select 1
           from   public.students s
           where  s.id    = pe.student_id
             and  s.email = auth.email()
         );
end;
$$;

revoke all on function public.close_proctoring_event(uuid, timestamptz) from public, anon;
grant execute on function public.close_proctoring_event(uuid, timestamptz) to authenticated;


-- ============================================================
-- 5. RLS — replace the "any authenticated user" policies
-- ============================================================

-- Helper: is this exam session the caller's own, in-progress session?
create or replace function public.is_own_active_exam_session(p_exam_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from   public.exam_sessions es
    join   public.students      s on s.id = es.student_id
    where  es.id     = p_exam_session_id
      and  es.status = 'in_progress'
      and  s.email   = auth.email()
  );
$$;

revoke all on function public.is_own_active_exam_session(uuid) from public, anon;
grant execute on function public.is_own_active_exam_session(uuid) to authenticated;

-- proctoring_sessions -------------------------------------------------
drop policy if exists "Backend manage proctoring sessions"        on public.proctoring_sessions;
drop policy if exists "Students create own proctoring session"    on public.proctoring_sessions;
drop policy if exists "Students update own proctoring session"    on public.proctoring_sessions;

create policy "Students create own proctoring session"
  on public.proctoring_sessions for insert
  with check (public.is_own_active_exam_session(exam_session_id));

-- Lets the client mark its own session ended / errored.
create policy "Students update own proctoring session"
  on public.proctoring_sessions for update
  using (
    exists (
      select 1
      from   public.exam_sessions es
      join   public.students      s on s.id = es.student_id
      where  es.id = proctoring_sessions.exam_session_id
        and  s.email = auth.email()
    )
  )
  with check (
    exists (
      select 1
      from   public.exam_sessions es
      join   public.students      s on s.id = es.student_id
      where  es.id = proctoring_sessions.exam_session_id
        and  s.email = auth.email()
    )
  );

-- proctoring_events ---------------------------------------------------
drop policy if exists "Backend insert proctoring events"      on public.proctoring_events;
drop policy if exists "Students insert own proctoring events" on public.proctoring_events;

create policy "Students insert own proctoring events"
  on public.proctoring_events for insert
  with check (
    exists (
      select 1
      from   public.proctoring_sessions ps
      where  ps.id = proctoring_events.proctoring_session_id
        and  public.is_own_active_exam_session(ps.exam_session_id)
    )
  );

-- proctoring_snapshots ------------------------------------------------
drop policy if exists "Backend insert proctoring snapshots"      on public.proctoring_snapshots;
drop policy if exists "Students insert own proctoring snapshots" on public.proctoring_snapshots;

create policy "Students insert own proctoring snapshots"
  on public.proctoring_snapshots for insert
  with check (
    exists (
      select 1
      from   public.proctoring_sessions ps
      where  ps.id = proctoring_snapshots.proctoring_session_id
        and  public.is_own_active_exam_session(ps.exam_session_id)
        and  split_part(proctoring_snapshots.storage_path, '/', 1) = ps.exam_session_id::text
    )
  );

-- Faculty SELECT policies from phase 4 are unchanged. The service-role
-- backend bypasses RLS and needs no policy.


-- ============================================================
-- 6. STORAGE — proctoring-frames (evidence)
-- Path: <exam_session_id>/<event_id>.jpg
-- ============================================================

update storage.buckets
set    public             = false,
       file_size_limit    = 2097152,
       allowed_mime_types = array['image/jpeg']
where  id = 'proctoring-frames';

drop policy if exists "Backend upload proctoring frames"        on storage.objects;
drop policy if exists "Faculty read proctoring frames"          on storage.objects;
drop policy if exists "Faculty delete proctoring frames"        on storage.objects;
drop policy if exists "Students upload own proctoring evidence" on storage.objects;
drop policy if exists "Faculty read proctoring evidence"        on storage.objects;
drop policy if exists "Faculty delete proctoring evidence"      on storage.objects;

-- Students: upload only, only into their own in-progress session folder.
-- No select/update/delete → evidence cannot be read back or replaced.
create policy "Students upload own proctoring evidence"
  on storage.objects for insert
  with check (
    bucket_id = 'proctoring-frames'
    and public.is_own_active_exam_session(
          nullif((storage.foldername(name))[1], '')::uuid
        )
  );

create policy "Faculty read proctoring evidence"
  on storage.objects for select
  using (
    bucket_id = 'proctoring-frames'
    and exists (
      select 1
      from   public.exam_sessions es
      join   public.exams         e on e.id = es.exam_id
      where  es.id::text   = (storage.foldername(name))[1]
        and  e.faculty_id  = auth.uid()
    )
  );

create policy "Faculty delete proctoring evidence"
  on storage.objects for delete
  using (
    bucket_id = 'proctoring-frames'
    and exists (
      select 1
      from   public.exam_sessions es
      join   public.exams         e on e.id = es.exam_id
      where  es.id::text   = (storage.foldername(name))[1]
        and  e.faculty_id  = auth.uid()
    )
  );
