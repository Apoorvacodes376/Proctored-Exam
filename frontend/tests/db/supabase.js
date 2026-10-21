// In-process Postgres (PGlite) with minimal stand-ins for Supabase's
// `auth` and `storage` schemas, for running the real migrations in tests.

import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

export const MIGRATIONS = path.resolve(import.meta.dirname, '../../../supabase/migrations')
export const read = f => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')

export const SUPABASE_STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create publication supabase_realtime;
  -- Supabase grants EXECUTE on new public functions to the API roles by
  -- default, so a revoke "from public" alone does not lock a function down.
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  create schema auth;
  create schema storage;

  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');

  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
  create function auth.email() returns text language sql stable as
    $$ select auth.jwt() ->> 'email' $$;

  create table storage.buckets (
    id text primary key, name text, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets(id), name text, owner uuid
  );
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as
    $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
  create function storage.filename(name text) returns text language sql immutable as
    $$ select (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)] $$;
`

export const GRANTS = `
  grant usage on schema public, auth, storage to authenticated, anon;
  grant all on all tables in schema public, storage to authenticated, anon;
  grant execute on all functions in schema auth, storage to authenticated;
`

/** Fresh database with the given migration files applied, in order. */
export async function createDb(files) {
  const db = new PGlite()
  await db.exec(SUPABASE_STUBS)
  for (const f of files) {
    try { await db.exec(read(f)) } catch (e) { throw new Error(`${f}: ${e.message}`) }
  }
  await db.exec(GRANTS)
  return db
}

/** Run SQL as an authenticated user with the given JWT claims (or as superuser if claims is null). */
export async function runAs(db, claims, sql, params = []) {
  if (!claims) return db.query(sql, params)
  await db.exec(`set role authenticated; select set_config('request.jwt.claims', '${JSON.stringify(claims)}', false);`)
  try {
    return await db.query(sql, params)
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claims', '', false);`)
  }
}
