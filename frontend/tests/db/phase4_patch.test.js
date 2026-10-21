// Applies the real Supabase migrations to an in-process Postgres (PGlite)
// with minimal stand-ins for Supabase's `auth` and `storage` schemas, then
// checks the Phase 4 monitoring rules by acting as different users.

import { describe, it, expect, beforeAll } from 'vitest'
import { createDb, runAs } from './supabase'

const ID = {
  faculty: '00000000-0000-0000-0000-0000000000f1',
  other:   '00000000-0000-0000-0000-0000000000f2',
  alice:   '00000000-0000-0000-0000-0000000000a1',
  bob:     '00000000-0000-0000-0000-0000000000b1',
}

let db

/** Run SQL as a fixture user (or as the superuser when who is null). */
function as(who, sql, params = []) {
  const claims = who && { sub: ID[who], email: `${who}@uni.test`, role: who === 'faculty' || who === 'other' ? 'faculty' : 'student' }
  return runAs(db, claims, sql, params)
}

async function denied(promise) {
  await expect(promise).rejects.toThrow(/row-level security|violates/)
}

const fx = {}

beforeAll(async () => {
  db = await createDb([
    'phase1_setup.sql', 'phase2_faculty_management.sql', 'phase2_patch_rls_recursion.sql',
    'phase3_student_exam.sql', 'phase4_ai_monitoring.sql', 'phase4_patch_monitoring.sql',
    'phase5_review_risk_scoring.sql', 'phase6_research_evaluation.sql',
    'phase4_patch_monitoring.sql',          // re-run: must be idempotent
  ])

  // Fixture: faculty F owns exam E; students Alice and Bob each have a session.
  for (const who of Object.keys(ID)) {
    await db.query(`insert into auth.users (id, email) values ($1, $2)`, [ID[who], `${who}@uni.test`])
  }
  await db.query(`update public.profiles set role = 'faculty' where id in ($1, $2)`, [ID.faculty, ID.other])

  const exam = await db.query(
    `insert into public.exams (faculty_id, title, subject, exam_date, start_time, duration_mins)
     values ($1, 'Algebra', 'Math', current_date, '09:00', 60) returning id`, [ID.faculty])
  fx.exam = exam.rows[0].id

  for (const who of ['alice', 'bob']) {
    const s = await db.query(
      `insert into public.students (faculty_id, name, email, student_id) values ($1, $2, $3, $4) returning id`,
      [ID.faculty, who, `${who}@uni.test`, who.toUpperCase()])
    const a = await db.query(
      `insert into public.exam_assignments (exam_id, student_id) values ($1, $2) returning id`, [fx.exam, s.rows[0].id])
    const es = await db.query(
      `insert into public.exam_sessions (exam_id, student_id, assignment_id) values ($1, $2, $3) returning id`,
      [fx.exam, s.rows[0].id, a.rows[0].id])
    fx[who] = { student: s.rows[0].id, examSession: es.rows[0].id }
  }

  // Bob's proctoring session, created by the superuser (as a backend would).
  const ps = await db.query(`insert into public.proctoring_sessions (exam_session_id) values ($1) returning id`, [fx.bob.examSession])
  fx.bob.ps = ps.rows[0].id
})

describe('phase4_patch_monitoring.sql', () => {
  it('lets a student create a proctoring session only for their own exam session', async () => {
    const r = await as('alice',
      `insert into public.proctoring_sessions (id, exam_session_id, webcam_enabled)
       values (gen_random_uuid(), $1, true) returning id`, [fx.alice.examSession])
    fx.alice.ps = r.rows[0].id
    await denied(as('alice', `insert into public.proctoring_sessions (exam_session_id) values ($1)`, [fx.bob.examSession]))
  })

  it('stamps student_id and exam_id from the session, ignoring client values', async () => {
    await as('alice',
      `insert into public.proctoring_events (id, proctoring_session_id, event_type, severity, confidence, student_id, exam_id)
       values ('10000000-0000-0000-0000-000000000001', $1, 'speech_detected', 'medium', 0.8, $2, null)`,
      [fx.alice.ps, fx.bob.student])
    const { rows } = await as(null, `select student_id, exam_id, event_type, severity, confidence::float from public.proctoring_events where id = '10000000-0000-0000-0000-000000000001'`)
    expect(rows[0]).toEqual({ student_id: fx.alice.student, exam_id: fx.exam, event_type: 'speech_detected', severity: 'medium', confidence: 0.8 })
  })

  it('accepts every new event type and rejects unknown ones', async () => {
    for (const t of ['speech_detected', 'unusual_noise', 'camera_interrupted', 'mic_interrupted', 'focus_lost', 'tab_switch', 'phone_detected']) {
      await as('alice', `insert into public.proctoring_events (proctoring_session_id, event_type) values ($1, $2)`, [fx.alice.ps, t])
    }
    await expect(as('alice', `insert into public.proctoring_events (proctoring_session_id, event_type) values ($1, 'bogus')`, [fx.alice.ps]))
      .rejects.toThrow(/check constraint/)
  })

  it("blocks writing events into another student's session", async () => {
    await denied(as('alice', `insert into public.proctoring_events (proctoring_session_id, event_type) values ($1, 'tab_switch')`, [fx.bob.ps]))
  })

  it('does not let students read, edit or delete events', async () => {
    expect((await as('alice', `select * from public.proctoring_events`)).rows).toEqual([])
    const upd = await as('alice', `update public.proctoring_events set severity = 'low'`)
    expect(upd.affectedRows).toBe(0)
    const del = await as('alice', `delete from public.proctoring_events`)
    expect(del.affectedRows).toBe(0)
  })

  it('no longer lets any authenticated user see every proctoring session', async () => {
    const { rows } = await as('alice', `select exam_session_id from public.proctoring_sessions`)
    expect(rows.map(r => r.exam_session_id)).toEqual([fx.alice.examSession])
  })

  it('closes an episode once, only for its owner, with a duration', async () => {
    const id = '10000000-0000-0000-0000-000000000002'
    await as(null, `insert into public.proctoring_events (id, proctoring_session_id, event_type, occurred_at)
                    values ($1, $2, 'face_not_detected', now() - interval '12 seconds')`, [id, fx.alice.ps])

    await as('bob', `select public.close_proctoring_event($1, now())`, [id])
    let { rows } = await as(null, `select ended_at, duration_ms from public.proctoring_events where id = $1`, [id])
    expect(rows[0].ended_at).toBeNull()

    await as('alice', `select public.close_proctoring_event($1, now())`, [id])
    ;({ rows } = await as(null, `select ended_at, duration_ms from public.proctoring_events where id = $1`, [id]))
    expect(rows[0].duration_ms).toBeGreaterThanOrEqual(11_000)
    expect(rows[0].duration_ms).toBeLessThan(20_000)

    const first = rows[0].ended_at
    await as('alice', `select public.close_proctoring_event($1, now() + interval '1 hour')`, [id])
    ;({ rows } = await as(null, `select ended_at from public.proctoring_events where id = $1`, [id]))
    expect(rows[0].ended_at).toEqual(first)
  })

  it('links snapshots only under the matching session folder', async () => {
    await as('alice', `insert into public.proctoring_snapshots (proctoring_session_id, storage_path) values ($1, $2)`,
      [fx.alice.ps, `${fx.alice.examSession}/evt.jpg`])
    await denied(as('alice', `insert into public.proctoring_snapshots (proctoring_session_id, storage_path) values ($1, $2)`,
      [fx.alice.ps, `${fx.bob.examSession}/evt.jpg`]))
  })

  it('evidence storage: student upload-only to own folder; faculty of the exam can read', async () => {
    await as('alice', `insert into storage.objects (bucket_id, name) values ('proctoring-frames', $1)`, [`${fx.alice.examSession}/e1.jpg`])
    await denied(as('alice', `insert into storage.objects (bucket_id, name) values ('proctoring-frames', $1)`, [`${fx.bob.examSession}/e1.jpg`]))
    await expect(as('alice', `insert into storage.objects (bucket_id, name) values ('proctoring-frames', 'not-a-uuid/e1.jpg')`)).rejects.toThrow()

    expect((await as('alice', `select name from storage.objects where bucket_id = 'proctoring-frames'`)).rows).toEqual([])
    expect((await as('faculty', `select name from storage.objects where bucket_id = 'proctoring-frames'`)).rows)
      .toEqual([{ name: `${fx.alice.examSession}/e1.jpg` }])
    expect((await as('other', `select name from storage.objects where bucket_id = 'proctoring-frames'`)).rows).toEqual([])
  })

  it('faculty see events for their own exams only', async () => {
    const mine  = await as('faculty', `select count(*)::int as n from public.proctoring_events`)
    const other = await as('other',   `select count(*)::int as n from public.proctoring_events`)
    expect(mine.rows[0].n).toBeGreaterThan(0)
    expect(other.rows[0].n).toBe(0)
  })

  it('locks the bucket to private JPEGs ≤ 2 MB', async () => {
    const { rows } = await as(null, `select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'proctoring-frames'`)
    expect(rows[0]).toEqual({ public: false, file_size_limit: 2097152, allowed_mime_types: ['image/jpeg'] })
  })

  it('stops accepting events once the exam session is submitted', async () => {
    await as(null, `update public.exam_sessions set status = 'submitted' where id = $1`, [fx.alice.examSession])
    await denied(as('alice', `insert into public.proctoring_events (proctoring_session_id, event_type) values ($1, 'tab_switch')`, [fx.alice.ps]))
    // …but can still mark the proctoring session ended.
    const r = await as('alice', `update public.proctoring_sessions set stream_status = 'ended' where id = $1`, [fx.alice.ps])
    expect(r.affectedRows).toBe(1)
  })

  it('risk scoring (phase 5) still works with the new event types', async () => {
    await as(null, `select public.update_risk_score($1)`, [fx.alice.examSession])
    const { rows } = await as(null, `select total_events from public.risk_scores where exam_session_id = $1`, [fx.alice.examSession])
    expect(rows[0].total_events).toBeGreaterThan(5)
  })
})
