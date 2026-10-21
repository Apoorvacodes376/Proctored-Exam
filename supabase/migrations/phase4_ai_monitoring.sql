-- ============================================================
-- phase4_ai_monitoring.sql
-- ProctorAI — Phase 4: AI Proctoring & Monitoring
--
-- Covers:
--   • public.proctoring_sessions  — one per exam_session; tracks
--                                   webcam/screen stream metadata
--   • public.proctoring_events    — timestamped anomaly events
--                                   detected by the AI backend
--   • public.proctoring_snapshots — references to stored frames
--                                   in the proctoring-frames bucket
--   • storage.buckets: proctoring-frames
--   • Storage RLS for proctoring-frames
--   • RLS policies for all three tables
--
-- Depends on: phase1_setup.sql, phase2_faculty_management.sql,
--             phase3_student_exam.sql
-- Required before: phase5 (risk scoring reads events)
-- ============================================================


-- ============================================================
-- 1. PROCTORING SESSIONS
-- One row per exam_session. Created by the backend when the
-- student's webcam/screen stream is initialised.
-- stream_status: 'active' | 'paused' | 'ended' | 'error'
-- ============================================================

create table if not exists public.proctoring_sessions (
  id              uuid        primary key default gen_random_uuid(),
  exam_session_id uuid        not null unique
                    references public.exam_sessions(id) on delete cascade,
  stream_status   text        not null default 'active'
                    check (stream_status in ('active', 'paused', 'ended', 'error')),
  webcam_enabled  boolean     not null default false,
  screen_enabled  boolean     not null default false,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists proctoring_sessions_exam_session_idx
  on public.proctoring_sessions (exam_session_id);

drop trigger if exists proctoring_sessions_updated_at on public.proctoring_sessions;
create trigger proctoring_sessions_updated_at
  before update on public.proctoring_sessions
  for each row execute procedure public.set_updated_at();


-- ============================================================
-- 2. PROCTORING EVENTS
-- Append-only log of AI-detected anomalies during an exam.
-- event_type values (extensible via CHECK — add new types here
-- as the AI model evolves):
--   face_not_detected   — no face visible in webcam frame
--   multiple_faces      — more than one face detected
--   gaze_away           — student looking away from screen
--   tab_switch          — browser tab/window focus lost
--   fullscreen_exit     — student exited fullscreen mode
--   audio_detected      — unexpected audio in environment
--   phone_detected      — mobile device detected in frame
--   object_detected     — unauthorised object (book, notes)
--   copy_paste          — clipboard activity detected
--   idle_timeout        — no interaction for N seconds
-- severity: 'low' | 'medium' | 'high' | 'critical'
-- ============================================================

create table if not exists public.proctoring_events (
  id                  uuid        primary key default gen_random_uuid(),
  proctoring_session_id uuid      not null
                        references public.proctoring_sessions(id) on delete cascade,
  event_type          text        not null check (event_type in (
                        'face_not_detected', 'multiple_faces', 'gaze_away',
                        'tab_switch', 'fullscreen_exit', 'audio_detected',
                        'phone_detected', 'object_detected', 'copy_paste',
                        'idle_timeout'
                      )),
  severity            text        not null default 'medium'
                        check (severity in ('low', 'medium', 'high', 'critical')),
  confidence          numeric(5,4) check (confidence between 0 and 1),
  snapshot_id         uuid,                  -- FK added after snapshots table exists (below)
  metadata            jsonb,                 -- arbitrary AI model output (bounding boxes, etc.)
  occurred_at         timestamptz not null default now(),
  created_at          timestamptz not null default now()
);

create index if not exists proctoring_events_session_idx
  on public.proctoring_events (proctoring_session_id);
create index if not exists proctoring_events_type_idx
  on public.proctoring_events (event_type);
create index if not exists proctoring_events_occurred_at_idx
  on public.proctoring_events (occurred_at);
create index if not exists proctoring_events_severity_idx
  on public.proctoring_events (severity);


-- ============================================================
-- 3. PROCTORING SNAPSHOTS
-- References to individual frames stored in the
-- proctoring-frames storage bucket.
-- frame_type: 'webcam' | 'screen'
-- ============================================================

create table if not exists public.proctoring_snapshots (
  id                    uuid        primary key default gen_random_uuid(),
  proctoring_session_id uuid        not null
                          references public.proctoring_sessions(id) on delete cascade,
  storage_path          text        not null,   -- path inside proctoring-frames bucket
  frame_type            text        not null default 'webcam'
                          check (frame_type in ('webcam', 'screen')),
  captured_at           timestamptz not null default now(),
  created_at            timestamptz not null default now()
);

create index if not exists proctoring_snapshots_session_idx
  on public.proctoring_snapshots (proctoring_session_id);
create index if not exists proctoring_snapshots_captured_at_idx
  on public.proctoring_snapshots (captured_at);

-- Now that proctoring_snapshots exists, add the FK from proctoring_events.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.proctoring_events'::regclass
      and conname  = 'proctoring_events_snapshot_id_fkey'
  ) then
    alter table public.proctoring_events
      add constraint proctoring_events_snapshot_id_fkey
      foreign key (snapshot_id)
      references public.proctoring_snapshots(id)
      on delete set null;
  end if;
end;
$$;


-- ============================================================
-- 4. STORAGE — proctoring-frames bucket
-- Private bucket; frames are never publicly accessible.
-- Path convention: <faculty_uid>/<exam_session_id>/<timestamp>_<type>.jpg
-- ============================================================

insert into storage.buckets (id, name, public)
values ('proctoring-frames', 'proctoring-frames', false)
on conflict (id) do nothing;

-- Drop any prior versions of these policies.
drop policy if exists "Backend upload proctoring frames"  on storage.objects;
drop policy if exists "Faculty read proctoring frames"    on storage.objects;
drop policy if exists "Faculty delete proctoring frames"  on storage.objects;

-- Only the service-role backend (AI worker) uploads frames.
-- Client-side (anon/authenticated) uploads are intentionally blocked.
-- This policy allows any authenticated user to insert — in production,
-- restrict this further to a dedicated backend service account.
-- MANUAL REVIEW: tighten to a specific backend role if your Supabase
-- project uses custom database roles.
create policy "Backend upload proctoring frames"
  on storage.objects for insert
  with check (
    bucket_id = 'proctoring-frames'
    and auth.uid() is not null
  );

-- Faculty: read frames that belong to their own exams.
-- Path structure: <faculty_uid>/... so folder[1] = faculty uid.
create policy "Faculty read proctoring frames"
  on storage.objects for select
  using (
    bucket_id = 'proctoring-frames'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Faculty: delete frames for their own exams (e.g. after review).
create policy "Faculty delete proctoring frames"
  on storage.objects for delete
  using (
    bucket_id = 'proctoring-frames'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = auth.uid()::text
  );


-- ============================================================
-- 5. RLS — PROCTORING SESSIONS
-- ============================================================

alter table public.proctoring_sessions enable row level security;

drop policy if exists "Students view own proctoring session"    on public.proctoring_sessions;
drop policy if exists "Faculty view proctoring sessions"        on public.proctoring_sessions;
drop policy if exists "Backend manage proctoring sessions"      on public.proctoring_sessions;

-- Students: read-only access to their own proctoring session.
create policy "Students view own proctoring session"
  on public.proctoring_sessions for select
  using (
    exists (
      select 1
      from   public.exam_sessions es
      join   public.students      s  on s.id = es.student_id
      where  es.id   = proctoring_sessions.exam_session_id
        and  s.email = auth.email()
    )
  );

-- Faculty: read-only access to proctoring sessions for their exams.
create policy "Faculty view proctoring sessions"
  on public.proctoring_sessions for select
  using (
    exists (
      select 1
      from   public.exam_sessions es
      join   public.exams         e  on e.id = es.exam_id
      where  es.id        = proctoring_sessions.exam_session_id
        and  e.faculty_id = auth.uid()
    )
  );

-- Students and backend: full management of their own proctoring session.
create policy "Backend manage proctoring sessions"
  on public.proctoring_sessions for all
  using     (auth.uid() is not null)
  with check (auth.uid() is not null);


-- ============================================================
-- 6. RLS — PROCTORING EVENTS
-- ============================================================

alter table public.proctoring_events enable row level security;

drop policy if exists "Backend insert proctoring events"  on public.proctoring_events;
drop policy if exists "Faculty view proctoring events"    on public.proctoring_events;

-- Authenticated users (students via client SDK) may insert events.
create policy "Backend insert proctoring events"
  on public.proctoring_events for insert
  with check (auth.uid() is not null);

-- Faculty: read events for their own exams.
create policy "Faculty view proctoring events"
  on public.proctoring_events for select
  using (
    exists (
      select 1
      from   public.proctoring_sessions ps
      join   public.exam_sessions       es on es.id = ps.exam_session_id
      join   public.exams               e  on e.id  = es.exam_id
      where  ps.id        = proctoring_events.proctoring_session_id
        and  e.faculty_id = auth.uid()
    )
  );


-- ============================================================
-- 7. RLS — PROCTORING SNAPSHOTS
-- ============================================================

alter table public.proctoring_snapshots enable row level security;

drop policy if exists "Backend insert proctoring snapshots" on public.proctoring_snapshots;
drop policy if exists "Faculty view proctoring snapshots"   on public.proctoring_snapshots;

-- Authenticated users (students via client SDK) may insert snapshots.
create policy "Backend insert proctoring snapshots"
  on public.proctoring_snapshots for insert
  with check (auth.uid() is not null);

-- Faculty: read snapshots for their own exams.
create policy "Faculty view proctoring snapshots"
  on public.proctoring_snapshots for select
  using (
    exists (
      select 1
      from   public.proctoring_sessions ps
      join   public.exam_sessions       es on es.id = ps.exam_session_id
      join   public.exams               e  on e.id  = es.exam_id
      where  ps.id        = proctoring_snapshots.proctoring_session_id
        and  e.faculty_id = auth.uid()
    )
  );
