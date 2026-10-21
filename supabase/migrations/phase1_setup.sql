-- ============================================================
-- phase1_setup.sql
-- ProctorAI — Phase 1: Auth Foundation
--
-- Covers:
--   • public.profiles table (extends auth.users)
--   • handle_new_user() trigger function
--   • set_updated_at() utility trigger function
--   • on_auth_user_created trigger
--   • RLS policies for public.profiles
--
-- Safety:
--   Phase 1 has already been partially applied to the live
--   database. Every statement here is written to be fully
--   idempotent — safe to run against a database that already
--   has some or all of these objects.
--
--   Techniques used:
--     CREATE TABLE IF NOT EXISTS
--     CREATE INDEX IF NOT EXISTS
--     CREATE OR REPLACE FUNCTION
--     DROP TRIGGER IF EXISTS  +  CREATE TRIGGER
--     DROP POLICY  IF EXISTS  +  CREATE POLICY
--     ALTER TABLE … ENABLE ROW LEVEL SECURITY  (idempotent)
--     DO $$ … IF NOT EXISTS … ALTER TABLE ADD COLUMN  $$
--
-- Depends on: nothing (this is the base phase)
-- Required before: all other phases
-- ============================================================


-- ============================================================
-- 1. PROFILES TABLE
-- ============================================================

create table if not exists public.profiles (
  id         uuid        primary key references auth.users(id) on delete cascade,
  username   text        unique not null,
  email      text        not null,
  role       text        not null default 'student'
               check (role in ('student', 'faculty')),
  created_at timestamptz not null default now()
);

-- Email index — used by RLS policies in later phases that call auth.email().
-- Also speeds up username-based login lookup in the frontend.
create index if not exists profiles_email_idx    on public.profiles (email);
create index if not exists profiles_username_idx on public.profiles (username);


-- ============================================================
-- 2. TRIGGER FUNCTIONS
-- ============================================================

-- ----------------------------------------------------------
-- handle_new_user
-- Fires after every INSERT on auth.users and creates the
-- matching profile row.
--
-- SECURITY: role is hardcoded to 'student'. Trusting
-- raw_user_meta_data->>'role' from the client would allow
-- any user to self-promote to faculty at signup.
-- Faculty promotion must be done via a privileged SQL UPDATE
-- (see README — Manual Operations).
-- ----------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username, email, role)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data->>'username'), ''),
      split_part(new.email, '@', 1)
    ),
    new.email,
    'student'   -- never trust client-supplied role metadata
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ----------------------------------------------------------
-- set_updated_at
-- Generic BEFORE UPDATE trigger that stamps updated_at = now().
-- Shared by all tables that carry an updated_at column.
-- Defined here in Phase 1 so every later phase can attach it
-- without redefining the function.
-- ----------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- ============================================================
-- 3. ROW LEVEL SECURITY — PROFILES
-- ============================================================

alter table public.profiles enable row level security;

-- Drop old policies by their original names (from schema.sql)
-- and the corrected names (from 006_rls_policies.sql) so this
-- file is safe regardless of which prior migration was applied.
drop policy if exists "Users can view own profile"        on public.profiles;
drop policy if exists "Users can update own profile"      on public.profiles;
drop policy if exists "Faculty can view student profiles" on public.profiles;
drop policy if exists "Faculty can view all profiles"     on public.profiles;

-- Every authenticated user can read their own profile row.
create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

-- Users may update their own row but cannot change their role.
-- auth.jwt() ->> 'role' reads the role embedded in the current
-- JWT — no subquery against profiles, so no recursive RLS loop.
create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (
    auth.uid() = id
    and role = coalesce(auth.jwt() ->> 'role', 'student')
  );

-- Faculty can read all profiles (needed for student-lookup UI).
-- FIX: original policy queried public.profiles from inside a
-- profiles policy → infinite recursion. Now reads from JWT.
create policy "Faculty can view all profiles"
  on public.profiles for select
  using (
    coalesce(auth.jwt() ->> 'role', '') = 'faculty'
  );
