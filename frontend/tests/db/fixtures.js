// Shared fixture: one faculty member with one exam, two students (Alice,
// Bob) each with an in-progress exam session and proctoring session, plus
// a second faculty member who owns nothing.

import { createDb, runAs } from './supabase'

export const ALL_MIGRATIONS = [
  'phase1_setup.sql', 'phase2_faculty_management.sql', 'phase2_patch_rls_recursion.sql',
  'phase3_student_exam.sql', 'phase4_ai_monitoring.sql', 'phase4_patch_monitoring.sql',
  'phase5_review_risk_scoring.sql', 'phase5_patch_monitoring_review.sql',
  'phase6_research_evaluation.sql', 'phase6_patch_integrity_evaluation.sql',
]

export const ID = {
  faculty: '00000000-0000-0000-0000-0000000000f1',
  other:   '00000000-0000-0000-0000-0000000000f2',
  alice:   '00000000-0000-0000-0000-0000000000a1',
  bob:     '00000000-0000-0000-0000-0000000000b1',
}

export const T0 = '2026-01-01T10:00:00Z'

export async function createFixture(migrations = ALL_MIGRATIONS) {
  const db = await createDb(migrations)
  const fx = { db }

  fx.as = (who, sql, params = []) => {
    const claims = who && { sub: ID[who], email: `${who}@uni.test` }
    return runAs(db, claims, sql, params)
  }

  for (const who of Object.keys(ID)) {
    await db.query('insert into auth.users (id, email) values ($1, $2)', [ID[who], `${who}@uni.test`])
  }
  await db.query(`update public.profiles set role = 'faculty' where id in ($1, $2)`, [ID.faculty, ID.other])

  fx.exam = (await db.query(
    `insert into public.exams (faculty_id, title, subject, exam_date, start_time, duration_mins)
     values ($1, 'Algebra', 'Math', current_date, '09:00', 60) returning id`, [ID.faculty])).rows[0].id

  for (const who of ['alice', 'bob']) {
    const student = (await db.query(
      `insert into public.students (faculty_id, name, email, student_id) values ($1, $2, $3, $4) returning id`,
      [ID.faculty, who[0].toUpperCase() + who.slice(1), `${who}@uni.test`, who.toUpperCase()])).rows[0].id
    const assignment = (await db.query(
      'insert into public.exam_assignments (exam_id, student_id) values ($1, $2) returning id', [fx.exam, student])).rows[0].id
    const examSession = (await db.query(
      `insert into public.exam_sessions (exam_id, student_id, assignment_id, started_at)
       values ($1, $2, $3, $4) returning id`, [fx.exam, student, assignment, T0])).rows[0].id
    const ps = (await db.query(
      'insert into public.proctoring_sessions (exam_session_id) values ($1) returning id', [examSession])).rows[0].id
    fx[who] = { student, assignment, examSession, ps }
  }

  /** Insert an event for a student, `at` seconds after T0, lasting `dur` seconds (null = open/instant). */
  fx.event = async (who, type, { at = 0, dur = null, confidence = null, metadata = null, severity = 'medium' } = {}) => {
    const occurred = new Date(Date.parse(T0) + at * 1000).toISOString()
    const ended = dur === null ? null : new Date(Date.parse(T0) + (at + dur) * 1000).toISOString()
    const { rows } = await db.query(
      `insert into public.proctoring_events
         (proctoring_session_id, event_type, severity, confidence, metadata, occurred_at, ended_at)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [fx[who].ps, type, severity, confidence, metadata, occurred, ended])
    return rows[0].id
  }

  /** Risk breakdown for a student evaluated `nowSec` seconds after T0. */
  fx.breakdown = async (who, nowSec = 3600) => {
    const now = new Date(Date.parse(T0) + nowSec * 1000).toISOString()
    const { rows } = await db.query('select public.compute_risk_breakdown($1, $2) as b', [fx[who].examSession, now])
    return rows[0].b
  }

  fx.clearEvents = async who => {
    await db.query('delete from public.proctoring_events where proctoring_session_id = $1', [fx[who].ps])
    await db.query('delete from public.identity_verifications where student_id = $1', [fx[who].student])
    await db.query('delete from public.exam_risk_settings')
  }

  return fx
}
